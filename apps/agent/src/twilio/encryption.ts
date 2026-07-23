import { createPrivateKey, privateDecrypt, createDecipheriv, constants } from 'crypto';

export interface TwilioEncryptionDetails {
  encryption_key: string; // RSA-OAEP encrypted AES-256 key, base64
  iv: string;             // AES-256-GCM IV, base64
}

// Hybrid decryption scheme Twilio uses for recording encryption:
// 1. RSA-OAEP (SHA-256) decrypts the per-recording AES key using your private key.
// 2. AES-256-GCM decrypts the audio bytes; Twilio appends the 16-byte auth tag.
export function decryptTwilioRecording(
  encryptedAudio: Buffer,
  details: TwilioEncryptionDetails,
): Buffer {
  const configured = process.env.TWILIO_PRIVATE_KEY_PEM;
  if (!configured) throw new Error('TWILIO_PRIVATE_KEY_PEM is not configured.');

  // generateTwilioKeys.ts stores the PEM base64-encoded so it fits on one .env line.
  // Accept either form: raw PEM (starts with the armor) or base64 of the PEM.
  const pem = configured.startsWith('-----BEGIN')
    ? configured
    : Buffer.from(configured, 'base64').toString('utf8');

  const privateKey = createPrivateKey(pem);

  const encryptedCek = Buffer.from(details.encryption_key, 'base64');
  const aesKey = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    encryptedCek,
  );

  const iv = Buffer.from(details.iv, 'base64');
  const authTag = encryptedAudio.subarray(-16);
  const ciphertext = encryptedAudio.subarray(0, -16);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
