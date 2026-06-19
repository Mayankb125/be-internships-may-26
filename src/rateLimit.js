// src/rateLimit.js
//
// Sliding-window rate limiter (per-instance).
// Tracks individual request timestamps per user instead of a single
// counter+window-start pair. This avoids the "double burst" bug of
// fixed-window counters, where a user can send RATE requests right at
// the end of one window and RATE more right after it resets.
//
// NOTE on multi-instance safety: this in-memory implementation is
// correct for a single process only. For multi-instance deployments,
// see SCALE.md — the production fix is to move this state to Redis
// using a sorted set (ZADD + ZREMRANGEBYSCORE) or the Redis token-bucket
// pattern, so all instances share one source of truth.

const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

// userId -> array of timestamps (ms) of requests within the current window
const requestLog = new Map();

export function checkAndConsume(userId, nowMs = Date.now()) {
  const windowStart = nowMs - WINDOW_MS;

  // Get this user's request timestamps, drop any that have aged out
  // of the sliding window.
  const timestamps = (requestLog.get(userId) || []).filter(
    (ts) => ts > windowStart
  );

  const ok = timestamps.length < RATE;

  if (ok) {
    // Only record the request if it's allowed — rejected requests
    // shouldn't count against the limit (avoids permanently locking
    // out a user who gets a few 429s back to back).
    timestamps.push(nowMs);
  }

  requestLog.set(userId, timestamps);

  const remaining = Math.max(RATE - timestamps.length, 0);
  // resetMs: when the oldest request in the window will age out,
  // i.e. the earliest time the user could send another request.
  const resetMs = timestamps.length > 0 ? timestamps[0] + WINDOW_MS : nowMs;

  return { ok, remaining, resetMs };
}