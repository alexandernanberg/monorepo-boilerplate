import { redis } from '~/lib/redis'

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

class BucketRateLimiter extends BaseRateLimiter {
  private scriptSha: string | null = null
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

  private async init() {
    this.scriptSha = (await redis.script(
      'LOAD',
      `-- Returns {1} if allowed, or {0, pttl} if not allowed
      local key                   = KEYS[1]
      local max                   = tonumber(ARGV[1])
      local refillIntervalSeconds = tonumber(ARGV[2])
      local cost                  = tonumber(ARGV[3])
      local now                   = tonumber(ARGV[4]) -- Current unix time in seconds

      -- Get 'count' and 'refilled_at' values directly
      local count, refilledAt = unpack(redis.call("HMGET", key, "count", "refilled_at"))

      if not count then
        -- First time access, initialize bucket
        count = max - cost
        refilledAt = now
        redis.call("HMSET", key, "count", count, "refilled_at", refilledAt)
        redis.call("EXPIRE", key, refillIntervalSeconds)
        return {1}
      end

      -- Calculate refill tokens
      count = tonumber(count)
      refilledAt = tonumber(refilledAt)
      local refill = math.floor((now - refilledAt) / refillIntervalSeconds)
      count = math.min(count + refill, max)
      refilledAt = now

      if count < cost then
        local ttl = redis.call("PTTL", key)
        if ttl == -1 then
          ttl = refillIntervalSeconds * 1000
          redis.call("PEXPIRE", key, ttl)
        end
        return {0, ttl}
      end

      -- Consume tokens and update
      count = count - cost
      redis.call("HMSET", key, "count", count, "refilled_at", refilledAt)

      -- Ensure key has an expiration time
      if redis.call("TTL", key) == -1 then
        redis.call("EXPIRE", key, refillIntervalSeconds)
      end

      return {1}`,
    )) as string
  }

  public async consume(key: string, cost: number) {
    if (this.scriptSha === null) {
      await this.init()
    }

    const result = (await redis.evalsha(
      this.scriptSha!,
      1,
      this.getKey(key),
      this.size,
      this.refillRateSeconds,
      cost,
      Math.floor(Date.now() / 1000),
    )) as [1] | [0, number | null]

    if (result[0] === 0) {
      const resetsInMs = result[1] ?? this.refillRateSeconds * 1000
      throw new RateLimitError({ resetsInMs })
    }

    return true
  }
}

class ThrottlingRateLimiter extends BaseRateLimiter {
  private scriptSha: string | null = null

  async init() {
    this.scriptSha = (await redis.script(
      'LOAD',
      `-- Returns {1} if allowed, {0, ttl} if not allowed
      local key = KEYS[1]
      local now = tonumber(ARGV[1])

      -- Array defining the timeout in seconds for each rate-limit level
      local timeoutSeconds = {1, 2, 4, 8, 16, 30, 60, 180, 300}
      local inactivityResetThreshold = 3600

      -- Retrieve all fields from the hash
      local fields = redis.call("HGETALL", key)

      -- If the key does not exist, initialize it
      if #fields == 0 then
        redis.call("HSET", key, "index", 1, "updated_at", now)
        redis.call("EXPIRE", key, inactivityResetThreshold)
        return {1}
      end

      -- Extract 'index' and 'updated_at' values from fields
      local index = 0
      local updatedAt = 0
      for i = 1, #fields, 2 do
        if fields[i] == "index" then
          index = tonumber(fields[i + 1])
        elseif fields[i] == "updated_at" then
          updatedAt = tonumber(fields[i + 1])
        end
      end

      -- Calculate elapsed time since the key was last updated
      local elapsed = now - updatedAt

      -- Determine if the current lockout period has expired
      local allowed = elapsed >= timeoutSeconds[index]
      if not allowed then
        -- Calculate the remaining TTL in milliseconds until rate limit resets
        local ttl = (timeoutSeconds[index] * 1000) - (elapsed * 1000)
        return {0, ttl}
      end

      -- Lockout has expired, increment the index for the next lockout period
      index = math.min(index + 1, #timeoutSeconds)

      -- Update 'index' and 'updated_at' values for the key
      redis.call("HSET", key, "index", index, "updated_at", now)
      redis.call("EXPIRE", key, inactivityResetThreshold)

      return {1}`,
    )) as string
  }

  public async consume(key: string) {
    if (this.scriptSha === null) {
      await this.init()
    }

    const result = (await redis.evalsha(
      this.scriptSha!,
      1,
      this.getKey(key),
      Math.floor(Date.now() / 1000),
    )) as [1] | [0, number | null]

    if (result[0] === 0) {
      const resetsInMs = result[1] ?? 0
      throw new RateLimitError({ resetsInMs })
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
