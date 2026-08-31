import type { Context } from 'hono'
import { getConnInfo } from 'hono/bun'
import { z } from 'zod'
import { config } from '~/config'
import { ServerError } from '~/lib/server-error'

export function safeJSONParse(str: string) {
  try {
    return JSON.parse(str) as unknown
  } catch {
    return null
  }
}

const ipAddress = z.union([z.ipv4(), z.ipv6()])

/**
 * Normalize one entry from a forwarded-for header.
 *
 * Proxies are inconsistent about ports: `1.2.3.4`, `1.2.3.4:51234` and
 * `[2001:db8::1]:51234` all show up. The `inet` columns and the rate-limit keys
 * want the bare address.
 */
function parseForwardedAddress(value: string) {
  let candidate = value.trim()

  // `[2001:db8::1]:51234` or `[2001:db8::1]`
  const bracketed = /^\[(?<address>.+)](?::\d+)?$/.exec(candidate)
  if (bracketed?.groups) {
    candidate = bracketed.groups['address'] ?? candidate
  } else if (candidate.split(':').length === 2) {
    // Exactly one colon means IPv4:port. A bare IPv6 address has more.
    candidate = candidate.slice(0, candidate.indexOf(':'))
  }

  const result = ipAddress.safeParse(candidate)

  return result.success ? result.data : null
}

/**
 * The address of the client that actually made the request.
 *
 * `getConnInfo` reports the TCP peer, which behind a proxy is the proxy — every
 * request then shares one rate-limit bucket and every stored `ipAddress` is the
 * load balancer. So when `TRUST_PROXY` is set the forwarded headers win.
 *
 * Trusting them is only safe *behind* a proxy that overwrites them. Exposed
 * directly, `X-Forwarded-For` is client-controlled: anyone could mint a fresh
 * IP per request and never hit a limit. Hence the opt-in, defaulting to off.
 *
 * `TRUST_PROXY` means exactly one trusted hop, so the *last* `X-Forwarded-For`
 * entry is used: each proxy appends the address it received the connection
 * from, making the rightmost one the only entry our own proxy vouches for.
 * Anything to its left was supplied by the caller. `Fly-Client-IP` is preferred
 * where present since Fly sets it to the real client and it cannot be appended
 * to.
 */
export function getRequestIp(ctx: Context) {
  if (config.TRUST_PROXY) {
    const flyClientIp = ctx.req.header('fly-client-ip')
    if (flyClientIp) {
      const parsed = parseForwardedAddress(flyClientIp)
      if (parsed) return parsed
    }

    const forwardedFor = ctx.req.header('x-forwarded-for')
    if (forwardedFor) {
      const hops = forwardedFor.split(',')
      const parsed = parseForwardedAddress(hops[hops.length - 1] ?? '')
      if (parsed) return parsed
    }
  }

  const ip = getConnInfo(ctx).remote.address

  if (!ip) {
    throw new ServerError(400, 'MISSING_IP', 'Client IP address is required')
  }

  return ip
}
