// MCP tool — SMTP integration for sending invoices/offers to clients
// Requires SMTP_USER and SMTP_PASS env vars

import nodemailer from 'nodemailer';
import { supabase } from '../lib/supabase.js';

const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;

if (!smtpUser || !smtpPass) {
  throw new Error('SMTP_USER and SMTP_PASS are required for SMTP email sending.');
}

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

export async function sendSmtpTestEmail(to: string = 'test@example.com') {
  return transporter.sendMail({
    from: smtpUser,
    to,
    subject: 'Test',
    text: 'SMTP works',
  });
}

/**
 * Fetch document file from Supabase storage
 */
async function getDocumentBuffer(
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
  clientId: string,
  documentId: string,
  documentType: 'invoice' | 'offer'
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
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

    // Get client
    const clientResponse = await supabase
      .from('clients')
      .select('id,name,email')
      .eq('id', clientId)
      .eq('tenant_id', business.owner_auth_id)
      .maybeSingle();

    const client = clientResponse.data;

    if (clientResponse.error) {
      return {
        success: false,
        error: `Failed to resolve client: ${clientResponse.error.message}`,
      };
    }

    if (!client) {
      return { success: false, error: `Client '${clientId}' not found for this tenant` };
    }

    const recipientEmail = String(client.email ?? '').trim();

    if (!recipientEmail) {
      return {
        success: false,
        error: `Client '${clientId}' has no email address configured`,
      };
    }

    if (!recipientEmail.includes('@')) {
      return {
        success: false,
        error: `Client '${clientId}' has invalid email '${recipientEmail}'`,
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
Dear ${client.name},

Please find attached the ${documentType} for your review.

${documentType === 'invoice' ? 'This is an invoice for services rendered.' : 'This is an offer for your consideration.'}

Best regards,
${business.name}
    `.trim();

    // Send via SMTP
    const result = await transporter.sendMail({
      from: smtpUser,
      to: recipientEmail,
      subject,
      text: body,
      attachments: [
        {
          filename,
          content: buffer,
        },
      ],
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
      messageId: result.messageId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to send ${documentType}: ${message}`,
    };
  }
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
      clients (email)
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
    client_email: row.clients?.email || 'unknown',
    sent_at: row.sent_at,
  }));
}
