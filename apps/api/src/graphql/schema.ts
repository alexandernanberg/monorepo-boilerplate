import type { User as DbUser } from '~/db/schema'
import { builder } from './builder'

///////////////////////////////////////////////////////////
// User
///////////////////////////////////////////////////////////

type UserType = Pick<DbUser, 'id' | 'email' | 'name' | 'createdAt'> & {
  givenName?: string | null
  familyName?: string | null
}

const UserRef = builder.objectRef<UserType>('User')

export const User = builder.node(UserRef, {
  id: {
    resolve: (user) => user.id,
  },

  loadWithoutCache: (id, ctx) => ctx.dataSources.loadUserById(id),

  fields: (t) => ({
    databaseId: t.exposeID('id'),
    name: t.exposeString('name', { nullable: false }),
    givenName: t.exposeString('givenName', { nullable: true }),
    familyName: t.exposeString('familyName', { nullable: true }),
    createdAt: t.expose('createdAt', { type: 'DateTime' }),
    email: t.exposeString('email', { nullable: false }),
  }),
})

///////////////////////////////////////////////////////////
// Query
///////////////////////////////////////////////////////////

builder.queryType({
  fields: (t) => ({
    viewer: t.field({
      type: User,
      resolve: (root, parent, ctx) => ctx.currentUser,
    }),
  }),
})

///////////////////////////////////////////////////////////
// Mutation
///////////////////////////////////////////////////////////

// There is no mutation type yet. GraphQL rejects a schema containing an object
// type with no fields, so declaring an empty one up front makes every request —
// queries included — fail schema validation. Add the first mutation with
// `builder.mutationType({ fields: (t) => ({ ... }) })`.

export const schema = builder.toSchema()
