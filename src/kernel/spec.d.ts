/**
 * Types for the plain-ESM kernel spec (spec.mjs). Hand-written because spec.mjs bypasses `tsc`
 * (REQ-002) — a typo in the data is not type-checked at build; the toolchain's spec shape test
 * (RISK-003) guards that instead. Consumed by TS callers via the `./kernel/spec` package export.
 */

/** One kernel-lib membership entry. */
export interface KernelLib {
    /** Bare import specifier apps externalize, e.g. `react`, `react-dom/client`, `@tanstack/react-query`. */
    specifier: string
    /** Set when this specifier ships under ANOTHER lib's version dir (the react-set: react-dom /
     *  jsx-runtime / react-dom-client under `react@<ver>/`). Such entries are NOT pinned in the
     *  kernel publisher's package.json. */
    versionOf?: string
    /** A distinct package the kernel mounts PER React cohort (versioned against the cohort's React),
     *  as opposed to a react-free lib served once across cohorts. */
    reactAdjacent?: boolean
}

/** A deliberately-excluded lib (or scope prefix, when `match` ends in `/`) + why. */
export interface KernelExclusion {
    /** Exact package name, or a scope PREFIX ending in `/` (e.g. `@mui/`) matching any subpackage. */
    match: string
    reason: string
}

/** THE kernel spec — the single hand-edited declaration everything else is computed from. */
export interface KernelSpec {
    libs: readonly KernelLib[]
    /** B3 transitional aliases: `{ [aliasName]: targetName }` — the same lib under two names. */
    legacyAliases: Readonly<Record<string, string>>
    excluded: readonly KernelExclusion[]
}

export declare const KERNEL_SPEC: KernelSpec
