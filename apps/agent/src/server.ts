// Entry point — Express server with JWT middleware
// All LLM calls and agent orchestration happen in this service
import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
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

function parseBearerToken(req: Request): string | null {
	const header = req.header('authorization') || req.header('Authorization');
	if (!header) {
		return null;
	}

	const [scheme, token] = header.split(' ');
	if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
		return null;
	}

	return token;
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
	} catch (error) {
		res.status(401).json({
			error: error instanceof Error ? error.message : 'Invalid token.',
		});
	}
}

function sanitizeReturnTo(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	if (trimmed.startsWith('/')) {
		return trimmed;
	}

	try {
		const parsed = new URL(trimmed);
		const allowedOrigins = (process.env.GMAIL_OAUTH_ALLOWED_REDIRECT_ORIGINS || '')
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean);

		if (allowedOrigins.includes(parsed.origin)) {
			return trimmed;
		}

		return undefined;
	} catch {
		return undefined;
	}
}

function redirectWithResult(returnTo: string | undefined, statusValue: 'success' | 'error', message?: string) {
	if (!returnTo) {
		return null;
	}

	const target = returnTo.startsWith('/')
		? new URL(returnTo, process.env.GMAIL_OAUTH_FALLBACK_BASE_URL || 'http://localhost:5174')
		: new URL(returnTo);

	target.searchParams.set('gmail_oauth', statusValue);
	if (message) {
		target.searchParams.set('message', message);
	}

	return target.toString();
}

const app = express();
app.use(express.json({ limit: '1mb' }));

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

		res.json({
			url: result.url,
			tenantId: result.tenantId,
		});
	} catch (error) {
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to build Google OAuth URL.',
		});
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
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to fetch Gmail connection status.',
		});
	}
});

async function handleGoogleGmailCallback(req: Request, res: Response) {
	const code = typeof req.query.code === 'string' ? req.query.code : '';
	const state = typeof req.query.state === 'string' ? req.query.state : '';
	const oauthError = typeof req.query.error === 'string' ? req.query.error : '';

	if (oauthError) {
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
		const message = error instanceof Error ? error.message : 'OAuth callback failed.';
		const redirectTarget = redirectWithResult(undefined, 'error', message);

		if (redirectTarget) {
			res.redirect(302, redirectTarget);
			return;
		}

		res.status(400).json({ error: message });
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
	} catch (error) {
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to disconnect Gmail.',
		});
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
		// Return 200 for any expected "not available" state so the dashboard never
		// logs a console error. A missing Gmail connection is not exceptional.
		if (
			error instanceof GmailReconnectRequiredError ||
			(error instanceof Error && error.message.includes('No tenant/business'))
		) {
			res.json({ unreadCount: 0, connected: false });
			return;
		}
		const message = error instanceof Error ? error.message : 'Failed to fetch inbox stats.';
		res.status(500).json({ error: message });
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
		const maxResultsRaw = typeof req.query.maxResults === 'string' ? Number(req.query.maxResults) : undefined;
		const maxResults = Number.isFinite(maxResultsRaw) ? Math.min(Math.max(Number(maxResultsRaw), 1), 250) : 100;

		const events = await listCalendarEvents(tenantId, userAuthId, {
			timeMin,
			timeMax,
			maxResults,
		});

		res.json({ events });
	} catch (error) {
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to fetch calendar events.',
		});
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
	} catch (error) {
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to create calendar event.',
		});
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
	} catch (error) {
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to delete calendar event.',
		});
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
		if (error) {
			throw new Error(error.message);
		}

		res.json({ tasks: (data as TaskRow[] | null) ?? [] });
	} catch (error) {
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to fetch tasks.',
		});
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

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : null;
		const dueAt = typeof req.body?.dueAt === 'string' && req.body.dueAt.trim() ? req.body.dueAt : null;

		const { data, error } = await supabase
			.from('tasks')
			.insert({
				tenant_id: tenantId,
				title,
				notes,
				due_at: dueAt,
				status: 'pending',
			})
			.select('id,tenant_id,title,notes,due_at,status,created_at,updated_at')
			.single();

		if (error || !data) {
			throw new Error(error?.message || 'Task insert returned no data.');
		}

		res.status(201).json(data);
	} catch (error) {
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to create task.',
		});
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

	const updates: Record<string, unknown> = {};
	if (typeof req.body?.title === 'string') {
		updates.title = req.body.title.trim();
	}
	if (typeof req.body?.notes === 'string' || req.body?.notes === null) {
		updates.notes = typeof req.body.notes === 'string' ? req.body.notes.trim() : null;
	}
	if (typeof req.body?.dueAt === 'string' || req.body?.dueAt === null) {
		updates.due_at = typeof req.body.dueAt === 'string' && req.body.dueAt.trim() ? req.body.dueAt : null;
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

		if (error || !data) {
			throw new Error(error?.message || 'Task update returned no data.');
		}

		res.json(data);
	} catch (error) {
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to update task.',
		});
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

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const { error } = await supabase.from('tasks').delete().eq('id', taskId).eq('tenant_id', tenantId);

		if (error) {
			throw new Error(error.message);
		}

		res.status(204).send();
	} catch (error) {
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to delete task.',
		});
	}
});

app.post('/agent/resolve-and-run', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
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

	const accessToken = parseBearerToken(req);
	if (!accessToken) {
		res.status(401).json({ error: 'Missing bearer token.' });
		return;
	}

	try {
		const tenantId = await getTenantForUser(userAuthId);
		const result = await runDirectResolverChain({
			tenantId,
			userAuthId,
			accessToken,
			message,
		});

		res.json({
			tenantId,
			userAuthId,
			resolvedChainId: result.chainId,
			resolverConfidence: result.confidence,
			resolverReason: result.reason,
			resolverMissingInfo: result.missingInfo,
			result: result.handlerResult,
		});
	} catch (error) {
		res.status(400).json({
			error: error instanceof Error ? error.message : 'Failed to resolve and execute chain.',
		});
	}
});

const upload = multer({ storage: multer.memoryStorage() });

app.post(
	'/agent/transcribe',
	requireAuth,
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
			const result = await transcribeAudio(
				tenantId,
				file.buffer,
				file.originalname || 'recording.webm',
			);
			res.json(result);
		} catch (error) {
			res.status(500).json({
				error: error instanceof Error ? error.message : 'Transcription failed.',
			});
		}
	},
);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
	console.log(`Agent backend listening on port ${port}`);
});
