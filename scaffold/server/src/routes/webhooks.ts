import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { config } from '../config.js';
import { storeInboundMessage } from '../services/inboundService.js';
import { handleMessageStatus } from '../services/outboundService.js';

const MAX_TIMESTAMP_AGE_SECONDS = 300; // 5 minutes

export const webhooksRouter = Router();

/**
 * Verifies Pigeon's `x-pigeon-signature: t=<unix>,v1=<hex>` header against the exact raw body.
 */
export function verifyPigeonSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader) return false;

  let timestampStr: string | undefined;
  let v1Hex: string | undefined;

  for (const part of signatureHeader.split(',')) {
    const trimmed = part.trim();
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1);
    if (key === 't') {
      if (timestampStr !== undefined) return false;
      timestampStr = value;
    }
    if (key === 'v1') {
      if (v1Hex !== undefined) return false;
      v1Hex = value;
    }
  }

  if (!timestampStr || !/^\d+$/.test(timestampStr)) return false;
  if (!v1Hex || !/^[0-9a-fA-F]{64}$/.test(v1Hex)) return false;

  const timestamp = Number(timestampStr);
  if (!Number.isSafeInteger(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_AGE_SECONDS) return false;

  const expectedDigest = createHmac('sha256', secret)
    .update(`${timestampStr}.`)
    .update(rawBody)
    .digest();

  const providedDigest = Buffer.from(v1Hex, 'hex');
  if (expectedDigest.length !== providedDigest.length) return false;

  return timingSafeEqual(expectedDigest, providedDigest);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

webhooksRouter.post(
  '/webhooks/pigeon',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res, next) => {
    try {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

      const signatureHeader = req.header('x-pigeon-signature');
      if (
        !verifyPigeonSignature(
          rawBody,
          signatureHeader,
          config.pigeon.webhookSecret,
        )
      ) {
        res.status(401).json({ error: 'Invalid webhook signature or timestamp' });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'Invalid JSON payload' });
        return;
      }

      if (!isPlainObject(payload)) {
        res.status(400).json({ error: 'Invalid webhook payload' });
        return;
      }

      const eventType = typeof payload.type === 'string' ? payload.type : '';
      const workspace =
        typeof payload.workspace === 'string' ? payload.workspace : '';

      // Unknown workspace: acknowledge 2xx and ignore per PIGEON.md
      if (workspace && !Object.hasOwn(config.pigeon.apiKeys, workspace)) {
        res.status(200).json({ ok: true, ignored: 'unknown_workspace' });
        return;
      }

      if (eventType === 'message.status') {
        const eventId = typeof payload.id === 'string' ? payload.id : '';
        const occurredAtRaw = payload.occurred_at;
        const occurredAt =
          typeof occurredAtRaw === 'string'
            ? new Date(occurredAtRaw)
            : new Date(NaN);
        const data = payload.data;
        const status =
          isPlainObject(data) && typeof data.status === 'string'
            ? data.status
            : '';

        if (
          !eventId ||
          !workspace ||
          Number.isNaN(occurredAt.getTime()) ||
          !isPlainObject(data) ||
          typeof data.client_ref !== 'string' ||
          !data.client_ref ||
          (status !== 'sent' && status !== 'delivered' && status !== 'failed')
        ) {
          res.status(400).json({ error: 'Invalid message.status payload' });
          return;
        }

        const result = await handleMessageStatus({
          eventId,
          workspace,
          clientRef: data.client_ref,
          messageId:
            typeof data.message_id === 'string' ? data.message_id : undefined,
          status,
          occurredAt,
        });

        res.status(200).json({ ok: true, ...result });
        return;
      }

      // Unknown event type: acknowledge 2xx so Pigeon does not retry
      if (eventType && eventType !== 'message.inbound') {
        res.status(200).json({ ok: true, ignored: eventType });
        return;
      }

      const eventId = typeof payload.id === 'string' ? payload.id : '';
      const occurredAtRaw = payload.occurred_at;
      const occurredAt =
        typeof occurredAtRaw === 'string' ? new Date(occurredAtRaw) : new Date(NaN);
      const data = payload.data;

      if (
        eventType !== 'message.inbound' ||
        !eventId ||
        !workspace ||
        Number.isNaN(occurredAt.getTime()) ||
        !isPlainObject(data) ||
        typeof data.message_id !== 'string' ||
        !data.message_id ||
        typeof data.from !== 'string' ||
        !data.from ||
        typeof data.text !== 'string'
      ) {
        res.status(400).json({ error: 'Invalid message.inbound payload' });
        return;
      }

      const result = await storeInboundMessage({
        eventId,
        workspace,
        contact: data.from,
        messageId: data.message_id,
        text: data.text,
        occurredAt,
      });

      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  },
);
