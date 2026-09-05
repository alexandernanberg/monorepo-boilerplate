import { faker } from '@faker-js/faker'
import { db } from '~/db'

class TestRequest extends Request {
  constructor(url: string, method: string, opts?: RequestInit) {
    super(`http://localhost${url}`, {
      ...opts,
      method,
    })
  }

  session(sessionToken: string) {
    this.headers.append('authorization', `Bearer ${sessionToken}`)
    this.headers.append('origin', `http://localhost`)
    return this
  }

  static json(url: string, method: string, body: unknown) {
    return new TestRequest(url, method, {
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify(body),
    })
  }
}

async function resetDatabase() {
  await db.execute(`
    DO $$ 
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `)
}

// https://github.com/honojs/hono/issues/3460
function getRequestEnv(ip = faker.internet.ipv4()) {
  return {
    requestIP: () => ({
      address: ip,
      family: 'IPv4',
      port: 443,
    }),
  }
}

interface MailpitGetMessagesResponse {
  total: number
  unread: number
  count: number
  messages_count: number
  start: number
  tags: Array<string>
  messages: Array<{
    ID: string
    MessageID: string
    Read: boolean
    From: {
      Name: string
      Address: string
    }
    To: Array<{
      Name: string
      Address: string
    }>
    Cc: []
    Bcc: []
    ReplyTo: []
    Subject: string
    Created: string
    Tags: []
    Size: number
    Attachments: number
    Snippet: string
  }>
}

const mailpit = {
  API_URL: 'http://0.0.0.0:8026/api/v1',

  async getMessages() {
    const res = await fetch(`${this.API_URL}/messages`)
    const json = (await res.json()) as MailpitGetMessagesResponse
    return json
  },

  async resetMessages() {
    await fetch(`${this.API_URL}/messages`, { method: 'DELETE' })
  },

  async getInbox(email: string) {
    const { messages } = await this.getMessages()
    const inbox = messages.filter((msg) =>
      msg.To.some((to) => to.Address === email),
    )
    return inbox
  },

  async getMessage(id: string) {
    const res = await fetch(`${this.API_URL}/message/${id}`)
    return (await res.json()) as {
      Subject: string
      Text: string
      HTML: string
      Snippet: string
    }
  },
}

export { getRequestEnv, mailpit, resetDatabase, TestRequest }
