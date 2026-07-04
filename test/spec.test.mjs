// Kernel spec guards (TEST-001 / TEST-002). The spec is plain .mjs and bypasses `tsc` (REQ-002),
// so a typo in the data is not type-checked — these runtime assertions are that safety net
// (RISK-003). They import spec.mjs from SOURCE (no build needed), so they run in `pnpm check`.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { KERNEL_SPEC } from '../src/kernel/spec.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The root package of a bare specifier: 'react/jsx-runtime' -> 'react', '@a/b/c' -> '@a/b'. */
const rootOf = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0])

// The frozen contract — the pre-refactor values of the derived exports. If a spec edit changes
// these, it is a deliberate CONTRACT change and this snapshot must be updated in the same PR.
const EXPECTED_EXTERNAL = [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    'asma-ui-core',
    'react-router-dom',
    'mobx-react-lite',
    '@tanstack/react-query',
    'asma-helpers-react',
    // fleet-expansion Wave A: asma-ui-* component layer above asma-ui-core (react-adjacent cohort)
    'asma-ui-notistack',
    'asma-ui-table',
    'asma-ui-richeditor',
    // fleet-expansion Wave B1: asma-ui-datetime (date-fns moved to peerDeps)
    'asma-ui-datetime',
    // fleet-expansion Wave C2: asma-ui-icons (32 KB gzip, under gate)
    'asma-ui-icons',
    'mobx',
    'mobx-state-tree',
    'date-fns',
    'asma-core-helpers',
    'asma-event-bus',
    'history',
    'axios',
    // fleet-expansion Wave C1: echarts (react-free, biggest single lib payload)
    'echarts',
]
const EXPECTED_PINNED = [
    'asma-ui-core',
    'react-router-dom',
    'mobx-react-lite',
    '@tanstack/react-query',
    'asma-helpers-react',
    'asma-ui-notistack',
    'asma-ui-table',
    'asma-ui-richeditor',
    'asma-ui-datetime',
    'asma-ui-icons',
    'mobx',
    'mobx-state-tree',
    'date-fns',
    'asma-core-helpers',
    'asma-event-bus',
    'history',
    'axios',
    'echarts',
]

const deriveExternal = () => KERNEL_SPEC.libs.map((l) => l.specifier)
const derivePinned = () =>
    KERNEL_SPEC.libs.filter((l) => l.versionOf === undefined && l.specifier !== 'react').map((l) => l.specifier)

// ─── TEST-001: spec shape ─────────────────────────────────────────────────────

test('every lib has a non-empty string specifier', () => {
    assert.ok(KERNEL_SPEC.libs.length > 0)
    for (const lib of KERNEL_SPEC.libs) {
        assert.equal(typeof lib.specifier, 'string')
        assert.ok(lib.specifier.length > 0)
    }
})

test('no duplicate specifiers', () => {
    const seen = new Set()
    for (const lib of KERNEL_SPEC.libs) {
        assert.ok(!seen.has(lib.specifier), `duplicate specifier: ${lib.specifier}`)
        seen.add(lib.specifier)
    }
})

test('every versionOf target exists as a root lib', () => {
    const roots = new Set(KERNEL_SPEC.libs.filter((l) => l.versionOf === undefined).map((l) => l.specifier))
    for (const lib of KERNEL_SPEC.libs) {
        if (lib.versionOf !== undefined) {
            assert.ok(roots.has(lib.versionOf), `versionOf target "${lib.versionOf}" is not a root lib`)
        }
    }
})

test('reactAdjacent, when present, is boolean true', () => {
    for (const lib of KERNEL_SPEC.libs) {
        if ('reactAdjacent' in lib) assert.equal(lib.reactAdjacent, true)
    }
})

test('legacyAliases map to kernel members and are not members themselves', () => {
    const specifiers = new Set(KERNEL_SPEC.libs.map((l) => l.specifier))
    for (const [alias, target] of Object.entries(KERNEL_SPEC.legacyAliases)) {
        assert.ok(specifiers.has(target), `legacyAlias target "${target}" is not a kernel lib`)
        assert.ok(!specifiers.has(alias), `legacyAlias "${alias}" must not itself be a kernel lib`)
    }
})

test('no specifier is both in libs and matching excluded', () => {
    for (const lib of KERNEL_SPEC.libs) {
        for (const { match } of KERNEL_SPEC.excluded) {
            const hit = match.endsWith('/') ? lib.specifier.startsWith(match) : rootOf(lib.specifier) === match
            assert.ok(!hit, `spec lib "${lib.specifier}" collides with exclusion "${match}"`)
        }
    }
})

test('every exclusion has a non-empty match and reason', () => {
    for (const ex of KERNEL_SPEC.excluded) {
        assert.equal(typeof ex.match, 'string')
        assert.ok(ex.match.length > 0)
        assert.equal(typeof ex.reason, 'string')
        assert.ok(ex.reason.length > 0)
    }
})

// ─── TEST-002: derived contract equals the frozen snapshot ─────────────────────

test('derived KERNEL_EXTERNAL_SPECIFIERS equals the frozen snapshot', () => {
    assert.deepEqual(deriveExternal(), EXPECTED_EXTERNAL)
})

test('derived KERNEL_PINNED_ROOT_SPECIFIERS equals the frozen snapshot', () => {
    assert.deepEqual(derivePinned(), EXPECTED_PINNED)
})

// The BUILT exports must match the same snapshot — proves kernelExternal.ts derives identically.
// Skipped when lib/ isn't built (e.g. `pnpm check` before `pnpm build`); the derivation subtests
// above still cover the spec content in that case.
test('built kernelExternal.js exports match the frozen snapshot', async (t) => {
    const built = path.join(HERE, '..', 'lib', 'vite', 'kernelExternal.js')
    if (!existsSync(built)) {
        t.skip('lib/ not built — run `pnpm build` to exercise the real exports')
        return
    }
    const mod = await import(built)
    assert.deepEqual([...mod.KERNEL_EXTERNAL_SPECIFIERS], EXPECTED_EXTERNAL)
    assert.deepEqual([...mod.KERNEL_PINNED_ROOT_SPECIFIERS], EXPECTED_PINNED)
})
