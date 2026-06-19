import { insertSignal, getByIdemKey, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';
import { retry } from './retry.js';

function nowMs(){ return Date.now(); }

function isUniqueConstraintError(e) {
  return (
    e &&
    (e.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      e.code === 'SQLITE_CONSTRAINT' ||
      (typeof e.message === 'string' && e.message.includes('UNIQUE constraint failed')))
  );
}

export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });

  const t = nowMs();

  try {
    const info = await retry(() => insertSignal(userId, type, payload, idem, t), {
      maxAttempts: 3,
      baseDelayMs: 25,
      // Don't burn retries on a conflict — it's not transient, handle it now.
      shouldRetry: (e) => !isUniqueConstraintError(e)
    });
    return {
      id: info.lastInsertRowid,
      userId,
      type,
      payload: String(payload),
      idempotencyKey: idem,
      createdAt: t
    };
  } catch (e) {
    if (idem && isUniqueConstraintError(e)) {
      try {
        const existing = await retry(() => getByIdemKey(idem), { maxAttempts: 3, baseDelayMs: 25 });
        if (existing) return existing;
        // Constraint fired but row not found yet — extremely unlikely with
        // synchronous SQLite, but guard anyway.
        req.log.error({ ctx: 'conflict-but-no-existing-row', idem });
        return reply.code(503).send({ error: 'db_unavailable' });
      } catch (e2) {
        req.log.error({ err: e2, ctx: 'getByIdemKey-after-conflict' });
        return reply.code(503).send({ error: 'db_unavailable' });
      }
    }

    req.log.error({ err: e, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await retry(() => listSignals(userId, lim), { maxAttempts: 3, baseDelayMs: 25 });
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}