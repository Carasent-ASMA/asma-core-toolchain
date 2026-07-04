import { readFileSync } from 'node:fs'
import path from 'node:path'

// The ONE hand-edited kernel-lib declaration (REQ-001). Everything below is DERIVED from it — this
// file no longer OWNS the list. Self-referencing package import (resolves to src/kernel/spec.mjs
// via the "./kernel/spec" export) so the same specifier works here, in the audit tool, and in
// asma-infrastructure's plain-Node tools.
import { KERNEL_SPEC } from 'asma-core-toolchain/kernel/spec'
import { esmExternalRequirePlugin, type Plugin } from 'vite'

/**
 * Kernel externalization for the native-ESM migration (frontend plan Phase 2/3, app side).
 * CANONICAL home of the kernel spec list + manifest plugin — every asma-app-* consumes these
 * from here (single source; per-app copies are the drift class B3 exists to kill).
 *
 * When enabled, the app build EXTERNALIZES the shared kernel libraries — their imports stay
 * bare (`import 'react'`) in the emitted ESM chunks and resolve at runtime through the
 * `<script type="importmap">` the static server injects at first hit. The build also emits the
 * app's `importmap.json` REQUIREMENTS manifest into dist — `{ app, reactMajor, needs }`, no
 * URLs/SRI/version-in-body — published alongside the other release assets at
 * `/cdn/<app>/<ver>/importmap.json`. Its presence is the signal that this app@version
 * externalizes (manifest-delegation model); the static server's composer joins it against the
 * kernel catalog `/cdn/kernel/manifest.json`.
 *
 * GATED OFF BY DEFAULT (`KERNEL_EXTERNAL=true` to enable): an externalized build only works for
 * users whose first hit carries the import map (seeded kernel + composer live), so the flag keeps
 * every normal release byte-compatible with today while pilot builds opt in. Containment beyond
 * the flag is the multiversion kill-switch: the manifest ships per app@version, so only users
 * PINNED to an externalized version ever get a map.
 *
 * Wiring in an app's vite.config.ts (requires rolldown-vite, i.e. vite >= 8):
 *   const kernelExternal = isKernelExternalBuild()
 *   // plugins: ...(kernelExternal ? [kernelImportmapManifestPlugin(), kernelEsmExternalRequirePlugin()] : [])
 *   // NOTE: do NOT also put KERNEL_EXTERNAL_SPECIFIERS in rolldownOptions.external —
 *   // kernelEsmExternalRequirePlugin() owns the externalization (see its doc for why).
 *
 * @see _docs/frontend/plans/2026-07-01-14-00-plan-native-esm-widget-migration.md:401 — B4 manifest-delegation model
 * @see _docs/frontend/plans/2026-07-01-14-00-plan-native-esm-widget-migration.md:130 — §4 target architecture (React-cohort rule)
 */

/**
 * Every specifier apps externalize — the whole spec list, in declaration order. DERIVED from the
 * spec (KERNEL_SPEC.libs), never re-listed here.
 */
export const KERNEL_EXTERNAL_SPECIFIERS: readonly string[] = KERNEL_SPEC.libs.map((lib) => lib.specifier)

/**
 * The root specifiers the kernel PUBLISHER pins in its `package.json` `dependencies` — the spec
 * set minus the react-set. `react` + everything with `versionOf: 'react'` (react-dom, the two
 * subpaths) are served per-cohort from `vendor-react<N>/` dirs and are deliberately NOT pinned in
 * the kernel package (its node_modules react is npm peer-satisfaction plumbing only). This is the
 * exact set `asma-mfw-kernel/sync-deps.mjs` GENERATES into the publisher's package.json (and CI's
 * `--check` asserts is regeneration-clean) — so the two can never drift by construction.
 */
export const KERNEL_PINNED_ROOT_SPECIFIERS: readonly string[] = KERNEL_SPEC.libs
    .filter((lib) => lib.versionOf === undefined && lib.specifier !== 'react')
    .map((lib) => lib.specifier)

/** Kernel externalization is opt-in per BUILD (pilot versions set it; normal releases stay bundled). */
export function isKernelExternalBuild(): boolean {
    return process.env['KERNEL_EXTERNAL'] === 'true'
}

/**
 * THE externalization mechanism for kernel-external builds — rolldown's builtin
 * `esm-external-require` plugin configured with the kernel specifier set. It does two things:
 * marks the specifiers external (imports stay bare for the import map), AND rewrites
 * `require('react')` inside bundled CJS deps (react-side-effect via react-helmet, UMD builds
 * requiring mobx/mobx-state-tree, …) into real imports of the external module.
 *
 * Why a plugin instead of `rolldownOptions.external`: rolldown deliberately does NOT convert CJS
 * `require()` of a top-level-external module into an import — it emits a runtime `__require` shim
 * that THROWS in the browser (rolldown.rs/in-depth/bundling-cjs#require-external-modules; rollup's
 * commonjs plugin used to convert these, so this class of breakage is new with rolldown-vite —
 * it took down shell 0.78.1's login on dev). The rewrite is safe for the kernel set because every
 * kernel lib is published as browser ESM with named exports + default interop (build.ts codegens
 * the barrels). The specifiers must NOT additionally appear in top-level `external`: an external
 * match wins before the plugin's resolve hook, the plugin never sees the module, and the throwing
 * shim comes back (the plugin warns "Found N duplicate external" when this happens).
 *
 * Requires rolldown-vite (vite >= 8) — vite re-exports the builtin; kernel-external builds are
 * rolldown-only anyway (codeSplitting etc.).
 */
export function kernelEsmExternalRequirePlugin(): Plugin {
    return esmExternalRequirePlugin({ external: [...KERNEL_EXTERNAL_SPECIFIERS] }) as unknown as Plugin
}

/** The consuming app's package.json (vite configs run with cwd = the app root). */
function appPackageJson(appRoot: string): { name: string; dependencies?: Record<string, string> } {
    return JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as {
        name: string
        dependencies?: Record<string, string>
    }
}

/** The exact installed version of a dependency — the manifest must declare what the build actually
 *  compiled against, never the package.json range (B4: manifest derives from the build). Read via
 *  fs, not require(): an `exports` map (e.g. asma-ui-core's) blocks `<pkg>/package.json` resolution. */
function resolvedVersion(appRoot: string, packageName: string): string {
    const packageJsonPath = path.join(appRoot, 'node_modules', packageName, 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }
    return packageJson.version
}

/**
 * Emit `dist/importmap.json` — this app@version's kernel requirements, published alongside the
 * other release assets at `/cdn/<app>/<ver>/importmap.json`. `needs` covers only the kernel libs
 * the app DECLARES in its own `dependencies` (a hoisted transitive must not pin the map's
 * majority-version election); `react` carries the root of the react-set (the server expands
 * react-dom / jsx-runtime / react-dom-client at the same major); `reactMajor` decides the app's
 * cohort. Subpath specifiers (versionOf) are not declared separately — they resolve with their
 * root package.
 */
export function kernelImportmapManifestPlugin(): Plugin {
    const appRoot = process.cwd()
    return {
        apply: 'build',
        generateBundle() {
            const declared = appPackageJson(appRoot).dependencies ?? {}
            const needs: Record<string, string> = {}
            for (const lib of KERNEL_SPEC.libs) {
                if (lib.versionOf === undefined && lib.specifier in declared) {
                    needs[lib.specifier] = resolvedVersion(appRoot, lib.specifier)
                }
            }
            const manifest = {
                app: appPackageJson(appRoot).name,
                needs,
                reactMajor: needs['react']?.split('.')[0] ?? '',
            }
            this.emitFile({
                fileName: 'importmap.json',
                source: JSON.stringify(manifest, null, 2) + '\n',
                type: 'asset',
            })
            console.info('kernel-importmap-manifest: emitted importmap.json', needs)
        },
        name: 'kernel-importmap-manifest',
    }
}
