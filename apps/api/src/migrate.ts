import { log } from 'evlog'
import { assertConfigIsValid } from '~/config'
import { client, upgradeDatabase } from '~/db'

/**
 * Standalone migration entrypoint, bundled next to `server.js`.
 *
 * Kept separate from the server so migrations can run as their own step — a
 * Fly `release_command`, a Kubernetes init container, a one-off `docker run` —
 * where exactly one process applies them and a failure stops the deploy before
 * any new instance starts serving. `MIGRATE_ON_START` covers the single-instance
 * case where that ceremony is not worth it.
 */
assertConfigIsValid()

try {
  log.info('migrate', 'Running database migrations')
  await upgradeDatabase()
  log.info('migrate', 'Migrations up to date')
} finally {
  await client.end()
}
