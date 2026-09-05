import SchemaBuilder from '@pothos/core'
import DataloaderPlugin from '@pothos/plugin-dataloader'
import RelayPlugin from '@pothos/plugin-relay'
import { DateTimeResolver, URLResolver } from 'graphql-scalars'
import type { createDataSources } from '~/graphql/data-loaders'
import type { CurrentUser } from '~/services/user'

export const builder = new SchemaBuilder<{
  Context: {
    dataSources: ReturnType<typeof createDataSources>
    currentUser: CurrentUser | null
  }
  Scalars: {
    DateTime: { Input: Date; Output: Date }
    URL: { Input: string; Output: string }
  }
}>({
  plugins: [RelayPlugin, DataloaderPlugin],
})

builder.addScalarType('DateTime', DateTimeResolver)
builder.addScalarType('URL', URLResolver)
