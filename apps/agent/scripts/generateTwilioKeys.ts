// One-time script — generates an RSA-2048 key pair for Twilio recording encryption.
// Twilio only accepts 2048-bit keys for recording encryption — do not change this.
// Run with: npx tsx scripts/generateTwilioKeys.ts
//
// After running:
//   1. Register the public key with Twilio. TWO paths — do NOT mix them up:
//      a) Console UI (Voice → Settings → Public Keys): paste the RAW PEM (the
//         contents of twilio_public.pem, headers included). The browser encodes
//         it on submit — do NOT paste a URL-encoded value or it fails to parse.
//      b) Raw REST API call: POST https://accounts.twilio.com/v1/Credentials/PublicKeys
//         with PublicKey set to the URL-encoded PEM (use curl --data-urlencode
//         and pass the raw PEM; curl does the encoding for you).
//      Save the returned `sid` (starts with CR...) as TWILIO_RECORDING_KEY_SID in .env.
//   2. Add the private key to apps/agent/.env as a single-line base64 value:
//        TWILIO_PRIVATE_KEY_PEM=<base64 printed below>
//   3. Delete twilio_private.pem from disk — keep it only in .env.
//   4. Keep twilio_public.pem — re-upload if you ever rotate keys.

import { generateKeyPairSync } from 'crypto';
import { writeFileSync } from 'fs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

writeFileSync('twilio_public.pem', publicKey, 'utf8');
writeFileSync('twilio_private.pem', privateKey, 'utf8');

const privateKeyBase64 = Buffer.from(privateKey, 'utf8').toString('base64');

// Only needed for a hand-rolled REST call. The Console UI wants the raw PEM.
const publicKeyUrlEncoded = encodeURIComponent(publicKey);

console.log('Files written: twilio_public.pem, twilio_private.pem\n');
console.log('=== Console UI: paste this RAW PEM into the Public Key field ===');
console.log(publicKey);
console.log('=== REST API only: URL-encoded PEM (skip if using the Console) ===');
console.log(publicKeyUrlEncoded);
console.log('\n=== Add to apps/agent/.env ===');
console.log(`TWILIO_PRIVATE_KEY_PEM=${privateKeyBase64}`);
