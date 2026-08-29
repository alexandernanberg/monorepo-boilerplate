import { expect, test } from 'bun:test'
import { runShutdownTasks } from '~/lib/shutdown'

test('closes tasks in registration order', async () => {
  const order: Array<string> = []

  const exitCode = await runShutdownTasks(
    [
      {
        name: 'a',
        close: () => {
          order.push('a')
        },
      },
      {
        name: 'b',
        close: () => {
          order.push('b')
        },
      },
    ],
    1000,
  )

  expect(exitCode).toBe(0)
  expect(order).toEqual(['a', 'b'])
})

test('keeps going if a task throws', async () => {
  const order: Array<string> = []

  const exitCode = await runShutdownTasks(
    [
      {
        name: 'a',
        close: () => {
          throw new Error('nope')
        },
      },
      {
        name: 'b',
        close: () => {
          order.push('b')
        },
      },
    ],
    1000,
  )

  expect(exitCode).toBe(1)
  expect(order).toEqual(['b'])
})

test('times out a hung task and still runs the rest', async () => {
  const order: Array<string> = []

  const exitCode = await runShutdownTasks(
    [
      {
        name: 'a',
        close: () =>
          new Promise(() => {
            /* never settles */
          }),
      },
      {
        name: 'b',
        close: () => {
          order.push('b')
        },
      },
    ],
    200,
  )

  expect(exitCode).toBe(1)
  expect(order).toEqual(['b'])
})

const port = 10_000 + Math.floor(Math.random() * 20_000)
const SERVER_URL = `http://127.0.0.1:${port}/`

/**
 * Exercised against a spawned process rather than in-process, because what is
 * under test is the signal handler and the exit code it produces — neither of
 * which survives being simulated.
 *
 * NODE_ENV=test keeps Redis lazy-connected and the Postgres pool from hanging
 * so this does not need docker-compose up.
 */
test('SIGTERM closes the server and exits cleanly', async () => {
  const proc = Bun.spawn(['bun', 'src/server.ts'], {
    stdout: 'ignore',
    stderr: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
    },
  })

  try {
    await waitForServer()

    const res = await fetch(SERVER_URL)
    expect(await res.text()).toBe('OK')

    proc.kill('SIGTERM')

    expect(await proc.exited).toBe(0)
    // The port is released only because the server stopped listening, rather
    // than the process being killed out from under it.
    expect(await isReachable()).toBe(false)
  } finally {
    proc.kill('SIGKILL')
  }
}, 30_000)

async function isReachable() {
  try {
    await fetch(SERVER_URL, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

async function waitForServer() {
  const maxRetries = 40
  const delay = 250
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (await isReachable()) {
      return
    }
    if (attempt === maxRetries) {
      throw new Error('Server did not start in time.')
    }
    await new Promise((res) => {
      setTimeout(res, delay)
    })
  }
}
