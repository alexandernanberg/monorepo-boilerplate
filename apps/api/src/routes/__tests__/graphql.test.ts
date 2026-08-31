import { faker } from '@faker-js/faker'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  getRequestEnv,
  resetDatabase,
  TestRequest,
} from '~/__tests__/test-utils'
import { app } from '~/app'
import { config } from '~/config'
import { db } from '~/db'
import { usersTable } from '~/db/schema'
import { redis } from '~/lib/redis'
import { createSession, createSessionToken } from '~/services/session'

beforeEach(async () => {
  await Promise.all([redis.flushall(), resetDatabase()])
})

afterEach(() => {
  config.GRAPHIQL_ENABLED = true
  config.GRAPHQL_MAX_DEPTH = 12
})

async function seedSignedInUser() {
  const user = await db
    .insert(usersTable)
    .values({
      email: faker.internet.email().toLowerCase(),
      emailVerified: true,
    })
    .returning()
    .then((res) => res[0]!)

  const token = createSessionToken()
  await createSession(token, user.id, faker.internet.ipv4(), 'test')

  return { user, token }
}

interface GraphQLBody<TData> {
  data?: TData
  errors?: Array<{ message: string; extensions: Record<string, unknown> }>
}

async function graphql<TData = Record<string, unknown>>(
  query: string,
  token?: string,
) {
  const request = TestRequest.json('/graphql', 'POST', { query })
  request.headers.set('origin', 'http://localhost')
  if (token) request.headers.set('authorization', `Bearer ${token}`)

  const res = await app.fetch(request, getRequestEnv())

  return { res, body: (await res.json()) as GraphQLBody<TData> }
}

/** The `code` a failed request reported, or undefined if it succeeded. */
function errorCode(body: GraphQLBody<unknown>) {
  return body.errors?.[0]?.extensions['code']
}

describe('POST /graphql', () => {
  test('resolves viewer for a signed-in user', async () => {
    const { user, token } = await seedSignedInUser()

    const { body } = await graphql<{
      viewer: { email: string; databaseId: string }
    }>('{ viewer { email databaseId } }', token)

    expect(body.errors).toBeUndefined()
    expect(body.data?.viewer).toEqual({
      email: user.email,
      databaseId: user.id,
    })
  })

  test('rejects a request with no session', async () => {
    const { body } = await graphql('{ viewer { email } }')

    expect(body.data).toBeUndefined()
    expect(errorCode(body)).toBe('UNAUTHORIZED')
  })

  test('rejects a request with an unknown token', async () => {
    const { body } = await graphql('{ viewer { email } }', createSessionToken())

    expect(errorCode(body)).toBe('INVALID_SESSION')
  })

  /**
   * A soft-deleted account keeps its sessions, so authentication has to check
   * `deletedAt` — the loaders that serve every other user already do.
   */
  test('rejects a session belonging to a soft-deleted user', async () => {
    const { token } = await seedSignedInUser()

    await db.update(usersTable).set({ deletedAt: sql`now()` })

    const { body } = await graphql('{ viewer { email } }', token)

    expect(errorCode(body)).toBe('INVALID_SESSION')
  })

  test('reports a parse error as the client’s mistake, not a 500', async () => {
    const { body } = await graphql(
      '{ viewer {',
      (await seedSignedInUser()).token,
    )

    expect(errorCode(body)).toBe('GRAPHQL_PARSE_FAILED')
  })

  /**
   * Uses a query string no other test sends: Yoga caches validation results per
   * document, so a query already validated under the default limit would skip
   * the rule entirely. That caching is correct in production, where the limit
   * is fixed for the life of the process — it only bites a test that moves it.
   */
  test('rejects a query nested past the depth limit', async () => {
    const { token } = await seedSignedInUser()
    config.GRAPHQL_MAX_DEPTH = 1

    const { body } = await graphql('{ viewer { familyName } }', token)

    expect(errorCode(body)).toBe('GRAPHQL_MAX_DEPTH_EXCEEDED')
  })

  test('allows introspection while GraphiQL is enabled', async () => {
    const { token } = await seedSignedInUser()
    config.GRAPHIQL_ENABLED = true

    const { body } = await graphql<{
      __schema: { queryType: { name: string } }
    }>('{ __schema { queryType { name } } }', token)

    expect(body.errors).toBeUndefined()
    expect(body.data?.__schema.queryType.name).toBe('Query')
  })

  /** Introspection publishes the whole schema, so it follows the same switch. */
  test('blocks introspection when GraphiQL is disabled', async () => {
    const { token } = await seedSignedInUser()
    config.GRAPHIQL_ENABLED = false

    const { body } = await graphql('{ __schema { queryType { name } } }', token)

    expect(body.errors).toBeDefined()
    expect(body.data).toBeUndefined()
  })

  test('rate limits by IP', async () => {
    const { token } = await seedSignedInUser()
    const ip = '203.0.113.77'

    const send = async () => {
      const request = TestRequest.json('/graphql', 'POST', {
        query: '{ viewer { email } }',
      })
      request.headers.set('origin', 'http://localhost')
      request.headers.set('authorization', `Bearer ${token}`)

      return await app.fetch(request, getRequestEnv(ip))
    }

    const budget = config.RATE_LIMIT_IP_BUCKET_SIZE * 10
    for (let attempt = 0; attempt < budget; attempt++) {
      await send()
    }

    const res = await send()

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
    )
  })
})

describe('request limits', () => {
  test('refuses a body over the size limit', async () => {
    const request = TestRequest.json('/auth/signup', 'POST', {
      email: faker.internet.email(),
      padding: 'x'.repeat(config.MAX_REQUEST_BODY_BYTES + 1),
    })
    request.headers.set('origin', 'http://localhost')

    const res = await app.fetch(request, getRequestEnv())

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    )
  })
})

describe('CSRF protection', () => {
  /**
   * Regression: Hono's `csrf()` reads a missing `Content-Type` as `text/plain`
   * and so as a form post. `POST /auth/logout` carries no body and therefore no
   * content-type, which made logout fail with 403 for every client that does
   * not send `Origin` — a mobile app, a CLI, anything server-to-server — while
   * leaving the session it thought it had ended live.
   */
  test('allows a bodyless request with no content-type or origin', async () => {
    const { token } = await seedSignedInUser()

    const res = await app.fetch(
      new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(204)

    // And the session is actually gone.
    const after = await app.fetch(
      new Request('http://localhost/auth/session', {
        headers: { authorization: `Bearer ${token}` },
      }),
      getRequestEnv(),
    )

    expect(after.status).toBe(401)
  })

  /** The exemption above must not extend to anything a form could actually send. */
  test('still blocks a cross-origin form post', async () => {
    const res = await app.fetch(
      new Request('http://localhost/auth/signup', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
        },
        body: 'email=attacker@example.com',
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(403)
  })

  test('still blocks a cross-origin form post with an empty body', async () => {
    const res = await app.fetch(
      new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
        },
        body: '',
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(403)
  })

  test('allows a same-origin form post', async () => {
    const res = await app.fetch(
      new Request('http://localhost/auth/signup', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://localhost',
        },
        body: 'email=someone@example.com',
      }),
      getRequestEnv(),
    )

    // Passes CSRF, then rejected by the handler's own JSON requirement.
    expect(res.status).toBe(400)
  })
})
