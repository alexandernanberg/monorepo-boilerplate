import { GraphQLError } from 'graphql'
import { HTTPException } from 'hono/http-exception'
import ms from 'ms'
import { ZodError } from 'zod'
import { RateLimitError } from '~/lib/rate-limiter'

class ServerError extends Error {
  statusCode: number
  code: string
  message: string
  details: string | null

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: string,
  ) {
    super(message)
    this.statusCode = statusCode
    this.code = code
    this.message = message
    this.details = details ?? null
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    }
  }

  toResponse() {
    return Response.json(this.toJSON(), { status: this.statusCode })
  }

  toGraphQLError() {
    return new GraphQLError(this.message, {
      extensions: {
        code: this.code,
        details: this.details,
      },
    })
  }

  static from(error: unknown) {
    if (error instanceof ServerError) {
      return error
    }

    if (error instanceof ZodError) {
      return new ValidationError(error)
    }

    if (error instanceof RateLimitError) {
      return new TooManyRequests('RATE_LIMIT_EXCEEDED', error.resetsInMs)
    }

    if (error instanceof HTTPException) {
      switch (error.status) {
        case 403:
          return new ForbiddenError()
      }
    }

    return new ServerError(
      500,
      'INTERNAL_SERVER_ERROR',
      'Internal server error',
    )
  }
}

class NotFoundError extends ServerError {
  constructor(message = 'Not found', details?: string) {
    super(404, 'NOT_FOUND', message, details)
  }
}

class UnauthorizedError extends ServerError {
  constructor(message = 'Unauthorized', details?: string) {
    super(401, 'UNAUTHORIZED', message, details)
  }
}

class ForbiddenError extends ServerError {
  constructor(message = 'Forbidden', details?: string) {
    super(403, 'FORBIDDEN', message, details)
  }
}

class ConflictError extends ServerError {
  constructor(message = 'Conflict', details?: string) {
    super(409, 'CONFLICT', message, details)
  }
}

class BadRequestError extends ServerError {
  constructor(message = 'Bad request', details?: string) {
    super(400, 'BAD_REQUEST', message, details)
  }
}

class TooManyRequests extends ServerError {
  resetsInMs: number

  constructor(code = 'TOO_MANY_REQUESTS', resetsInMs: number) {
    super(
      429,
      code,
      `Too many requests. Try again in ${ms(resetsInMs, { long: true })}.`,
    )
    this.resetsInMs = resetsInMs
  }

  toResponse() {
    const retryAfter = Math.ceil(this.resetsInMs / 1000)

    return Response.json(this.toJSON(), {
      status: this.statusCode,
      headers: { 'Retry-After': retryAfter.toString() },
    })
  }
}

class ValidationError extends ServerError {
  errors: Record<string, Array<{ code: string; message: string }> | undefined>

  constructor(error: ZodError) {
    super(422, 'VALIDATION_ERROR', 'Validation error')

    this.errors = error.flatten((issue) => ({
      code: issue.code,
      message: issue.message,
    })).fieldErrors
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      errors: this.errors,
    }
  }
}

export {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServerError,
  UnauthorizedError,
}
