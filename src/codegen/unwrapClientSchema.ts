/**
 * unwrapClientSchema — turn a consolidated (namespaced) Hasura SDL back into the legacy,
 * single-tenant shape so gql.tada client codegen stays UNPREFIXED.
 *
 * The consolidated Hasura v2 engine namespaces every tenant source: root fields nest under
 * `<slug>` and type names carry a `<slug>_` prefix. Introspecting it directly would give every
 * app prefixed, namespace-wrapped types. This is the mechanical INVERSE of the runtime
 * `adopusNamespaceExchange` (asma-core-helpers/urql): it strips the namespace out of the SDL at
 * codegen time so the generated gql.tada types (and therefore every app operation) stay exactly
 * as they are today. Build-time only — never shipped to the browser (that is why it lives in the
 * toolchain, not in the runtime helpers lib).
 *
 *   1. unwrap — replace each root type's fields with the `<slug>` container's fields
 *   2. strip  — rename every `<slug>_X` type to `X`
 *   3. prune  — drop types unreachable from the roots (the other tenants' namespaces)
 *   4. emit   — the rewritten SDL + the exact list of type names that carried the prefix, so the
 *               runtime exchange never has to guess (whether scalars are prefixed is
 *               Hasura-version-dependent — this list is the ground truth).
 *
 * @see asma-modules/_docs/adopus-graphql/plans/2026-07-11-00-14-plan-adopus-hasura2-consolidation.md:195 — §2.4.4 Codegen (DEC-004)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Kind, parse, print, visit } from 'graphql'
import type { DefinitionNode, DocumentNode, FieldDefinitionNode, TypeDefinitionNode, TypeNode } from 'graphql'

const ROOT_OPS = ['query', 'mutation', 'subscription'] as const
const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,30}$/

const TYPE_DEF_KINDS: ReadonlySet<Kind> = new Set([
    Kind.OBJECT_TYPE_DEFINITION,
    Kind.INPUT_OBJECT_TYPE_DEFINITION,
    Kind.ENUM_TYPE_DEFINITION,
    Kind.SCALAR_TYPE_DEFINITION,
    Kind.INTERFACE_TYPE_DEFINITION,
    Kind.UNION_TYPE_DEFINITION,
])

function isTypeDefinition(def: DefinitionNode): def is TypeDefinitionNode {
    return TYPE_DEF_KINDS.has(def.kind)
}

function definitionName(def: DefinitionNode): string | undefined {
    return 'name' in def && def.name ? def.name.value : undefined
}

export interface UnwrapResult {
    /** rewritten, unprefixed, single-tenant SDL (newline-terminated) */
    sdl: string
    /** sorted names of the types that carried the `<slug>_` prefix and survived pruning */
    prefixedTypes: string[]
}

function namedTypeName(type: TypeNode): string {
    let node = type
    while (node.kind === Kind.NON_NULL_TYPE || node.kind === Kind.LIST_TYPE) node = node.type
    return node.name.value
}

/** Pure transform. Throws on a bad slug or a schema that is not namespaced for `slug`. */
export function unwrapNamespace(sdlText: string, slug: string): UnwrapResult {
    if (!SLUG_PATTERN.test(slug)) throw new Error(`Invalid slug '${slug}' (must match ${SLUG_PATTERN})`)
    const prefix = `${slug}_`
    const strip = (value: string) => (value.startsWith(prefix) ? value.slice(prefix.length) : value)
    const doc = parse(sdlText)

    const typeDefs = new Map<string, TypeDefinitionNode>()
    const passthrough: DefinitionNode[] = [] // schema definition + directive definitions
    const rootTypeNames: Record<string, string> = {}
    for (const def of doc.definitions) {
        if (def.kind === Kind.SCHEMA_DEFINITION) {
            passthrough.push(def)
            for (const op of def.operationTypes) rootTypeNames[op.operation] = op.type.name.value
        } else if (def.kind === Kind.DIRECTIVE_DEFINITION) {
            passthrough.push(def)
        } else if (isTypeDefinition(def)) {
            typeDefs.set(def.name.value, def)
        }
    }
    for (const op of ROOT_OPS) rootTypeNames[op] ??= `${op}_root`

    // 1. unwrap: swap each root type's fields for its `<slug>` container's fields, then drop the container
    const containers = new Set<string>()
    let unwrapped = 0
    for (const op of ROOT_OPS) {
        const rootName = rootTypeNames[op]
        const root = rootName === undefined ? undefined : typeDefs.get(rootName)
        if (root === undefined || root.kind !== Kind.OBJECT_TYPE_DEFINITION) continue
        const nsField = (root.fields ?? []).find((field) => field.name.value === slug)
        if (nsField === undefined) continue
        const containerName = namedTypeName(nsField.type)
        const container = typeDefs.get(containerName)
        if (container === undefined || container.kind !== Kind.OBJECT_TYPE_DEFINITION) {
            throw new Error(`Namespace container type '${containerName}' not found for ${op}`)
        }
        const fields: readonly FieldDefinitionNode[] = container.fields ?? []
        typeDefs.set(root.name.value, { ...root, fields })
        containers.add(containerName)
        unwrapped++
    }
    if (unwrapped === 0) {
        throw new Error(`No '${slug}' namespace field on any root type — is this the consolidated engine's schema?`)
    }
    for (const name of containers) typeDefs.delete(name)

    // 2. strip prefix: rename every `<slug>_X` type reference and definition to `X`
    const renamed = new Set<string>()
    const renameDefName = <T extends TypeDefinitionNode>(node: T): T | undefined => {
        if (!node.name.value.startsWith(prefix)) return undefined
        renamed.add(strip(node.name.value))
        return { ...node, name: { ...node.name, value: strip(node.name.value) } }
    }
    const renamedDoc = visit({ ...doc, definitions: [...passthrough, ...typeDefs.values()] }, {
        NamedType: (node) =>
            node.name.value.startsWith(prefix)
                ? { ...node, name: { ...node.name, value: strip(node.name.value) } }
                : undefined,
        ObjectTypeDefinition: renameDefName,
        InputObjectTypeDefinition: renameDefName,
        EnumTypeDefinition: renameDefName,
        ScalarTypeDefinition: renameDefName,
        InterfaceTypeDefinition: renameDefName,
        UnionTypeDefinition: renameDefName,
    })

    // 3. prune: keep only types reachable from the roots (drops other tenants' namespaces)
    const defsByName = new Map<string, DefinitionNode>()
    for (const def of renamedDoc.definitions) {
        const name = definitionName(def)
        if (name !== undefined) defsByName.set(name, def)
    }
    const keep = new Set<string>()
    const queue = ROOT_OPS.map((op) => rootTypeNames[op]).filter((name): name is string => name !== undefined)
    while (queue.length > 0) {
        const name = queue.pop()
        if (name === undefined || keep.has(name)) continue
        const def = defsByName.get(name)
        if (def === undefined) continue
        keep.add(name)
        visit(def, { NamedType: (node) => void queue.push(node.name.value) })
    }

    const finalDefs = renamedDoc.definitions.filter((def) => {
        if (def.kind === Kind.SCHEMA_DEFINITION || def.kind === Kind.DIRECTIVE_DEFINITION) return true
        const name = definitionName(def)
        return name !== undefined && keep.has(name)
    })
    const sdl = print({ ...renamedDoc, definitions: finalDefs } as DocumentNode)
    const prefixedTypes = [...renamed].filter((name) => keep.has(name)).sort()
    return { sdl: `${sdl}\n`, prefixedTypes }
}

interface CliArgs {
    slug: string
    file: string
}

function parseArgs(argv: readonly string[]): CliArgs {
    const args: Partial<CliArgs> = {}
    for (let i = 0; i < argv.length; i += 2) {
        const flag = argv[i]
        const value = argv[i + 1]
        if (flag === '--slug' && value !== undefined) args.slug = value
        else if (flag === '--file' && value !== undefined) args.file = value
        else throw new Error(`Usage: asma-gql-unwrap --slug <slug> --file <schema.graphql>`)
    }
    if (args.slug === undefined || args.file === undefined) {
        throw new Error(`Both --slug and --file are required`)
    }
    return { slug: args.slug, file: args.file }
}

/**
 * CLI entry (invoked by the `asma-gql-unwrap` bin). Rewrites the SDL file in place and writes
 * `adopus-prefixed-types.ts` beside it — the sole consumer today is the Adopus namespace exchange,
 * hence the fixed artifact name.
 */
export function runCli(argv: readonly string[]): void {
    const { slug, file } = parseArgs(argv)
    const { sdl, prefixedTypes } = unwrapNamespace(readFileSync(file, 'utf8'), slug)
    writeFileSync(file, sdl)
    const typesPath = join(dirname(file), 'adopus-prefixed-types.ts')
    writeFileSync(
        typesPath,
        `/* generated by asma-core-toolchain asma-gql-unwrap — do not edit */\n` +
            `export const adopusPrefixedTypes: readonly string[] = ${JSON.stringify(prefixedTypes, null, 4)}\n`,
    )
    console.log(`asma-gql-unwrap: stripped '${prefix(slug)}' from ${prefixedTypes.length} kept types -> ${typesPath}`)
}

function prefix(slug: string): string {
    return `${slug}_`
}
