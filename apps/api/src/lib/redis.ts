import type { SecondaryStorage } from 'better-auth'
import Redis from 'ioredis'
import { config, env } from '~/config'

const redis = new Redis({
  host: config.REDIS_HOST,
  username: config.REDIS_USER,
  password: config.REDIS_PASSWORD,
  port: config.REDIS_PORT,
  lazyConnect: env === 'test',
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
