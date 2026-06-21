// Audit log repository — fire-and-forget writes to the auditLogs Supabase table.
// Failures are logged but never propagate to callers so audit issues cannot break
// the primary request path. The auditLogs table must exist in Supabase with columns:
// tenant_id, user_auth_id, action_type, meta (jsonb), created_at.

import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

export type AuditAction =
  | 'agent.resolve'
  | 'calendar.create'
  | 'calendar.delete'
  | 'task.create'
  | 'task.update'
  | 'task.delete'
  | 'gmail.connect'
  | 'gmail.disconnect'
  | 'stt.transcribe';

export async function writeAuditLog(entry: {
  tenantId: string;
  userAuthId: string;
  action: AuditAction;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { error } = await supabase.from('auditLogs').insert({
      tenant_id: entry.tenantId,
      user_auth_id: entry.userAuthId,
      action_type: entry.action,
      meta: entry.meta ?? {},
      created_at: new Date().toISOString(),
    });
    // Supabase resolves with { error } rather than throwing on insert failures
    // (RLS violations, missing table, schema mismatch). Check explicitly.
    if (error) {
      logger.error({ err: error.message, code: error.code }, 'Failed to write audit log (non-fatal)');
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'Failed to write audit log (non-fatal)');
  }
}
