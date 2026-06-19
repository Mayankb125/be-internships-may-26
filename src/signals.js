import { insertSignal, getByIdemKey, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';

function nowMs(){ return Date.now(); }

// Detects whether an error thrown by better-sqlite3 came from the
// UNIQUE constraint on idempotency_key (i.e. a duplicate insert),
// as opposed to a genuine DB failure (e.g. our simulated DB_FAIL_RATE).
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

  // Rate limit check happens first, before touching the DB at all.
  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });

  const t = nowMs();

  // ATOMIC IDEMPOTENCY:
  // We no longer check-then-insert (that has a race window where two
  // concurrent requests with the same Idempotency-Key can both pass the
  // check before either has inserted, creating duplicates).
  //
  // Instead we attempt the insert directly. The DB's UNIQUE constraint
  // on idempotency_key is the single source of truth and enforces
  // correctness atomically, even under concurrent/parallel requests.
  try {
    const info = insertSignal(userId, type, payload, idem, t);
    return {
      id: info.lastInsertRowid,
      userId,
      type,
      payload: String(payload),
      idempotencyKey: idem,
      createdAt: t
    };
  } catch (e) {
    // If we collided on idempotency_key, it means another request with
    // the same key won the race and inserted first. That's not an error
    // from the client's point of view — return the row that already exists,
    // exactly as the spec ("same Idempotency-Key should not create duplicates")
    // and the contract "return the same resource for identical key" require.
    if (idem && isUniqueConstraintError(e)) {
      const existing = getByIdemKey(idem);
      if (existing) return existing;
      // Extremely unlikely edge case: constraint fired but row not found
      // (e.g. read-replica lag). Fall through to error handling below.
    }

    // Any other error (including our simulated DB_FAIL_RATE failures)
    // is a genuine DB problem — surface as 503 so the client can retry.
    req.log.error({ err: e, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = listSignals(userId, lim);
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}