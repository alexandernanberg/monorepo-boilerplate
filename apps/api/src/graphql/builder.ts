import SchemaBuilder from '@pothos/core'
import RelayPlugin from '@pothos/plugin-relay'
import { DateTimeResolver } from 'graphql-scalars'
import type { createDataSources } from '~/graphql/data-loaders'
import type { CurrentUser } from '~/services/user'

export const builder = new SchemaBuilder<{
  Context: {
    dataSources: ReturnType<typeof createDataSources>
    currentUser: CurrentUser | null
  }
  Scalars: {
    DateTime: { Input: Date; Output: Date }
  }
}>({
  plugins: [RelayPlugin],
})

builder.addScalarType('DateTime', DateTimeResolver)
