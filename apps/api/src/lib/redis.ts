import Redis from 'ioredis'
import { config, env } from '~/config'

const redis = new Redis({
  host: config.REDIS_HOST,
  username: config.REDIS_USER,
  password: config.REDIS_PASSWORD,
  port: config.REDIS_PORT,
  lazyConnect: env === 'test',
})

export { redis }
