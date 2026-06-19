# Scale Plan

- Data model/indexes:
  Current schema has a UNIQUE index on idempotency_key (enforces atomic
  dedup) and a composite index on (user_id, created_at) for fast lookups
  in GET /v1/signals. At 10k RPS, SQLite is not viable for writes (single
  writer lock) — would migrate to Postgres with the same indexes, plus
  partitioning the signals table by created_at (e.g. monthly partitions)
  to keep indexes small and queries fast as data grows.

- Idempotency across instances:
  Currently relies on a UNIQUE constraint at the DB layer, which is
  already instance-agnostic since all instances share one DB — this part
  scales as-is. To reduce DB load on initial collision detection, add a
  fast-path Redis cache: SET idempotency_key -> result with NX (only-if-
  not-exists) before hitting the DB, falling back to the DB UNIQUE
  constraint as the source of truth in case of cache misses or Redis
  failures.

- Rate limiting across instances:
  Current implementation is an in-memory sliding-window log, correct only
  within a single process. For multi-instance, move state to Redis: a
  sorted set per userId (ZADD with score=timestamp), ZREMRANGEBYSCORE to
  evict expired entries, ZCARD to count requests in window — wrapped in a
  Lua script (or Redis MULTI) so the check-and-increment is atomic across
  all instances hitting the same Redis.

- Observability (logs/metrics/alerts):
  Structured JSON logs (Fastify's built-in logger already gives this) for
  every request with status code, latency, userId. Export metrics
  (request rate, error rate, p50/p95/p99 latency, rate-limit rejection
  rate, DB error rate) to Prometheus/Grafana or a hosted equivalent
  (Datadog). Alert on: error rate > 1% over 5 min, p99 latency above SLA,
  DB connection pool exhaustion, sustained 429 rate spikes (could mean
  limit is too aggressive or abuse).

- Failure modes (DB down / partial outages / retries):
  Writes: retry with exponential backoff + jitter (implemented), capped
  at a few attempts, then fail fast with 503 rather than queue
  indefinitely — protects against cascading overload. Reads: could serve
  slightly-stale cached data (e.g. Redis cache of recent results) during
  a DB outage rather than failing entirely. Circuit breaker: after N
  consecutive DB failures, stop attempting calls for a cooldown window
  and fail fast immediately, to avoid piling up retries against an
  already-struggling DB.

- 10k RPS design sketch (infra & cost ballpark):
  - Load balancer (e.g. AWS ALB) in front of N stateless app instances
    (Fastify), autoscaled on CPU/request count.
  - Move idempotency/rate-limit state to a shared Redis cluster (Redis
    handles >100k ops/sec easily, so it's not the bottleneck).
  - Move primary DB to Postgres with read replicas; writes go to primary,
    GET /v1/signals reads can be load-balanced across replicas.
  - Add a write-behind queue (e.g. Kafka/SQS) if write volume itself
    needs to be smoothed out rather than hitting Postgres directly at
    10k RPS — though for simple inserts, Postgres with connection
    pooling (PgBouncer) and good indexes can likely handle this directly.
  - Rough ballpark: 4-8 app instances (small/medium VMs), a 3-node Redis
    cluster, a Postgres instance with 1-2 read replicas — low hundreds of
    dollars/month on a cloud provider at this scale, well before needing
    a queue layer.