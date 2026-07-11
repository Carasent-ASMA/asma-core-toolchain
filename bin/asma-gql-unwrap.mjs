#!/usr/bin/env node
// asma-gql-unwrap — strip a single tenant's namespace out of a consolidated Hasura SDL so
// gql.tada client codegen stays unprefixed. Thin shim; logic + docs in src/codegen/unwrapClientSchema.ts
// (built to lib/). Mechanical inverse of the runtime adopusNamespaceExchange in asma-core-helpers/urql.
//
//   asma-gql-unwrap --slug <slug> --file <schema.graphql>
import { runCli } from '../lib/codegen/unwrapClientSchema.js'

try {
    runCli(process.argv.slice(2))
} catch (error) {
    console.error(`asma-gql-unwrap: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
}
