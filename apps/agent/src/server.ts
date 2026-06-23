// Entry point — Express server with JWT middleware
// CSRF: All state-changing routes require Authorization: Bearer, which browsers
// cannot send cross-origin without a CORS preflight — no additional CSRF token is needed.
import 'dotenv/config';
import { validateAgentEnv } from './lib/env.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { transcribeAudio } from './tools/sttTool.js';
import {
	buildGmailConnectUrl,
	completeGmailOAuthCallback,
	disconnectGmailConnection,
	getGmailConnection,
	getTenantForUser,
	GmailReconnectRequiredError,
} from './lib/gmailOAuth.js';
import { runDirectResolverChain } from './agent/directResolverChain.js';
import { createCalendarEvent, deleteCalendarEvent, listCalendarEvents } from './mcp/calendar.js';
import { getGmailInboxStats } from './mcp/gmail.js';
import { supabase } from './lib/supabase.js';
import { writeAuditLog } from './repository/auditLogs.js';
import { logger } from './lib/logger.js';

type AuthenticatedRequest = Request & { userAuthId?: string };

type TaskStatus = 'pending' | 'completed';

type TaskRow = {
	id: string;
	tenant_id: string;
	title: string;
	notes: string | null;
	due_at: string | null;
	status: TaskStatus;
	created_at: string;
	updated_at: string;
};

// --- Input validation constants ---
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 500;
const MAX_NOTES_LENGTH = 5_000;
const MAX_MESSAGE_LENGTH = 10_000;
const AUDIO_MAX_SIZE_BYTES = 25 * 1024 * 1024;
const ALLOWED_AUDIO_MIMES = new Set([
	'audio/webm',
	'audio/ogg',
	'audio/mp4',
	'audio/mpeg',
	'audio/wav',
	'audio/x-wav',
	'audio/flac',
	'audio/aac',
]);

// --- Helpers ---

function parseBearerToken(req: Request): string | null {
	const header = req.header('authorization') || req.header('Authorization');
	if (!header) return null;
	const [scheme, token] = header.split(' ');
	if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
	return token;
}

/** Log the raw error server-side and return only the safe fallback string to callers. */
function toSafeError(error: unknown, fallback: string): string {
	if (error instanceof Error) {
		logger.error({ err: error.message, stack: error.stack }, fallback);
	} else {
		logger.error({ err: String(error) }, fallback);
	}
	return fallback;
}

/** Return false and send 422 if value is not a valid UUID. */
function requireUuid(value: string, label: string, res: Response): boolean {
	if (!UUID_RE.test(value)) {
		res.status(422).json({ error: `${label} must be a valid UUID.` });
		return false;
	}
	return true;
}

async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
	const token = parseBearerToken(req);
	if (!token) {
		res.status(401).json({ error: 'Missing bearer token.' });
		return;
	}

	try {
		const authResponse = await supabase.auth.getUser(token);
		const userId = authResponse.data.user?.id;

		if (!userId) {
			res.status(401).json({ error: 'Invalid or expired token.' });
			return;
		}

		req.userAuthId = userId;
		next();
	} catch {
		// Do not leak Supabase error details to callers.
		res.status(401).json({ error: 'Invalid or expired token.' });
	}
}

function sanitizeReturnTo(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	if (trimmed.startsWith('/')) return trimmed;

	try {
		const parsed = new URL(trimmed);
		const allowedOrigins = (process.env.GMAIL_OAUTH_ALLOWED_REDIRECT_ORIGINS || '')
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean);

		if (allowedOrigins.includes(parsed.origin)) return trimmed;
		return undefined;
	} catch {
		return undefined;
	}
}

function redirectWithResult(returnTo: string | undefined, statusValue: 'success' | 'error', message?: string) {
	if (!returnTo) return null;

	const target = returnTo.startsWith('/')
		? new URL(returnTo, process.env.GMAIL_OAUTH_FALLBACK_BASE_URL || 'http://localhost:5174')
		: new URL(returnTo);

	target.searchParams.set('gmail_oauth', statusValue);
	if (message) target.searchParams.set('message', message);

	return target.toString();
}

// --- App setup ---

// Fail the boot with one aggregated error if required env vars are missing or
// malformed, rather than throwing lazily the first time STT or OAuth is used.
validateAgentEnv();

const allowedOrigins = (process.env.AGENT_CORS_ALLOW_ORIGINS || 'http://localhost:5174')
	.split(',')
	.map((o) => o.trim())
	.filter(Boolean);

const app = express();

app.use(helmet());

app.use(
	cors({
		origin: (origin, callback) => {
			if (!origin || allowedOrigins.includes(origin)) {
				callback(null, true);
			} else {
				callback(new Error('CORS origin not allowed.'));
			}
		},
		credentials: true,
	}),
);

app.use(express.json({ limit: '1mb' }));

const globalLimiter = rateLimit({
	windowMs: 60_000,
	max: 120,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: { error: 'Too many requests.' },
});
app.use(globalLimiter);

const agentLimiter = rateLimit({
	windowMs: 60_000,
	max: 20,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: { error: 'Too many requests.' },
});

const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: AUDIO_MAX_SIZE_BYTES, files: 1 },
	fileFilter: (_req, file, cb) => {
		if (ALLOWED_AUDIO_MIMES.has(file.mimetype)) {
			cb(null, true);
		} else {
			cb(new Error('Invalid file type. Only audio files are accepted.'));
		}
	},
});

// --- Routes ---

app.get('/healthz', (_req: Request, res: Response) => {
	res.json({ ok: true, service: 'agent' });
});

app.get('/auth/google/gmail/connect', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	try {
		const returnTo = sanitizeReturnTo(req.query.returnTo);
		const result = await buildGmailConnectUrl(userAuthId, returnTo);
		res.json({ url: result.url, tenantId: result.tenantId });
	} catch (error) {
		res.status(400).json({ error: toSafeError(error, 'Failed to build Google OAuth URL.') });
	}
});

app.get('/auth/google/gmail/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const connection = await getGmailConnection(tenantId, userAuthId);
		res.json({
			connected: Boolean(connection),
			tenantId,
			googleEmail: connection?.google_email ?? null,
			scopes: connection?.scopes ?? [],
			updatedAt: connection?.updated_at ?? null,
		});
	} catch (error) {
		res.status(400).json({ error: toSafeError(error, 'Failed to fetch Gmail connection status.') });
	}
});

async function handleGoogleGmailCallback(req: Request, res: Response) {
	const code = typeof req.query.code === 'string' ? req.query.code : '';
	const state = typeof req.query.state === 'string' ? req.query.state : '';
	const oauthError = typeof req.query.error === 'string' ? req.query.error : '';

	if (oauthError) {
		// oauthError comes from Google (e.g. "access_denied") — safe to surface.
		res.status(400).json({ error: `Google OAuth error: ${oauthError}` });
		return;
	}

	if (!code || !state) {
		res.status(400).json({ error: 'Missing OAuth callback code or state.' });
		return;
	}

	try {
		const result = await completeGmailOAuthCallback(code, state);
		const redirectTarget = redirectWithResult(result.returnTo, 'success');

		if (redirectTarget) {
			res.redirect(302, redirectTarget);
			return;
		}

		res.json({
			connected: true,
			tenantId: result.tenantId,
			userAuthId: result.userAuthId,
			googleEmail: result.googleEmail,
		});
	} catch (error) {
		toSafeError(error, 'OAuth callback failed.');
		const redirectTarget = redirectWithResult(undefined, 'error', 'OAuth callback failed. Please try again.');

		if (redirectTarget) {
			res.redirect(302, redirectTarget);
			return;
		}

		res.status(400).json({ error: 'OAuth callback failed. Please try again.' });
	}
}

app.get('/auth/google/gmail/callback', handleGoogleGmailCallback);
// Backward-compatible alias for older Google OAuth redirect URI configuration.
app.get('/auth/google/callback', handleGoogleGmailCallback);

app.post('/auth/google/gmail/disconnect', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const result = await disconnectGmailConnection(tenantId, userAuthId);
		res.json(result);
		writeAuditLog({ tenantId, userAuthId, action: 'gmail.disconnect' });
	} catch (error) {
		res.status(400).json({ error: toSafeError(error, 'Failed to disconnect Gmail.') });
	}
});

app.get('/gmail/inbox/stats', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const stats = await getGmailInboxStats(tenantId, userAuthId);
		res.json({ ...stats, connected: true });
	} catch (error) {
		// Always return 200 with connected:false so the dashboard never logs a console error.
		// Log unexpected errors server-side but never surface them to the client.
		if (
			!(error instanceof GmailReconnectRequiredError) &&
			!(error instanceof Error && error.message.includes('No tenant/business'))
		) {
			toSafeError(error, 'Failed to fetch inbox stats.');
		}
		res.json({ unreadCount: 0, connected: false });
	}
});

app.get('/calendar/events', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const timeMin = typeof req.query.timeMin === 'string' ? req.query.timeMin : undefined;
		const timeMax = typeof req.query.timeMax === 'string' ? req.query.timeMax : undefined;
		const maxResultsRaw =
			typeof req.query.maxResults === 'string' ? Number(req.query.maxResults) : undefined;
		const maxResults =
			Number.isFinite(maxResultsRaw) ? Math.min(Math.max(maxResultsRaw!, 1), 250) : 100;

		const events = await listCalendarEvents(tenantId, userAuthId, { timeMin, timeMax, maxResults });
		res.json({ events });
	} catch (error) {
		res.status(400).json({ error: toSafeError(error, 'Failed to fetch calendar events.') });
	}
});

app.post('/calendar/events', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
	const startTime = typeof req.body?.startTime === 'string' ? req.body.startTime : '';
	const endTime = typeof req.body?.endTime === 'string' ? req.body.endTime : '';

	if (!title || !startTime || !endTime) {
		res.status(422).json({ error: 'title, startTime, and endTime are required.' });
		return;
	}
	if (title.length > MAX_TITLE_LENGTH) {
		res.status(422).json({ error: `title must not exceed ${MAX_TITLE_LENGTH} characters.` });
		return;
	}

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const attendeeEmails = Array.isArray(req.body?.attendeeEmails)
			? req.body.attendeeEmails.filter((item: unknown): item is string => typeof item === 'string')
			: [];

		const event = await createCalendarEvent(tenantId, userAuthId, {
			title,
			startTime,
			endTime,
			description: typeof req.body?.description === 'string' ? req.body.description : undefined,
			attendeeEmails,
		});

		res.status(201).json(event);
		writeAuditLog({ tenantId, userAuthId, action: 'calendar.create', meta: { eventId: event.eventId } });
	} catch (error) {
		res.status(400).json({ error: toSafeError(error, 'Failed to create calendar event.') });
	}
});

app.delete('/calendar/events/:eventId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	const eventId = typeof req.params.eventId === 'string' ? req.params.eventId.trim() : '';
	if (!eventId) {
		res.status(422).json({ error: 'eventId is required.' });
		return;
	}

	try {
		const tenantId = await getTenantForUser(userAuthId);
		await deleteCalendarEvent(tenantId, userAuthId, eventId);
		res.status(204).send();
		writeAuditLog({ tenantId, userAuthId, action: 'calendar.delete', meta: { eventId } });
	} catch (error) {
		res.status(400).json({ error: toSafeError(error, 'Failed to delete calendar event.') });
	}
});

app.get('/tasks', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const status = typeof req.query.status === 'string' ? req.query.status : undefined;
		let query = supabase
			.from('tasks')
			.select('id,tenant_id,title,notes,due_at,status,created_at,updated_at')
			.eq('tenant_id', tenantId)
			.order('status', { ascending: true })
			.order('due_at', { ascending: true, nullsFirst: false })
			.order('created_at', { ascending: false });

		if (status === 'pending' || status === 'completed') {
			query = query.eq('status', status);
		}

		const { data, error } = await query;
		if (error) throw new Error(error.message);

		res.json({ tasks: (data as TaskRow[] | null) ?? [] });
	} catch (error) {
		res.status(400).json({ error: toSafeError(error, 'Failed to fetch tasks.') });
	}
});

app.post('/tasks', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
	if (!title) {
		res.status(422).json({ error: 'title is required.' });
		return;
	}
	if (title.length > MAX_TITLE_LENGTH) {
		res.status(422).json({ error: `title must not exceed ${MAX_TITLE_LENGTH} characters.` });
		return;
	}

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : null;
		if (notes && notes.length > MAX_NOTES_LENGTH) {
			res.status(422).json({ error: `notes must not exceed ${MAX_NOTES_LENGTH} characters.` });
			return;
		}
		const dueAt =
			typeof req.body?.dueAt === 'string' && req.body.dueAt.trim() ? req.body.dueAt : null;

		const { data, error } = await supabase
			.from('tasks')
			.insert({ tenant_id: tenantId, title, notes, due_at: dueAt, status: 'pending' })
			.select('id,tenant_id,title,notes,due_at,status,created_at,updated_at')
			.single();

		if (error || !data) throw new Error(error?.message || 'Task insert returned no data.');

		res.status(201).json(data);
		writeAuditLog({ tenantId, userAuthId, action: 'task.create', meta: { taskId: data.id } });
	} catch (error) {
		res.status(400).json({ error: toSafeError(error, 'Failed to create task.') });
	}
});

app.patch('/tasks/:taskId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	const taskId = typeof req.params.taskId === 'string' ? req.params.taskId.trim() : '';
	if (!taskId) {
		res.status(422).json({ error: 'taskId is required.' });
		return;
	}
	if (!requireUuid(taskId, 'taskId', res)) return;

	const updates: Record<string, unknown> = {};

	if (typeof req.body?.title === 'string') {
		const t = req.body.title.trim();
		if (t.length > MAX_TITLE_LENGTH) {
			res.status(422).json({ error: `title must not exceed ${MAX_TITLE_LENGTH} characters.` });
			return;
		}
		updates.title = t;
	}
	if (typeof req.body?.notes === 'string' || req.body?.notes === null) {
		const n = typeof req.body.notes === 'string' ? req.body.notes.trim() : null;
		if (n && n.length > MAX_NOTES_LENGTH) {
			res.status(422).json({ error: `notes must not exceed ${MAX_NOTES_LENGTH} characters.` });
			return;
		}
		updates.notes = n;
	}
	if (typeof req.body?.dueAt === 'string' || req.body?.dueAt === null) {
		updates.due_at =
			typeof req.body.dueAt === 'string' && req.body.dueAt.trim() ? req.body.dueAt : null;
	}
	if (req.body?.status === 'pending' || req.body?.status === 'completed') {
		updates.status = req.body.status;
	}

	if (Object.keys(updates).length === 0) {
		res.status(422).json({ error: 'At least one task field must be provided.' });
		return;
	}

	updates.updated_at = new Date().toISOString();

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const { data, error } = await supabase
			.from('tasks')
			.update(updates)
			.eq('id', taskId)
			.eq('tenant_id', tenantId)
			.select('id,tenant_id,title,notes,due_at,status,created_at,updated_at')
			.single();

		if (error || !data) throw new Error(error?.message || 'Task update returned no data.');

		res.json(data);
		writeAuditLog({ tenantId, userAuthId, action: 'task.update', meta: { taskId } });
	} catch (error) {
		res.status(400).json({ error: toSafeError(error, 'Failed to update task.') });
	}
});

app.delete('/tasks/:taskId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
	const userAuthId = req.userAuthId;
	if (!userAuthId) {
		res.status(401).json({ error: 'Missing authenticated user.' });
		return;
	}

	const taskId = typeof req.params.taskId === 'string' ? req.params.taskId.trim() : '';
	if (!taskId) {
		res.status(422).json({ error: 'taskId is required.' });
		return;
	}
	if (!requireUuid(taskId, 'taskId', res)) return;

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const { error } = await supabase
			.from('tasks')
			.delete()
			.eq('id', taskId)
			.eq('tenant_id', tenantId);

		if (error) throw new Error(error.message);

		res.status(204).send();
		writeAuditLog({ tenantId, userAuthId, action: 'task.delete', meta: { taskId } });
	} catch (error) {
		res.status(400).json({ error: toSafeError(error, 'Failed to delete task.') });
	}
});

app.post(
	'/agent/resolve-and-run',
	requireAuth,
	agentLimiter,
	async (req: AuthenticatedRequest, res: Response) => {
		const userAuthId = req.userAuthId;
		if (!userAuthId) {
			res.status(401).json({ error: 'Missing authenticated user.' });
			return;
		}

		const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
		if (!message) {
			res.status(422).json({ error: 'message is required.' });
			return;
		}
		if (message.length > MAX_MESSAGE_LENGTH) {
			res.status(422).json({ error: `message must not exceed ${MAX_MESSAGE_LENGTH} characters.` });
			return;
		}

		const accessToken = parseBearerToken(req);
		if (!accessToken) {
			res.status(401).json({ error: 'Missing bearer token.' });
			return;
		}

		try {
			const tenantId = await getTenantForUser(userAuthId);
			const result = await runDirectResolverChain({ tenantId, userAuthId, accessToken, message });

			res.json({
				tenantId,
				userAuthId,
				resolvedChainId: result.chainId,
				resolverConfidence: result.confidence,
				resolverReason: result.reason,
				resolverMissingInfo: result.missingInfo,
				result: result.handlerResult,
			});
			writeAuditLog({
				tenantId,
				userAuthId,
				action: 'agent.resolve',
				meta: { chainId: result.chainId, confidence: result.confidence },
			});
		} catch (error) {
			res.status(400).json({ error: toSafeError(error, 'Failed to resolve and execute chain.') });
		}
	},
);

app.post(
	'/agent/transcribe',
	requireAuth,
	agentLimiter,
	upload.single('audio'),
	async (req: AuthenticatedRequest, res: Response) => {
		if (!req.userAuthId) {
			res.status(401).json({ error: 'Missing authenticated user.' });
			return;
		}

		const file = req.file;
		if (!file) {
			res.status(400).json({ error: 'No audio file provided.' });
			return;
		}

		try {
			const tenantId = await getTenantForUser(req.userAuthId);
			const result = await transcribeAudio(tenantId, file.buffer, file.originalname || 'recording.webm');
			res.json(result);
			writeAuditLog({ tenantId, userAuthId: req.userAuthId, action: 'stt.transcribe' });
		} catch (error) {
			res.status(500).json({ error: toSafeError(error, 'Transcription failed.') });
		}
	},
);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
	logger.info(`Agent backend listening on port ${port}`);
});
