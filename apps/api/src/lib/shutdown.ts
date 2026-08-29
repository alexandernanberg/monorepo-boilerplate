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
 * `SIGTERM` from Docker, Kubernetes and Fly, `SIGINT` from Ctrl-C.
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

  // Supervisors send `SIGKILL` if the process outstays its grace period, so
  // exit on our own terms first — a connection that never closes should not
  // cost the tasks behind it their chance to run. Keep this below the
  // platform's own timeout (`kill_timeout` on Fly,
  // `terminationGracePeriodSeconds` on Kubernetes).
  const timeout = setTimeout(() => {
    log.error(
      'shutdown',
      `Still closing after ${config.SHUTDOWN_TIMEOUT_SECONDS}s, exiting now`,
    )
    process.exit(1)
  }, config.SHUTDOWN_TIMEOUT_SECONDS * 1000)

  let exitCode = 0

  for (const task of tasks) {
    try {
      // Sequential on purpose: registration order is teardown order, and a
      // task may still be in use by the one before it.
      // oxlint-disable-next-line no-await-in-loop
      await task.close()
    } catch (error) {
      // One resource refusing to close is not a reason to leak the rest, so
      // record it and keep going.
      exitCode = 1
      log.error(
        'shutdown',
        `Failed to close ${task.name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  clearTimeout(timeout)

  log.info('shutdown', 'Closed down')

  process.exit(exitCode)
}

export { listenForShutdownSignals, onShutdown }
