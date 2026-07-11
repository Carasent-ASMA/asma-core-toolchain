import assert from 'node:assert/strict'
import { test } from 'node:test'

import { unwrapNamespace } from './unwrapClientSchema'

const CONSOLIDATED = `
schema { query: query_root mutation: mutation_root subscription: subscription_root }
directive @cached(ttl: Int! = 60) on QUERY
scalar datetime
scalar avansas_uniqueidentifier
scalar fretexdev_uniqueidentifier
type avansas_Actor { ActorNo: Int! Changedt: datetime Id: avansas_uniqueidentifier }
input avansas_Actor_bool_exp { ActorNo: Int }
type avansas_query { Actor(where: avansas_Actor_bool_exp): [avansas_Actor!]! }
type avansas_mutation { update_Actor: Int }
type fretexdev_Actor { ActorNo: Int! Id: fretexdev_uniqueidentifier }
type fretexdev_query { Actor: [fretexdev_Actor!]! }
type query_root { avansas: avansas_query! fretexdev: fretexdev_query! }
type mutation_root { avansas: avansas_mutation! }
type subscription_root { avansas: avansas_query! fretexdev: fretexdev_query! }
`

test('unwrapNamespace: unwraps roots, strips prefix, prunes other tenants', () => {
    const { sdl, prefixedTypes } = unwrapNamespace(CONSOLIDATED, 'avansas')

    // root fields are hoisted out of the namespace container
    assert.match(sdl, /type query_root \{\s*Actor\(where: Actor_bool_exp\): \[Actor!\]!/)
    // prefix gone everywhere; other tenant pruned
    assert.doesNotMatch(sdl, /avansas_/)
    assert.doesNotMatch(sdl, /fretexdev/)
    // the prefixed-type list is exactly the avansas types that survived (incl. the prefixed scalar)
    assert.deepEqual(prefixedTypes, ['Actor', 'Actor_bool_exp', 'uniqueidentifier'])
    // an unprefixed scalar the engine did NOT namespace is not in the list but stays in the SDL
    assert.match(sdl, /scalar datetime/)
})

test('unwrapNamespace: rejects a schema that is not namespaced for the slug', () => {
    assert.throws(() => unwrapNamespace(CONSOLIDATED, 'nosuchtenant'), /No 'nosuchtenant' namespace/)
})

test('unwrapNamespace: rejects an invalid slug', () => {
    assert.throws(() => unwrapNamespace(CONSOLIDATED, 'Bad-Slug'), /Invalid slug/)
})
