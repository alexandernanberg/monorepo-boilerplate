import nodemailer from 'nodemailer'
import { config, env } from '~/config'

export const emailClient = nodemailer.createTransport({
  host: config.SMTP_HOST,
  secure: config.SMTP_TLS,
  port: config.SMTP_PORT,
  auth:
    env === 'production'
      ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
      : undefined,
})
