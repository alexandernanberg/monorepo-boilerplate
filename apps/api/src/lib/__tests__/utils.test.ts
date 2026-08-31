import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { getRequestEnv } from '~/__tests__/test-utils'
import { config } from '~/config'
import { getRequestIp, safeJSONParse } from '~/lib/utils'

const app = new Hono()
app.get('/ip', (ctx) => ctx.text(getRequestIp(ctx)))

/** The address the socket reports, i.e. the proxy when there is one. */
const PEER = '198.51.100.7'

async function requestIp(headers: Record<string, string> = {}) {
  const res = await app.fetch(
    new Request('http://localhost/ip', { headers }),
    getRequestEnv(PEER),
  )

  return await res.text()
}

afterEach(() => {
  config.TRUST_PROXY = false
})

describe('getRequestIp', () => {
  test('uses the socket address when no proxy is trusted', async () => {
    expect(await requestIp()).toBe(PEER)
  })

  /**
   * The headers are client-controlled unless something upstream overwrites
   * them. Believing them by default would let anyone mint a fresh address per
   * request and never reach a rate limit.
   */
  test('ignores forwarded headers when no proxy is trusted', async () => {
    expect(
      await requestIp({
        'x-forwarded-for': '203.0.113.9',
        'fly-client-ip': '203.0.113.8',
      }),
    ).toBe(PEER)
  })

  test('prefers Fly-Client-IP when a proxy is trusted', async () => {
    config.TRUST_PROXY = true

    expect(
      await requestIp({
        'fly-client-ip': '203.0.113.8',
        'x-forwarded-for': '203.0.113.9',
      }),
    ).toBe('203.0.113.8')
  })

  /**
   * Each hop appends the address it received the connection from, so with one
   * trusted proxy the rightmost entry is the only one it vouches for. Anything
   * to its left came from the caller.
   */
  test('takes the last X-Forwarded-For hop', async () => {
    config.TRUST_PROXY = true

    expect(
      await requestIp({ 'x-forwarded-for': '10.0.0.1, 203.0.113.4' }),
    ).toBe('203.0.113.4')
  })

  test('strips a port from a forwarded address', async () => {
    config.TRUST_PROXY = true

    expect(await requestIp({ 'x-forwarded-for': '203.0.113.4:51234' })).toBe(
      '203.0.113.4',
    )
  })

  test('handles a bracketed IPv6 address', async () => {
    config.TRUST_PROXY = true

    expect(await requestIp({ 'x-forwarded-for': '[2001:db8::1]:51234' })).toBe(
      '2001:db8::1',
    )
  })

  test('handles a bare IPv6 address', async () => {
    config.TRUST_PROXY = true

    expect(await requestIp({ 'x-forwarded-for': '2001:db8::1' })).toBe(
      '2001:db8::1',
    )
  })

  /**
   * A malformed header must not reach the `inet` columns or become a
   * rate-limit key of its own.
   */
  test('falls back to the socket address on a malformed header', async () => {
    config.TRUST_PROXY = true

    expect(await requestIp({ 'x-forwarded-for': 'not-an-ip' })).toBe(PEER)
  })

  test('falls back to X-Forwarded-For when Fly-Client-IP is malformed', async () => {
    config.TRUST_PROXY = true

    expect(
      await requestIp({
        'fly-client-ip': 'garbage',
        'x-forwarded-for': '203.0.113.4',
      }),
    ).toBe('203.0.113.4')
  })
})

describe('safeJSONParse', () => {
  test('parses valid JSON', () => {
    expect(safeJSONParse('{"a":1}')).toEqual({ a: 1 })
  })

  test('returns null rather than throwing on invalid JSON', () => {
    expect(safeJSONParse('{')).toBeNull()
  })
})
