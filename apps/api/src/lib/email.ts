import { createTransport } from 'nodemailer'
import { config } from '~/config'

const implicitTls = config.SMTP_PORT === 465

export const emailClient = createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  // 465 is implicit TLS. 587 uses STARTTLS when SMTP_TLS is set.
  secure: implicitTls,
  requireTLS: config.SMTP_TLS && !implicitTls,
  // Only when credentials are configured. Nodemailer treats `{ user: '' }` as
  // credentials and sends an empty AUTH LOGIN, which an unauthenticated relay
  // (Mailpit, an IP-allowlisted SES endpoint) rejects.
  auth: config.SMTP_USER
    ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
    : undefined,
})
