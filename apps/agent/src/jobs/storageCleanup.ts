// Scheduled maintenance job: delete generated invoice/offer files older than the
// retention window from Supabase Storage, then remove their DB rows.
//
// NOTE ON TENANT SCOPING: the repo rule "every Prisma query filters by tenantId"
// governs user-facing, request-scoped queries. This is a system-level maintenance
// sweep that intentionally runs across ALL tenants — there is no request tenant to
// scope to. The only safe boundary here is the retention cutoff, applied below.

import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

const FILE_RETENTION_DAYS = 7;
const STORAGE_BUCKET = 'documents';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Supabase Storage remove() takes an array of paths; batch to stay well within limits.
const REMOVE_BATCH_SIZE = 100;
// Daily at 03:00 server time.
const CLEANUP_CRON_EXPRESSION = '0 3 * * *';

type ExpiredRow = { id: string; storagePath: string };

function chunk<T>(items: T[], size: number): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		batches.push(items.slice(i, i + size));
	}
	return batches;
}

// Removes files from Storage in batches, then deletes only the DB rows whose files
// were successfully removed. A failed Storage batch is logged and its rows are left
// in place so the next run retries them — this avoids orphaning bytes in Storage.
async function expireTable(
	table: 'invoices' | 'offers',
	rows: ExpiredRow[],
): Promise<number> {
	let deletedCount = 0;

	for (const batch of chunk(rows, REMOVE_BATCH_SIZE)) {
		const paths = batch.map((row) => row.storagePath);
		const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);

		if (error) {
			logger.error(
				{ table, batchSize: batch.length, error: error.message },
				'Storage cleanup: remove batch failed, keeping DB rows for retry',
			);
			continue;
		}

		const ids = batch.map((row) => row.id);
		// Prisma models are named exactly `invoices` / `offers` in this schema.
		const result =
			table === 'invoices'
				? await prisma.invoices.deleteMany({ where: { id: { in: ids } } })
				: await prisma.offers.deleteMany({ where: { id: { in: ids } } });
		deletedCount += result.count;
	}

	return deletedCount;
}

export async function runStorageCleanup(): Promise<void> {
	const startTime = Date.now();
	const cutoff = new Date(startTime - FILE_RETENTION_DAYS * MS_PER_DAY);

	try {
		const [invoiceRows, offerRows] = await Promise.all([
			prisma.invoices.findMany({
				where: { created_at: { lt: cutoff } },
				select: { id: true, storagePath: true },
			}),
			prisma.offers.findMany({
				where: { created_at: { lt: cutoff } },
				select: { id: true, storagePath: true },
			}),
		]);

		const invoicesDeleted = await expireTable('invoices', invoiceRows);
		const offersDeleted = await expireTable('offers', offerRows);

		logger.info(
			{
				cutoff: cutoff.toISOString(),
				invoicesFound: invoiceRows.length,
				invoicesDeleted,
				offersFound: offerRows.length,
				offersDeleted,
				durationMs: Date.now() - startTime,
			},
			'Storage cleanup complete',
		);
	} catch (err) {
		// Never let a maintenance failure crash the server process.
		logger.error(
			{
				error: err instanceof Error ? err.message : String(err),
				durationMs: Date.now() - startTime,
			},
			'Storage cleanup failed',
		);
	}
}

// Registers the daily cron job. Gated by STORAGE_CLEANUP_ENABLED so it can be turned
// off in environments where auto-deletion is undesirable (e.g. local dev).
export function startStorageCleanupSchedule(): void {
	if (process.env.STORAGE_CLEANUP_ENABLED !== 'true') {
		logger.info('Storage cleanup schedule disabled (set STORAGE_CLEANUP_ENABLED=true to enable)');
		return;
	}

	cron.schedule(CLEANUP_CRON_EXPRESSION, () => {
		void runStorageCleanup();
	});

	logger.info(
		{ cron: CLEANUP_CRON_EXPRESSION, retentionDays: FILE_RETENTION_DAYS },
		'Storage cleanup schedule started',
	);
}
