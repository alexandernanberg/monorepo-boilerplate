import { describe, expect, test } from 'bun:test'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { RateLimitError } from '~/lib/rate-limiter'
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServerError,
} from '~/lib/server-error'

describe('ServerError.from', () => {
  test('passes a ServerError through unchanged', () => {
    const error = new NotFoundError('Nope')

    expect(ServerError.from(error)).toBe(error)
  })

  test('maps a ZodError to a 422 with per-field details', async () => {
    const result = z.object({ email: z.email() }).safeParse({ email: 'nope' })
    const error = ServerError.from(result.error)

    expect(error.statusCode).toBe(422)
    expect(error.code).toBe('VALIDATION_ERROR')

    // Asserted on the wire format: which field failed is the whole point of a
    // 422, and it only reaches the client through the response body.
    const body = (await error.toResponse().json()) as {
      errors: Record<
        string,
        Array<{ code: string; message: string }> | undefined
      >
    }

    expect(body.errors['email']).toBeArray()
  })

  test('maps a RateLimitError to a 429 carrying Retry-After', () => {
    const error = ServerError.from(new RateLimitError({ resetsInMs: 45_000 }))

    expect(error.statusCode).toBe(429)
    expect(error.code).toBe('RATE_LIMIT_EXCEEDED')

    const res = error.toResponse()
    expect(res.headers.get('retry-after')).toBe('45')
  })

  test('rounds Retry-After up so it is never zero', () => {
    const error = ServerError.from(new RateLimitError({ resetsInMs: 1 }))

    expect(error.toResponse().headers.get('retry-after')).toBe('1')
  })

  test('maps a 403 HTTPException to a ForbiddenError', () => {
    const error = ServerError.from(new HTTPException(403))

    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.statusCode).toBe(403)
  })

  /**
   * Anything unrecognised must not leak its message to the client. The original
   * is what gets logged; this is only what goes out on the wire.
   */
  test('collapses an unknown error into a generic 500', () => {
    const error = ServerError.from(
      new Error('connection string: user:hunter2@db'),
    )

    expect(error.statusCode).toBe(500)
    expect(error.code).toBe('INTERNAL_SERVER_ERROR')
    expect(error.message).toBe('Internal server error')
  })

  test('collapses a non-Error throw into a generic 500', () => {
    expect(ServerError.from('boom').statusCode).toBe(500)
  })
})

describe('ServerError serialisation', () => {
  test('renders a JSON body with the code, message and details', async () => {
    const res = new BadRequestError('Bad', 'because').toResponse()

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      code: 'BAD_REQUEST',
      message: 'Bad',
      details: 'because',
    })
  })

  test('carries the code into GraphQL extensions', () => {
    const error = new NotFoundError('Missing').toGraphQLError()

    expect(error.message).toBe('Missing')
    expect(error.extensions['code']).toBe('NOT_FOUND')
  })
})
