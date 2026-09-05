import type { SecondaryStorage } from 'better-auth'
import { log } from 'evlog'
import Redis from 'ioredis'
import { config, env } from '~/config'

const redisOptions = {
  lazyConnect: env === 'test',
  connectTimeout: env === 'test' ? 1000 : undefined,
  maxRetriesPerRequest: env === 'test' ? 1 : undefined,
  retryStrategy: env === 'test' ? () => null : undefined,
}

const redis = config.REDIS_URL
  ? new Redis(config.REDIS_URL, redisOptions)
  : new Redis({
      host: config.REDIS_HOST,
      username: config.REDIS_USER || undefined,
      password: config.REDIS_PASSWORD || undefined,
      port: config.REDIS_PORT,
      ...redisOptions,
    })

redis.on('error', (error) => {
  log.error('redis', error.message)
})

const redisStorage: SecondaryStorage = {
  get: (key) => redis.get(key),
  getAndDelete: (key) => redis.getdel(key),
  set: (key, value, ttl) =>
    ttl ? redis.set(key, value, 'EX', ttl) : redis.set(key, value),
  delete: async (key) => {
    await redis.del(key)
  },
  async increment(key, ttl) {
    const results = await redis.multi().incr(key).expire(key, ttl, 'NX').exec()
    const value = results?.[0]?.[1]
    if (typeof value !== 'number') {
      throw new Error('Redis increment failed')
    }
    return value
  },
}

export { redis, redisStorage }
