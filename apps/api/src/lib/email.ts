import { createTransport } from 'nodemailer'
import { config, env } from '~/config'

const implicitTls = config.SMTP_PORT === 465

export const emailClient = createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  // 465 is implicit TLS. 587 uses STARTTLS when SMTP_TLS is set.
  secure: implicitTls,
  requireTLS: config.SMTP_TLS && !implicitTls,
  auth:
    env === 'production'
      ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
      : undefined,
})
