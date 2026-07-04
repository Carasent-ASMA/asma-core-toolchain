/**
 * THE kernel spec — the ONE hand-edited declaration of kernel-lib membership for the native-ESM
 * migration (frontend plan Phase 2/3). Everything else is COMPUTED from this:
 *   - toolchain: KERNEL_EXTERNAL_SPECIFIERS / KERNEL_PINNED_ROOT_SPECIFIERS (src/vite/kernelExternal.ts)
 *     and the audit's exclusion annotations (bin/asma-kernel-audit.mjs) derive from here.
 *   - asma-infrastructure/asma-mfw-kernel: sync-deps.mjs GENERATES the publisher's package.json
 *     `dependencies` names from here, and gather.mjs derives its react-adjacent / react-free sets
 *     from here (consumed via the published asma-core-toolchain devDependency — CON-001).
 *
 * Plain ESM (no TS build — REQ-002) so plain-Node tools in another repo can import it directly:
 *   import { KERNEL_SPEC } from 'asma-core-toolchain/kernel/spec'
 *
 * Membership is a HUMAN decision (a PR to this file — REQ-003). The `candidates` audit PROPOSES
 * libs that have crossed the fleet-usage bar; it never auto-promotes, because externalizing a lib
 * whose browser-ESM readiness nobody verified is a runtime-crash class. What legitimately stays
 * OUTSIDE this file (different facts, not copies): the kernel's pinned VERSIONS (the publisher's
 * converged-fleet decision, validated by gather — ALT-004) and each app's importmap.json (computed
 * at build time from the app's installed versions).
 *
 * @see _docs/frontend/plans/2026-07-04-13-30-plan-kernel-spec-single-source-of-truth.md
 * @see _docs/asma-core-toolchain/operations/2026-07-04-13-55-runbook-kernel-audit.md
 *
 * @typedef {import('./spec.d.ts').KernelSpec} KernelSpec
 */

/**
 * Fleet-evidence-based (2026-07-04 scan of 17 `asma-app-*`/`adopus-app-*` package.json): every lib
 * here ships browser-ready ESM, is imported ROOT-ONLY across the fleet, and earns its slot on
 * reach × payload — one shared cached fetch beats per-app rebundling. The ≥10-app bar is only the
 * audit's promotion-SCOUT threshold (bin/asma-kernel-audit.mjs), not a membership rule: a big lib
 * with fewer consumers can still win (fleet-expansion Wave A/C added `asma-ui-table`@9 apps,
 * `asma-ui-richeditor`@6, `echarts`@4 — payload-driven). Every entry must exist in `/cdn/libs/`
 * (published by `asma-mfw-kernel`).
 *
 * @see _docs/frontend/plans/2026-07-04-16-30-plan-kernel-lib-fleet-expansion.md — Wave A/B/C rationale
 *
 *   - `versionOf`     — a subpath that ships under another lib's version dir (the react-set:
 *                       react-dom / jsx-runtime / react-dom-client all live under `react@<ver>/`).
 *                       These are NOT pinned in the kernel publisher's package.json.
 *   - `reactAdjacent` — a distinct package the kernel mounts PER React cohort (versioned against
 *                       the cohort's React). react-free libs get one shared URL across cohorts.
 *
 * @type {KernelSpec}
 */
export const KERNEL_SPEC = {
    libs: [
        // react-set root: react-dom / jsx-runtime / react-dom-client ship under the same react@<ver>/
        { specifier: 'react' },
        { specifier: 'react/jsx-runtime', versionOf: 'react' },
        { specifier: 'react-dom', versionOf: 'react' },
        { specifier: 'react-dom/client', versionOf: 'react' },
        // react-adjacent (kernel mounts them per React cohort)
        { specifier: 'asma-ui-core', reactAdjacent: true },
        { specifier: 'react-router-dom', reactAdjacent: true },
        { specifier: 'mobx-react-lite', reactAdjacent: true },
        { specifier: '@tanstack/react-query', reactAdjacent: true },
        { specifier: 'asma-helpers-react', reactAdjacent: true },
        // fleet-expansion Wave A — the asma-ui-* component layer above asma-ui-core. Each bundles its
        // own tree-shaken MUI/emotion subset and keeps asma-ui-core/react/mobx* bare (double-MUI cost
        // class, same as asma-ui-core; see plan CON-002). Imported root-only across the fleet.
        { specifier: 'asma-ui-notistack', reactAdjacent: true },
        { specifier: 'asma-ui-table', reactAdjacent: true },
        { specifier: 'asma-ui-richeditor', reactAdjacent: true },
        // react-free (one shared kernel URL across cohorts)
        { specifier: 'mobx' },
        { specifier: 'mobx-state-tree' },
        { specifier: 'date-fns' },
        { specifier: 'asma-core-helpers' },
        { specifier: 'asma-event-bus' },
        { specifier: 'history' },
        { specifier: 'axios' },
        // fleet-expansion Wave C1 — biggest single-lib payload (~330 KB gz). react-free: apps import
        // only echarts-for-react (stays bundled); its internal bare `import 'echarts'` is what gets
        // externalized here. All 4 consumers declare echarts directly (REQ-004).
        { specifier: 'echarts' },
    ],

    /**
     * B3 transitional two-name aliases: `alias` and `target` are the SAME lib under two package
     * names during a rename. gather flags an app that still uses the alias (the import map cannot
     * dedupe two names — converge to the target). Not kernel members themselves.
     */
    legacyAliases: {
        'asma-core-ui': 'asma-ui-core',
    },

    /**
     * Libs deliberately kept OUT of the kernel — data, so the `candidates` audit annotates them as
     * "no action" instead of nagging, and the WHY lives in one place (was: prose in
     * kernelExternal.ts + a copy in the audit tool). `match` ending in `/` is a scope PREFIX (any
     * subpackage under it); otherwise an exact package name.
     */
    excluded: [
        { match: 'clsx', reason: 'too small — an extra request costs more than dedup saves' },
        { match: 'uuid', reason: 'too small — an extra request costs more than dedup saves' },
        {
            match: 'lodash-es',
            reason: 'subpath imports (lodash-es/get) need trailing-slash package-dir publishing — fleet-phase kernel capability',
        },
        { match: 'gql.tada', reason: 'multi-entry family with per-app version drift — fleet top-up phase' },
        { match: 'asma-qiankun-react-loader', reason: 'retired by the native-ESM plan (Phase 7)' },
        { match: 'asma-genql-directory', reason: 'schema-generated, version-coupled per app — poor dedup' },
        { match: 'asma-types', reason: 'types-only — no runtime imports to externalize' },
        { match: '@mui/', reason: 'rides INSIDE the asma-ui-core kernel bundle — unbundling explodes into ~153 URLs' },
        { match: '@emotion/', reason: 'rides inside asma-ui-core with MUI' },
        { match: '@urql/', reason: 'multi-entry family with per-app version drift — fleet top-up phase' },
        // fleet-expansion Phase 6 (examined 2026-07-04, deliberately kept OUT — reasons recorded so
        // the next fleet scan does not re-litigate; see plan §2 Phase 6 / §3 Alternatives):
        {
            match: 'socket.io-client',
            reason: 'not a dependency of ANY app — pre-bundled inside @openreplay/tracker-assist dist; not externalizable without upstream packaging changes',
        },
        {
            match: 'engine.io-client',
            reason: 'same as socket.io-client — ships inside @openreplay/tracker-assist, no app declares it',
        },
        {
            match: 'asma-helpers',
            reason: '347 subpath imports (asma-helpers/*) — subpath-blocked; also the legacy name of the kernel member asma-core-helpers (Phase-0 rename)',
        },
        { match: 'antd', reason: 'split across majors 4/5/6 — no dedup until convergence' },
        { match: 'tailwind-merge', reason: '~17 KB gz + split majors 2/3 — under the small-lib threshold (an extra request costs more than dedup saves)' },
        { match: 'framer-motion', reason: '3 apps on majors 10/11 — eligible only after version alignment (plan TASK-024)' },
        { match: 'echarts-for-react', reason: 'thin react wrapper — stays bundled per app over the kernel-served echarts' },
        { match: '@iconify/react', reason: '8 apps but split majors 3/4/6 — revisit after convergence' },
    ],
}
