import type { Context } from 'hono'
import { getConnInfo } from 'hono/bun'
import { ServerError } from '~/lib/server-error'

export function safeJSONParse(str: string) {
  try {
    return JSON.parse(str) as unknown
  } catch {
    return null
  }
}

export function getRequestIp(ctx: Context) {
  const ip = getConnInfo(ctx).remote.address

  if (!ip) {
    throw new ServerError(400, 'MISSING_IP', 'Client IP address is required')
  }

  return ip
}
