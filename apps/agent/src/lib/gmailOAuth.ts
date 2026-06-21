import crypto from 'node:crypto';
import { google } from 'googleapis';
import { supabase } from './supabase.js';

export class GmailReconnectRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailReconnectRequiredError';
  }
}

type OAuthStatePayload = {
  uid: string;
  tid: string;
  nonce: string;
  iat: number;
  returnTo?: string;
};

type GmailConnectionRow = {
  tenant_id: string;
  user_auth_id: string;
  google_email: string | null;
  scopes: string[];
  access_token_enc: string | null;
  refresh_token_enc: string;
  expiry_date: string | null;
  updated_at: string;
};

const DEFAULT_REDIRECT_URI = 'http://localhost:3000/auth/google/gmail/callback';
const DEFAULT_STATE_TTL_SECONDS = 300;

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

function getGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URL || DEFAULT_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getStateSecret(): string {
  const value = process.env.GMAIL_OAUTH_STATE_SECRET || process.env.GOOGLE_OAUTH_STATE_SECRET;
  if (!value) {
    throw new Error('GMAIL_OAUTH_STATE_SECRET (or GOOGLE_OAUTH_STATE_SECRET) is required.');
  }

  return value;
}

function getEncryptionKey(): Buffer {
  const value = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  if (!value) {
    throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY is required.');
  }

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }

  const base64Buffer = Buffer.from(value, 'base64');
  if (base64Buffer.length === 32) {
    return base64Buffer;
  }

  throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must be a 32-byte base64 or 64-char hex key.');
}

function encryptSecret(plainText: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const cipherText = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    cipherText.toString('base64url'),
  ].join('.');
}

function decryptSecret(cipherPayload: string): string {
  const [version, ivEncoded, authTagEncoded, cipherTextEncoded] = cipherPayload.split('.');

  if (version !== 'v1' || !ivEncoded || !authTagEncoded || !cipherTextEncoded) {
    throw new Error('Unsupported encrypted token format.');
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(ivEncoded, 'base64url');
  const authTag = Buffer.from(authTagEncoded, 'base64url');
  const cipherText = Buffer.from(cipherTextEncoded, 'base64url');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return plainText.toString('utf8');
}

function signState(payload: OAuthStatePayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', getStateSecret())
    .update(encodedPayload)
    .digest('base64url');

  return `${encodedPayload}.${signature}`;
}

function verifyState(state: string): OAuthStatePayload {
  const [encodedPayload, signature] = state.split('.');

  if (!encodedPayload || !signature) {
    throw new Error('Invalid OAuth state format.');
  }

  const expectedSignature = crypto
    .createHmac('sha256', getStateSecret())
    .update(encodedPayload)
    .digest('base64url');

  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new Error('OAuth state signature mismatch.');
  }

  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as OAuthStatePayload;

  const ageSeconds = Math.floor((Date.now() - payload.iat) / 1000);
  if (!payload.iat || ageSeconds > DEFAULT_STATE_TTL_SECONDS) {
    throw new Error('OAuth state expired.');
  }

  if (!payload.uid || !payload.tid || !payload.nonce) {
    throw new Error('OAuth state missing required fields.');
  }

  return payload;
}

export async function getTenantForUser(userAuthId: string): Promise<string> {
  const { data, error } = await supabase
    .from('businesses')
    .select('owner_auth_id')
    .eq('owner_auth_id', userAuthId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to resolve tenant: ${error.message}`);
  }

  if (!data) {
    throw new Error('No tenant/business is associated with this user.');
  }

  return String(data.owner_auth_id);
}

export async function getGmailConnection(
  tenantId: string,
  userAuthId: string,
): Promise<GmailConnectionRow | null> {
  const { data, error } = await supabase
    .from('gmail_oauth_connections')
    .select(
      'tenant_id,user_auth_id,google_email,scopes,access_token_enc,refresh_token_enc,expiry_date,updated_at',
    )
    .eq('tenant_id', tenantId)
    .eq('user_auth_id', userAuthId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Gmail connection: ${error.message}`);
  }

  return (data as GmailConnectionRow | null) ?? null;
}

export async function buildGmailConnectUrl(
  userAuthId: string,
  returnTo?: string,
): Promise<{ url: string; tenantId: string }> {
  const tenantId = await getTenantForUser(userAuthId);
  const oauth2Client = getGoogleOAuthClient();

  const state = signState({
    uid: userAuthId,
    tid: tenantId,
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: Date.now(),
    returnTo,
  });

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GMAIL_SEND_SCOPE, GMAIL_READONLY_SCOPE, GOOGLE_CALENDAR_SCOPE, 'openid', 'email', 'profile'],
    state,
    include_granted_scopes: true,
  });

  return { url, tenantId };
}

export async function completeGmailOAuthCallback(code: string, state: string): Promise<{
  tenantId: string;
  userAuthId: string;
  returnTo?: string;
  googleEmail: string | null;
}> {
  const payload = verifyState(state);
  const oauth2Client = getGoogleOAuthClient();
  const existingConnection = await getGmailConnection(payload.tid, payload.uid);

  const tokenResponse = await oauth2Client.getToken(code);
  const tokens = tokenResponse.tokens;

  let refreshToken = tokens.refresh_token;
  if (!refreshToken && existingConnection?.refresh_token_enc) {
    refreshToken = decryptSecret(existingConnection.refresh_token_enc);
  }

  if (!refreshToken) {
    throw new GmailReconnectRequiredError('Google did not return a refresh token. Reconnect with consent.');
  }

  oauth2Client.setCredentials(tokens);

  let googleEmail: string | null = existingConnection?.google_email ?? null;
  try {
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client });
    const profile = await oauth2Api.userinfo.get();
    googleEmail = profile.data.email ?? googleEmail;
  } catch {
    // Profile fetch is optional for connection persistence.
  }

  const scopes = (tokens.scope || '')
    .split(' ')
    .map((item) => item.trim())
    .filter(Boolean);

  const payloadToPersist = {
    tenant_id: payload.tid,
    user_auth_id: payload.uid,
    google_email: googleEmail,
    scopes,
    access_token_enc: tokens.access_token
      ? encryptSecret(tokens.access_token)
      : existingConnection?.access_token_enc ?? null,
    refresh_token_enc: encryptSecret(refreshToken),
    expiry_date: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('gmail_oauth_connections')
    .upsert(payloadToPersist, { onConflict: 'tenant_id,user_auth_id' });

  if (error) {
    throw new Error(`Failed to persist Gmail connection: ${error.message}`);
  }

  return {
    tenantId: payload.tid,
    userAuthId: payload.uid,
    returnTo: payload.returnTo,
    googleEmail,
  };
}

export async function disconnectGmailConnection(
  tenantId: string,
  userAuthId: string,
): Promise<{ disconnected: boolean; revoked: boolean }> {
  const connection = await getGmailConnection(tenantId, userAuthId);

  if (!connection) {
    return { disconnected: false, revoked: false };
  }

  const oauth2Client = getGoogleOAuthClient();
  let revoked = false;

  try {
    const refreshToken = decryptSecret(connection.refresh_token_enc);
    await oauth2Client.revokeToken(refreshToken);
    revoked = true;
  } catch {
    // Continue disconnect flow even when remote token revoke fails.
  }

  if (connection.access_token_enc) {
    try {
      const accessToken = decryptSecret(connection.access_token_enc);
      await oauth2Client.revokeToken(accessToken);
      revoked = true;
    } catch {
      // Continue with local disconnect.
    }
  }

  const { error } = await supabase
    .from('gmail_oauth_connections')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('user_auth_id', userAuthId);

  if (error) {
    throw new Error(`Failed to disconnect Gmail: ${error.message}`);
  }

  return { disconnected: true, revoked };
}

export async function buildGmailAuthClient(
  tenantId: string,
  userAuthId: string,
): Promise<{ auth: ReturnType<typeof getGoogleOAuthClient>; googleEmail: string | null }> {
  if (tenantId !== userAuthId) {
    throw new Error('Cross-tenant Gmail send is not allowed for this user.');
  }

  const resolvedTenant = await getTenantForUser(userAuthId);
  if (resolvedTenant !== tenantId) {
    throw new Error('Tenant mismatch for authenticated user.');
  }

  const connection = await getGmailConnection(tenantId, userAuthId);
  if (!connection) {
    throw new GmailReconnectRequiredError('No Gmail connection found for this user.');
  }

  const oauth2Client = getGoogleOAuthClient();

  try {
    oauth2Client.setCredentials({
      refresh_token: decryptSecret(connection.refresh_token_enc),
      access_token: connection.access_token_enc
        ? decryptSecret(connection.access_token_enc)
        : undefined,
      expiry_date: connection.expiry_date ? new Date(connection.expiry_date).getTime() : undefined,
    });
  } catch {
    throw new GmailReconnectRequiredError('Stored Gmail token could not be decrypted. Reconnect required.');
  }

  return { auth: oauth2Client, googleEmail: connection.google_email };
}
