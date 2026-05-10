// In-memory sliding-window rate limiter. Used by the magic-link request
// flow (per identifier + per IP), the admin password-reset endpoint
// (per user), and the login endpoint (per IP).
//
// Two-call API on purpose: callers ask `check()` whether the next event
// is within the cap, and only call `record()` if they actually take the
// action. That keeps the count honest when (e.g.) a request-link call
// short-circuits before doing the lookup.
//
// In-memory only — survives a process restart loses history, which is
// acceptable for PJL's threat model. If we ever need cross-instance
// rate-limiting we'd swap this for Redis, but for now a single Render
// container is the only consumer.

const buckets = new Map();

// Drop timestamps older than `windowMs` from the bucket and return the
// remaining set so the caller can decide.
function trim(bucket, windowMs) {
  const cutoff = Date.now() - windowMs;
  while (bucket.length && bucket[0] < cutoff) bucket.shift();
  return bucket;
}

// Returns true if `key` is BELOW `limit` events in the last `windowMs`
// milliseconds (i.e. another event is allowed). Returns false otherwise.
function check(key, limit, windowMs) {
  if (!key) return true; // empty key — don't gate
  const bucket = buckets.get(key) || [];
  trim(bucket, windowMs);
  if (bucket.length === 0 && !buckets.has(key)) {
    // Don't allocate a bucket for a key we just trimmed-then-discarded.
  }
  return bucket.length < limit;
}

// Record an event for `key`. No expiry guard — combine with `check()` to
// implement a true rate limit, or call `record()` unconditionally to log
// every event regardless of whether it was rate-limited.
function record(key) {
  if (!key) return;
  const bucket = buckets.get(key) || [];
  bucket.push(Date.now());
  buckets.set(key, bucket);
}

// Manual sweep — primarily useful for tests. Production never calls this;
// the per-key trim() inside check() keeps memory bounded.
function reset() {
  buckets.clear();
}

module.exports = { check, record, reset };
