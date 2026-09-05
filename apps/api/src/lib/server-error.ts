import { GraphQLError } from 'graphql'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'

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

    if (error instanceof HTTPException) {
      if (error.status >= 400 && error.status < 500) {
        const message = error.message || undefined
        switch (error.status) {
          case 400:
            return new BadRequestError(message)
          case 401:
            return new UnauthorizedError(message)
          case 403:
            return new ForbiddenError(message)
          case 404:
            return new NotFoundError(message)
          case 409:
            return new ConflictError(message)
          default:
            return new ServerError(
              error.status,
              'HTTP_ERROR',
              message ?? 'Request failed',
            )
        }
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
