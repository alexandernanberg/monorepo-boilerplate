import type { Result } from 'ioredis'
import { redis } from '~/lib/redis'

/**
 * Both limiters run as Lua so the read-modify-write is atomic: two concurrent
 * requests cannot each read the same token count and both spend it.
 *
 * They are registered with `defineCommand` rather than called through
 * `evalsha`. ioredis then keeps the SHA itself and retries with `EVAL` on
 * `NOSCRIPT`, which is what happens after a Redis restart or failover — with a
 * hand-cached SHA that error surfaces as a 500 on every auth route until the
 * process is restarted.
 */

const BUCKET_SCRIPT = `
-- Token bucket. Returns {1, remaining} when allowed, {0, retryInMs} when not.
--
-- Times are milliseconds throughout. With whole-second granularity two calls
-- 20ms apart can straddle a second boundary and be credited a full interval,
-- which quietly inflates the limit under exactly the burst it exists to stop.
local key              = KEYS[1]
local max              = tonumber(ARGV[1])
local refillIntervalMs = tonumber(ARGV[2])
local cost             = tonumber(ARGV[3])
local now              = tonumber(ARGV[4]) -- unix time in milliseconds

local count, refilledAt = unpack(redis.call("HMGET", key, "count", "refilled_at"))

if not count then
  count = max
  refilledAt = now
else
  count = tonumber(count)
  refilledAt = tonumber(refilledAt)

  local refill = math.floor((now - refilledAt) / refillIntervalMs)
  if refill > 0 then
    count = math.min(count + refill, max)
    -- Advance by whole intervals only. Assigning \`now\` here would discard the
    -- remainder, so traffic arriving faster than the refill interval would keep
    -- resetting the clock and never earn a token back.
    refilledAt = refilledAt + (refill * refillIntervalMs)
  end
end

if count < cost then
  -- Time until the next token lands, for \`Retry-After\`.
  local retryInMs = (refilledAt + refillIntervalMs) - now
  if retryInMs < 0 then retryInMs = 0 end
  return {0, retryInMs}
end

count = count - cost

redis.call("HSET", key, "count", count, "refilled_at", refilledAt)

-- Expire exactly when the bucket would be full again: that is the point where
-- a missing key and a stored one mean the same thing. Expiring sooner (say,
-- after one refill interval) silently hands back a full bucket and turns the
-- limit into "max per interval" with no refill at all.
redis.call("PEXPIRE", key, math.ceil((max - count) * refillIntervalMs))

return {1, count}
`

const THROTTLE_SCRIPT = `
-- Escalating lockout. Returns {1, index} when allowed, {0, retryInMs} when not.
local key = KEYS[1]
local now = tonumber(ARGV[1]) -- unix time in milliseconds

local timeoutMs = {1000, 2000, 4000, 8000, 16000, 30000, 60000, 180000, 300000}
local inactivityResetMs = 3600000

local index, updatedAt = unpack(redis.call("HMGET", key, "index", "updated_at"))

if not index then
  redis.call("HSET", key, "index", 1, "updated_at", now)
  redis.call("PEXPIRE", key, inactivityResetMs)
  return {1, 1}
end

index = tonumber(index)
updatedAt = tonumber(updatedAt)

local elapsed = now - updatedAt

if elapsed < timeoutMs[index] then
  return {0, timeoutMs[index] - elapsed}
end

index = math.min(index + 1, #timeoutMs)

redis.call("HSET", key, "index", index, "updated_at", now)
redis.call("PEXPIRE", key, inactivityResetMs)

return {1, index}
`

declare module 'ioredis' {
  interface RedisCommander<Context> {
    rateLimitBucket(
      key: string,
      max: number,
      refillIntervalMs: number,
      cost: number,
      nowMs: number,
    ): Result<[number, number], Context>

    rateLimitThrottle(
      key: string,
      nowMs: number,
    ): Result<[number, number], Context>
  }
}

redis.defineCommand('rateLimitBucket', { numberOfKeys: 1, lua: BUCKET_SCRIPT })
redis.defineCommand('rateLimitThrottle', {
  numberOfKeys: 1,
  lua: THROTTLE_SCRIPT,
})

class BaseRateLimiter {
  protected storageKey: string

  constructor(storageKey: string) {
    this.storageKey = storageKey
  }

  protected getKey(name: string): string {
    return `rate_limit:${this.storageKey}:${name}`
  }

  async reset(key: string): Promise<void> {
    await redis.del(this.getKey(key))
  }
}

/**
 * A bucket of `size` tokens that refills one token every `refillRateSeconds`.
 * Absorbs a burst up to the bucket size, then admits traffic at the refill
 * rate. Keyed per caller, so one client cannot spend another's budget.
 */
class BucketRateLimiter extends BaseRateLimiter {
  public size: number
  public refillRateSeconds: number

  constructor(
    storageKey: string,
    opts: { size: number; refillRateSeconds: number },
  ) {
    super(storageKey)
    this.size = opts.size
    this.refillRateSeconds = opts.refillRateSeconds
  }

  public async consume(key: string, cost: number) {
    const [allowed, value] = await redis.rateLimitBucket(
      this.getKey(key),
      this.size,
      this.refillRateSeconds * 1000,
      cost,
      Date.now(),
    )

    if (allowed === 0) {
      throw new RateLimitError({ resetsInMs: value })
    }

    return true
  }
}

/**
 * Locks a key out for progressively longer after each use — 1s, 2s, 4s, and so
 * on up to 5 minutes — resetting after an hour of inactivity or an explicit
 * `reset()`. Used per-email on the verify routes so guessing a code gets
 * expensive quickly, while a legitimate user who succeeds clears their counter.
 */
class ThrottlingRateLimiter extends BaseRateLimiter {
  public async consume(key: string) {
    const [allowed, value] = await redis.rateLimitThrottle(
      this.getKey(key),
      Date.now(),
    )

    if (allowed === 0) {
      throw new RateLimitError({ resetsInMs: value })
    }

    return true
  }
}

class RateLimitError extends Error {
  resetsInMs: number

  constructor(opts: { resetsInMs: number }) {
    super('Rate limit exceeded')
    this.name = 'RateLimitError'
    this.resetsInMs = opts.resetsInMs
  }
}

export { BucketRateLimiter, RateLimitError, ThrottlingRateLimiter }
