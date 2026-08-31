import { describe, expect, test } from 'bun:test'
import { buildSchema, parse, validate } from 'graphql'
import { createMaxDepthRule } from '~/graphql/max-depth-rule'

/**
 * A deliberately cyclic schema — the shape that makes depth limiting necessary
 * in the first place, since a short query through it can describe an
 * arbitrarily large result.
 */
const schema = buildSchema(`
  type User {
    id: ID!
    name: String!
    friends: [User!]!
  }

  type Query {
    viewer: User!
  }
`)

function depthErrors(query: string, maxDepth: number) {
  return validate(schema, parse(query), [createMaxDepthRule(maxDepth)]).map(
    (error) => error.message,
  )
}

describe('createMaxDepthRule', () => {
  test('allows a query within the limit', () => {
    expect(depthErrors('{ viewer { name } }', 2)).toEqual([])
  })

  test('rejects a query past the limit', () => {
    expect(depthErrors('{ viewer { friends { name } } }', 2)).toEqual([
      'Query is nested 3 levels deep, which exceeds the maximum of 2.',
    ])
  })

  test('counts the deepest branch, not the first', () => {
    expect(
      depthErrors('{ viewer { name friends { friends { name } } } }', 3),
    ).toEqual([
      'Query is nested 4 levels deep, which exceeds the maximum of 3.',
    ])
  })

  test('follows fragments so nesting cannot be hidden in one', () => {
    const query = `
      { viewer { ...deep } }
      fragment deep on User { friends { friends { name } } }
    `

    expect(depthErrors(query, 2)).toEqual([
      'Query is nested 4 levels deep, which exceeds the maximum of 2.',
    ])
  })

  test('does not charge a level for spreading a fragment', () => {
    const query = `
      { viewer { ...fields } }
      fragment fields on User { name }
    `

    expect(depthErrors(query, 2)).toEqual([])
  })

  test('does not charge a level for an inline fragment', () => {
    expect(depthErrors('{ viewer { ... on User { name } } }', 2)).toEqual([])
  })

  /**
   * `NoFragmentCyclesRule` rejects this document, but rule order is not
   * guaranteed — measuring it must terminate rather than recurse forever.
   */
  test('terminates on cyclic fragments', () => {
    const query = `
      { viewer { ...a } }
      fragment a on User { friends { ...b } }
      fragment b on User { friends { ...a } }
    `

    expect(() => depthErrors(query, 100)).not.toThrow()
  })

  test('ignores introspection fields', () => {
    expect(depthErrors('{ __schema { types { name } } }', 1)).toEqual([])
  })

  test('checks each operation in a document separately', () => {
    const query = `
      query shallow { viewer { name } }
      query deep { viewer { friends { friends { name } } } }
    `

    expect(depthErrors(query, 2)).toEqual([
      'Query is nested 4 levels deep, which exceeds the maximum of 2.',
    ])
  })
})
