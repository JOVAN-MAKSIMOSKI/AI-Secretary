// MCP tool — Gmail API integration for sending invoices/offers to clients
// Uses per-user OAuth token connections stored in the database.

import { google } from 'googleapis';
import { supabase } from '../lib/supabase.js';
import { buildGmailAuthClient, GmailReconnectRequiredError } from '../lib/gmailOAuth.js';

function toBase64Url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

// Reject CR/LF in any value interpolated into a MIME header — a newline allows injecting
// arbitrary headers (e.g. Bcc) when the value originates from stored client data.
function safeHeader(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error('Invalid header value.');
  }
  return value;
}

function buildMimeMessage(params: {
  from: string;
  to: string;
  subject: string;
  text: string;
  filename: string;
  attachment: Buffer;
}): string {
  const boundary = `boundary_${Date.now().toString(36)}`;
  const attachmentBase64 = params.attachment.toString('base64');

  const mime = [
    `From: ${safeHeader(params.from)}`,
    `To: ${safeHeader(params.to)}`,
    `Subject: ${safeHeader(params.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    params.text,
    '',
    `--${boundary}`,
    `Content-Type: application/octet-stream; name="${safeHeader(params.filename)}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${safeHeader(params.filename)}"`,
    '',
    attachmentBase64,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  return toBase64Url(Buffer.from(mime, 'utf-8'));
}

export async function sendGmailTestEmail(
  tenantId: string,
  userAuthId: string,
  to: string = 'test@example.com',
) {
  const { auth, googleEmail } = await buildGmailAuthClient(tenantId, userAuthId);
  const gmail = google.gmail({ version: 'v1', auth });
  const from = process.env.GMAIL_FROM_EMAIL || process.env.GOOGLE_SENDER_EMAIL || googleEmail || 'me';

  const raw = buildMimeMessage({
    from,
    to,
    subject: 'Test',
    text: 'Gmail API works',
    filename: 'test.txt',
    attachment: Buffer.from('Gmail API test attachment', 'utf-8'),
  });

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return {
    id: result.data.id,
    threadId: result.data.threadId,
  };
}

// Backward-compatible alias for previous caller name.
export const sendSmtpTestEmail = sendGmailTestEmail;

/**
 * Fetch document file from Supabase storage
 */
export async function getDocumentBuffer(
  tenantId: string,
  documentId: string,
  documentType: 'invoice' | 'offer'
): Promise<{ buffer: Buffer; filename: string }> {
  const ext = documentType === 'invoice' ? 'xlsx' : 'docx';
  const path = `${tenantId}/${documentType}s/${documentId}.${ext}`;

  const { data, error } = await supabase.storage.from('documents').download(path);

  if (error || !data) {
    throw new Error(`Failed to download document: ${error?.message || 'Unknown error'}`);
  }

  const buffer = await data.arrayBuffer();
  return {
    buffer: Buffer.from(buffer),
    filename: `${documentType}-${documentId}.${ext}`,
  };
}

/**
 * Send an invoice or offer to a client via email
 */
export async function sendDocumentToClient(
  tenantId: string,
  userAuthId: string,
  clientId: string,
  documentId: string,
  documentType: 'invoice' | 'offer'
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (userAuthId !== tenantId) {
      return {
        success: false,
        error: 'Cross-tenant sending is not allowed for this authenticated user.',
      };
    }

    const businessResponse = await supabase
      .from('businesses')
      .select('id,name,email,owner_auth_id')
      .eq('owner_auth_id', tenantId)
      .maybeSingle();

    const business = businessResponse.data;

    if (businessResponse.error) {
      return {
        success: false,
        error: `Failed to resolve business: ${businessResponse.error.message}`,
      };
    }

    if (!business) {
      return { success: false, error: `Tenant '${tenantId}' not found` };
    }

    // Get firm
    const firmResponse = await supabase
      .from('firms')
      .select('id,name,email')
      .eq('id', clientId)
      .eq('tenant_id', business.owner_auth_id)
      .maybeSingle();

    const firm = firmResponse.data;

    if (firmResponse.error) {
      return {
        success: false,
        error: `Failed to resolve firm: ${firmResponse.error.message}`,
      };
    }

    if (!firm) {
      return { success: false, error: `Firm '${clientId}' not found for this tenant` };
    }

    const recipientEmail = String(firm.email ?? '').trim();

    if (!recipientEmail) {
      return {
        success: false,
        error: `Firm '${clientId}' has no email address configured`,
      };
    }

    // Basic shape check that also rejects CR/LF, so a malformed stored address cannot reach
    // the MIME builder (defense in depth alongside safeHeader).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      return {
        success: false,
        error: `Firm '${clientId}' has invalid email '${recipientEmail}'`,
      };
    }

    // Get document record
    const table = documentType === 'invoice' ? 'invoices' : 'offers';
    const response = await supabase
      .from(table)
      .select('id, title, status')
      .eq('id', documentId)
      .eq('tenant_id', business.owner_auth_id)
      .single();

    if (response.error || !response.data) {
      return {
        success: false,
        error: `${documentType} '${documentId}' not found`,
      };
    }

    const document = response.data;

    // Download document from storage
    const { buffer, filename } = await getDocumentBuffer(business.owner_auth_id, documentId, documentType);

    // Prepare email
    const subject = `${documentType === 'invoice' ? 'Invoice' : 'Offer'}: ${document.title}`;
    const body = `
Dear ${firm.name},

Please find attached the ${documentType} for your review.

${documentType === 'invoice' ? 'This is an invoice for services rendered.' : 'This is an offer for your consideration.'}

Best regards,
${business.name}
    `.trim();

    const { auth, googleEmail } = await buildGmailAuthClient(tenantId, userAuthId);
    const gmail = google.gmail({ version: 'v1', auth });
    const from =
      process.env.GMAIL_FROM_EMAIL ||
      process.env.GOOGLE_SENDER_EMAIL ||
      googleEmail ||
      String(business.email || 'me');

    const raw = buildMimeMessage({
      from,
      to: recipientEmail,
      subject,
      text: body,
      filename,
      attachment: buffer,
    });

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    // Update document status and sent_at timestamp
    await supabase
      .from(table)
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
      })
      .eq('id', documentId)
      .eq('tenant_id', business.owner_auth_id);

    return {
      success: true,
      messageId: result.data.id || undefined,
    };
  } catch (error) {
    if (error instanceof GmailReconnectRequiredError) {
      return {
        success: false,
        error: `${error.message} Please reconnect Gmail.`,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to send ${documentType}: ${message}`,
    };
  }
}

/**
 * Returns the exact unread message count for the user's inbox over the last 30 days.
 * Paginates messages.list (IDs only, no payloads) to get a precise count rather
 * than relying on resultSizeEstimate, which is a stale server-side guess.
 */
export async function getGmailInboxStats(
  tenantId: string,
  userAuthId: string,
): Promise<{ unreadCount: number }> {
  const { auth } = await buildGmailAuthClient(tenantId, userAuthId);
  const gmail = google.gmail({ version: 'v1', auth });

  const since = new Date();
  since.setDate(since.getDate() - 30);
  const afterDate = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, '0')}/${String(since.getDate()).padStart(2, '0')}`;

  let count = 0;
  let pageToken: string | undefined;

  do {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: `is:unread in:inbox after:${afterDate}`,
      maxResults: 500,
      pageToken,
    });
    count += (response.data.messages ?? []).length;
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { unreadCount: count };
}

/**
 * List recent sent invoices/offers (for audit trail)
 */
export async function listSentDocuments(
  tenantId: string,
  documentType: 'invoice' | 'offer',
  limit: number = 10
): Promise<
  Array<{
    id: string;
    title: string;
    client_email: string;
    sent_at: string;
  }>
> {
  const businessResponse = await supabase
    .from('businesses')
    .select('owner_auth_id')
    .eq('owner_auth_id', tenantId)
    .maybeSingle();

  const business = businessResponse.data;

  if (businessResponse.error) {
    throw new Error(`Failed to resolve business: ${businessResponse.error.message}`);
  }

  if (!business) {
    throw new Error(`Tenant '${tenantId}' not found`);
  }

  const table = documentType === 'invoice' ? 'invoices' : 'offers';
  const { data, error } = await supabase
    .from(table)
    .select(
      `
      id,
      title,
      sent_at,
      firms (email)
    `
    )
    .eq('tenant_id', business.owner_auth_id)
    .eq('status', 'sent')
    .order('sent_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list sent ${documentType}s: ${error.message}`);
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    title: row.title,
    client_email: row.firms?.email || 'unknown',
    sent_at: row.sent_at,
  }));
}
