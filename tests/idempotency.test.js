import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

test('idempotency returns same resource for same key', async () => {
  const proc = spawn('node', ['src/server.js'], { env: { ...process.env, API_KEY: 'k', PORT: '9091' } });
  await wait(300);

  const base = 'http://localhost:9091';
  const idem = 'same-key';

  const a = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
    body: { userId: 'u1', type: 'note', payload: 'x' }
  });
  const b = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
    body: { userId: 'u1', type: 'note', payload: 'x' }
  });

  assert.equal(a.id, b.id);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  proc.kill();
});

test('idempotency holds under truly concurrent requests (no duplicates)', async () => {
  const proc = spawn('node', ['src/server.js'], {
    env: { ...process.env, API_KEY: 'k', PORT: '9093', RATE_LIMIT_PER_MIN: '1000' }
  });
  await wait(300);

  const base = 'http://localhost:9093';
  const idem = 'concurrent-key';
  const CONCURRENCY = 10;

  // Fire all requests at once — Promise.all does NOT await between them,
  // so they hit the server back-to-back with no serialization from the
  // client side. This is what actually exercises the race window that
  // check-then-insert would fail under.
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      postJson(`${base}/v1/signals`, {
        headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
        body: { userId: 'u-concurrent', type: 'note', payload: `attempt-${i}` }
      })
    )
  );

  // Every response should resolve to the SAME row (same id), proving
  // only one insert ever happened despite N simultaneous requests.
  const ids = results.map((r) => r.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, 1, `expected exactly 1 unique id, got: ${[...uniqueIds]}`);

  // Independently verify against the DB via GET, to make sure there's
  // really only one row stored for this user — not just that the API
  // responses happened to agree (in case of a caching bug masking the issue).
  const listed = await getJson(`${base}/v1/signals?userId=u-concurrent&limit=50`, {
    headers: { 'x-api-key': 'k' }
  });
  const matching = listed.items.filter((it) => it.idempotencyKey === idem);
  assert.equal(matching.length, 1, `expected 1 row in DB, found ${matching.length}`);

  proc.kill();
});

async function postJson(url, { headers, body }){
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let chunks=''; res.on('data', d => chunks+=d);
      res.on('end', () => resolve(JSON.parse(chunks||'{}')));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function getJson(url, { headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => resolve(JSON.parse(chunks || '{}')));
    });
    req.on('error', reject);
    req.end();
  });
}