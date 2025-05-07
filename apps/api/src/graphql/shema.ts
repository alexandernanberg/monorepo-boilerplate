import type { User as DbUser } from '~/db/schema'
import { builder } from './builder'

///////////////////////////////////////////////////////////
// User
///////////////////////////////////////////////////////////

type UserType = Pick<
  DbUser,
  'id' | 'email' | 'givenName' | 'familyName' | 'createdAt'
>

const UserRef = builder.objectRef<UserType>('User')

export const User = builder.node(UserRef, {
  id: {
    resolve: (user) => user.id,
  },

  loadWithoutCache: (id, ctx) => ctx.dataSources.loadUserById(id),

  fields: (t) => ({
    databaseId: t.exposeID('id'),
    givenName: t.exposeString('givenName'),
    familyName: t.exposeString('familyName'),
    createdAt: t.expose('createdAt', { type: 'DateTime' }),
    email: t.exposeString('email', { nullable: false }),
  }),
})

builder.mutationType({ fields: () => ({}) })

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

export const schema = builder.toSchema()
