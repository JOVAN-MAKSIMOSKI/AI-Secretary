// Twilio webhook signature validation middleware.
// Validates X-Twilio-Signature against the full request URL and POST body params.
// Returns 403 on failure to prevent spoofed webhook calls from non-Twilio sources.
// In development (TWILIO_AUTH_TOKEN not set), logs a warning and passes through.

import twilio from 'twilio';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

export function validateTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const publicUrl = process.env.AGENT_PUBLIC_URL;

  if (!authToken || !publicUrl) {
    logger.warn('TWILIO_AUTH_TOKEN or AGENT_PUBLIC_URL not set — skipping Twilio signature validation (dev mode)');
    next();
    return;
  }

  const signature = req.header('X-Twilio-Signature') || '';
  const url = `${publicUrl}${req.originalUrl}`;
  const params = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, string>) : {};

  const isValid = twilio.validateRequest(authToken, signature, url, params);
  if (!isValid) {
    res.status(403).json({ error: 'Forbidden: invalid Twilio signature.' });
    return;
  }

  next();
}
