import type {
  ASTVisitor,
  FragmentDefinitionNode,
  SelectionSetNode,
  ValidationContext,
} from 'graphql'
import { GraphQLError, Kind } from 'graphql'

/**
 * Reject queries nested deeper than `maxDepth`.
 *
 * A GraphQL schema with a cycle in it — `user -> sessions -> user -> ...`, which
 * this one already has — lets a short query describe an enormous result. There
 * is no request size that catches it, because the cost grows with nesting, not
 * with characters. So the depth is bounded before execution starts, and
 * therefore before a single database query is issued.
 *
 * Fragments are followed rather than counted: spreading a fragment does not add
 * a level, but its selections do, so the limit cannot be side-stepped by moving
 * the nesting into one.
 */
function createMaxDepthRule(maxDepth: number) {
  return function MaxDepthRule(context: ValidationContext): ASTVisitor {
    const fragments = new Map<string, FragmentDefinitionNode>()

    for (const definition of context.getDocument().definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(definition.name.value, definition)
      }
    }

    /**
     * `visited` carries the fragment names on the current path. A document
     * whose fragments spread each other in a cycle is rejected by
     * `NoFragmentCyclesRule`, but rule order is not guaranteed — without this
     * guard, measuring one would not terminate.
     */
    function measure(
      selectionSet: SelectionSetNode,
      depth: number,
      visited: ReadonlySet<string>,
    ): number {
      let deepest = depth

      for (const selection of selectionSet.selections) {
        switch (selection.kind) {
          case Kind.FIELD: {
            // Introspection is answered from the schema in memory, so its
            // depth costs nothing worth policing — and `__schema` is naturally
            // deep enough to trip an otherwise sensible limit.
            if (selection.name.value.startsWith('__')) break

            deepest = selection.selectionSet
              ? Math.max(
                  deepest,
                  measure(selection.selectionSet, depth + 1, visited),
                )
              : Math.max(deepest, depth + 1)
            break
          }

          case Kind.INLINE_FRAGMENT: {
            // An inline fragment is a type condition, not a level of nesting.
            deepest = Math.max(
              deepest,
              measure(selection.selectionSet, depth, visited),
            )
            break
          }

          case Kind.FRAGMENT_SPREAD: {
            const name = selection.name.value
            if (visited.has(name)) break

            const fragment = fragments.get(name)
            if (!fragment) break

            deepest = Math.max(
              deepest,
              measure(
                fragment.selectionSet,
                depth,
                new Set([...visited, name]),
              ),
            )
            break
          }
        }
      }

      return deepest
    }

    return {
      OperationDefinition(operation) {
        const depth = measure(operation.selectionSet, 0, new Set())

        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query is nested ${depth} levels deep, which exceeds the maximum of ${maxDepth}.`,
              {
                nodes: operation,
                extensions: { code: 'GRAPHQL_MAX_DEPTH_EXCEEDED' },
              },
            ),
          )
        }

        // The operation's own selections have been measured; there is nothing
        // left for the default traversal to find.
        return false
      },
    }
  }
}

export { createMaxDepthRule }
