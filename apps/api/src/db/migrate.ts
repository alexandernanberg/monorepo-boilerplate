import { client, upgradeDatabase } from '~/db'

await upgradeDatabase()
await client.end()
