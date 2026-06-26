// Generates a short-lived Twilio Access Token granting WebRTC voice capability.
// Used by the browser test page — no user auth required because the grant only
// allows outbound calls into your own TwiML App.

import twilio from 'twilio';

export const WEBRTC_DEV_IDENTITY = 'dev';
const TOKEN_TTL_SECONDS = 3600;

export function generateWebRtcToken(): string {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;

  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
    throw new Error(
      'TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, and TWILIO_TWIML_APP_SID are required.',
    );
  }

  const { AccessToken } = twilio.jwt;
  const { VoiceGrant } = AccessToken;

  const grant = new VoiceGrant({ outgoingApplicationSid: twimlAppSid, incomingAllow: true });

  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
    identity: WEBRTC_DEV_IDENTITY,
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant(grant);

  return token.toJwt();
}
