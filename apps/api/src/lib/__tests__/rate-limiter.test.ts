import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import {
  BucketRateLimiter,
  RateLimitError,
  ThrottlingRateLimiter,
} from '~/lib/rate-limiter'
import { redis } from '~/lib/redis'

beforeEach(async () => {
  setSystemTime()
  await redis.flushall()
})

/** `true` when allowed, the retry delay in ms when rate limited. */
async function consume(limiter: BucketRateLimiter, key: string, cost = 1) {
  try {
    await limiter.consume(key, cost)
    return true
  } catch (error) {
    if (error instanceof RateLimitError) return error.resetsInMs
    throw error
  }
}

describe('BucketRateLimiter', () => {
  test('allows a burst up to the bucket size, then rejects', async () => {
    const limiter = new BucketRateLimiter('test_burst', {
      size: 3,
      refillRateSeconds: 1,
    })
    setSystemTime(new Date())

    expect(await consume(limiter, 'a')).toBe(true)
    expect(await consume(limiter, 'a')).toBe(true)
    expect(await consume(limiter, 'a')).toBe(true)
    expect(await consume(limiter, 'a')).toBe(1000)
  })

  test('refills one token per interval', async () => {
    const now = new Date()
    const limiter = new BucketRateLimiter('test_refill', {
      size: 2,
      refillRateSeconds: 10,
    })

    setSystemTime(now)
    expect(await consume(limiter, 'a')).toBe(true)
    expect(await consume(limiter, 'a')).toBe(true)
    expect(await consume(limiter, 'a')).not.toBe(true)

    // Half an interval buys nothing...
    setSystemTime(new Date(now.getTime() + 5_000))
    expect(await consume(limiter, 'a')).not.toBe(true)

    // ...a whole one buys exactly one token.
    setSystemTime(new Date(now.getTime() + 10_000))
    expect(await consume(limiter, 'a')).toBe(true)
    expect(await consume(limiter, 'a')).not.toBe(true)
  })

  /**
   * Regression: the refill clock used to be reset to the current time on every
   * allowed call, so a caller arriving faster than the refill interval kept
   * discarding the progress it had made and never earned a token back.
   */
  test('carries partial progress across calls that are allowed', async () => {
    const now = new Date()
    const limiter = new BucketRateLimiter('test_drift', {
      size: 4,
      refillRateSeconds: 2,
    })

    // One call per second against a bucket that refills every two.
    const results: Array<boolean | number> = []
    for (let second = 0; second < 8; second++) {
      setSystemTime(new Date(now.getTime() + second * 1000))
      results.push(await consume(limiter, 'a'))
    }

    // 4 from the bucket plus 3 refilled over the 7 seconds that elapse.
    expect(results.filter((result) => result === true)).toHaveLength(7)
  })

  /**
   * Regression: the key used to expire one refill interval after it was
   * created and was never extended, so the bucket vanished and came back full
   * instead of refilling a token at a time.
   *
   * Asserted on the TTL rather than by waiting, because `setSystemTime` moves
   * `Date`, not Redis's expiry clock — a mocked test cannot observe the key
   * disappearing.
   */
  test('keeps the key alive until the bucket would be full', async () => {
    const limiter = new BucketRateLimiter('test_ttl', {
      size: 3,
      refillRateSeconds: 5,
    })
    setSystemTime(new Date())

    await consume(limiter, 'a')
    // One token spent, so five seconds until the bucket is whole again.
    expect(await redis.pttl('rate_limit:test_ttl:a')).toBeLessThanOrEqual(5_000)

    await consume(limiter, 'a')
    await consume(limiter, 'a')
    // Empty: the key has to outlive the full refill, or it expires and the
    // caller silently gets a fresh bucket.
    expect(await redis.pttl('rate_limit:test_ttl:a')).toBeGreaterThan(10_000)
  })

  test('refills against real elapsed time rather than resetting', async () => {
    const limiter = new BucketRateLimiter('test_expiry', {
      size: 2,
      refillRateSeconds: 1,
    })

    // Deliberately unmocked: this exercises Redis's own expiry, which a frozen
    // `Date` cannot reach.
    setSystemTime()

    expect(await consume(limiter, 'a')).toBe(true)
    expect(await consume(limiter, 'a')).toBe(true)
    expect(await consume(limiter, 'a')).not.toBe(true)

    await new Promise((resolve) => {
      setTimeout(resolve, 1_100)
    })

    // Exactly one token back — not a whole new bucket.
    expect(await consume(limiter, 'a')).toBe(true)
    expect(await consume(limiter, 'a')).not.toBe(true)
  })

  test('keeps separate buckets per key', async () => {
    const limiter = new BucketRateLimiter('test_keys', {
      size: 1,
      refillRateSeconds: 60,
    })
    setSystemTime(new Date())

    expect(await consume(limiter, 'a')).toBe(true)
    expect(await consume(limiter, 'a')).not.toBe(true)
    expect(await consume(limiter, 'b')).toBe(true)
  })

  test('reports how long until the next token', async () => {
    const limiter = new BucketRateLimiter('test_retry', {
      size: 1,
      refillRateSeconds: 30,
    })
    setSystemTime(new Date())

    await consume(limiter, 'a')

    expect(await consume(limiter, 'a')).toBe(30_000)
  })

  test('charges the given cost', async () => {
    const limiter = new BucketRateLimiter('test_cost', {
      size: 5,
      refillRateSeconds: 1,
    })
    setSystemTime(new Date())

    expect(await consume(limiter, 'a', 4)).toBe(true)
    expect(await consume(limiter, 'a', 2)).not.toBe(true)
    expect(await consume(limiter, 'a', 1)).toBe(true)
  })

  test('reset empties the bucket', async () => {
    const limiter = new BucketRateLimiter('test_reset', {
      size: 1,
      refillRateSeconds: 60,
    })
    setSystemTime(new Date())

    await consume(limiter, 'a')
    expect(await consume(limiter, 'a')).not.toBe(true)

    await limiter.reset('a')

    expect(await consume(limiter, 'a')).toBe(true)
  })

  /**
   * A Redis restart or failover empties the script cache. The limiter used to
   * hold a SHA forever and call `evalsha`, so every request through it failed
   * with `NOSCRIPT` until the process was restarted.
   */
  test('survives the script cache being flushed', async () => {
    const limiter = new BucketRateLimiter('test_noscript', {
      size: 5,
      refillRateSeconds: 1,
    })
    setSystemTime(new Date())

    expect(await consume(limiter, 'a')).toBe(true)

    await redis.script('FLUSH')

    expect(await consume(limiter, 'a')).toBe(true)
  })
})

describe('ThrottlingRateLimiter', () => {
  test('locks out for progressively longer', async () => {
    const now = new Date()
    const limiter = new ThrottlingRateLimiter('test_throttle')

    const attempt = async () => {
      try {
        await limiter.consume('a')
        return true
      } catch (error) {
        if (error instanceof RateLimitError) return error.resetsInMs
        throw error
      }
    }

    setSystemTime(now)
    expect(await attempt()).toBe(true)

    // 1s lockout, then 2s, then 4s.
    expect(await attempt()).toBe(1000)
    setSystemTime(new Date(now.getTime() + 1_000))
    expect(await attempt()).toBe(true)

    expect(await attempt()).toBe(2000)
    setSystemTime(new Date(now.getTime() + 3_000))
    expect(await attempt()).toBe(true)

    expect(await attempt()).toBe(4000)
  })

  test('reset clears the lockout', async () => {
    const limiter = new ThrottlingRateLimiter('test_throttle_reset')
    setSystemTime(new Date())

    await limiter.consume('a')
    expect(limiter.consume('a')).rejects.toThrow(RateLimitError)

    await limiter.reset('a')

    expect(await limiter.consume('a')).toBe(true)
  })
})
