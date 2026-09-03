import { log } from 'evlog'
import { config } from '~/config'

type ShutdownTask = {
  name: string
  close: () => Promise<unknown> | void
}

const tasks: Array<ShutdownTask> = []

let shuttingDown = false

/**
 * Register something to close when the process is asked to exit.
 *
 * Tasks run one at a time, in the order they were registered, so register
 * them outside-in: the HTTP server first, then whatever its handlers use. A
 * request that is still draining needs its database connection to outlive it.
 */
function onShutdown(name: string, close: () => Promise<unknown> | void) {
  tasks.push({ name, close })
}

/**
 * Start listening for the signals a supervisor uses to ask for a clean exit —
 * `SIGTERM` from Docker and Kubernetes, `SIGINT` from Ctrl-C.
 *
 * Without a handler the process dies mid-request, and as PID 1 (which is what
 * the container's `CMD` makes it) it ignores the signal entirely and waits to
 * be `SIGKILL`ed.
 *
 * Only the first signal starts a shutdown. A second one is taken to mean "stop
 * waiting", which is what a second Ctrl-C expects.
 */
function listenForShutdownSignals() {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        process.exit(1)
      }

      shuttingDown = true
      void shutdown(signal)
    })
  }
}

async function shutdown(signal: string) {
  log.info('shutdown', `Received ${signal}, closing down`)

  const exitCode = await runShutdownTasks(
    tasks,
    config.SHUTDOWN_TIMEOUT_SECONDS * 1000,
  )

  log.info('shutdown', 'Closed down')
  process.exit(exitCode)
}

/**
 * Close each task in order. A hung or throwing close is skipped so the ones
 * behind it still run — each call is raced against the time left on the clock.
 */
async function runShutdownTasks(
  queued: readonly ShutdownTask[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  let exitCode = 0

  for (const task of queued) {
    try {
      // Sequential on purpose: registration order is teardown order.
      // oxlint-disable-next-line no-await-in-loop
      await Promise.race([
        Promise.resolve(task.close()),
        Bun.sleep(Math.max(deadline - Date.now(), 0)).then(() => {
          throw new Error('timed out')
        }),
      ])
    } catch (error) {
      exitCode = 1
      log.error(
        'shutdown',
        `Failed to close ${task.name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return exitCode
}

export { listenForShutdownSignals, onShutdown, runShutdownTasks }
