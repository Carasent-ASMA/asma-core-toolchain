import react from '@vitejs/plugin-react'
import { type WidgetBuildOptions, widgetBuild, widgetCodeSplitting } from 'asma-mfw-esmloader/vite'
import { defineConfig, mergeConfig, type PluginOption, type UserConfig } from 'vite'
import svgr from 'vite-plugin-svgr'

import { isKernelExternalBuild, kernelEsmExternalRequirePlugin, kernelImportmapManifestPlugin } from './kernelExternal.js'

/**
 * Shared native-ESM widget build for asma-app-* micro-frontends (dual-loader migration).
 *
 * The app's `vite.config.widgets.ts` collapses to app-specific plugins passed into this factory.
 * It mirrors the app's main config MINUS the qiankun plugin, with the `widgets.config.ts` entries
 * as Rollup input and `widgetBuild` emitting `widgets.json`. Run alongside the normal build
 * (`emptyOutDir: false`) so dist carries BOTH faces: `dist/widgets/*.js` + `dist/widgets.json`
 * for the ESM loader, and the existing qiankun `index.html`.
 *
 * Kernel externalization: with `KERNEL_EXTERNAL=true` the kernel libs stay BARE imports in the
 * emitted widget modules — resolved at runtime by the static server's composed import map — and
 * the build emits the `dist/importmap.json` requirements manifest. Gated OFF by default so a raw
 * `vite build --config vite.config.widgets.ts` stays fully bundled; the app's `build:widgets`
 * npm script is the opt-in. Only THIS face externalizes — the qiankun face keeps bundling.
 *
 * Deploy note: `widgets.json` must land at the app's CDN base (`<service>/<version>/widgets.json`) —
 * the static server HEADs it to mark the app `esm`, which routes the shell to the ESM path. An
 * externalized build additionally requires every version in `importmap.json` to exist under
 * `/cdn/libs/` BEFORE release (kernel top-up via reusable-kernel-publish.yml `libs:` input) — the
 * map points at `<lib>@<resolved-version>/` verbatim, so an unpublished version is a runtime 404.
 *
 * NOT re-exported from `asma-core-toolchain/vite`: this module imports `asma-mfw-esmloader/vite`
 * (an optional peer), which apps without a widgets face don't install.
 */
export type AsmaWidgetsViteOptions = {
    /** App-specific plugins (tailwind, nodePolyfills, …), run before the shared react/svgr/widgetBuild set. */
    plugins?: PluginOption[]
    /** Forwarded to `widgetBuild()` — custom `widgets.config.ts` path or export name. */
    widgetBuild?: WidgetBuildOptions
    /**
     * Local escape hatch: deep-merged OVER the shared base via vite's `mergeConfig` (local values
     * win, arrays append). For a change no merge can express, the app can always keep a fully
     * local `vite.config.widgets.ts` instead of this factory.
     */
    overrides?: UserConfig
}

export function defineAsmaWidgetsConfig(options: AsmaWidgetsViteOptions = {}) {
    const { input, plugin } = widgetBuild(options.widgetBuild)
    const kernelExternal = isKernelExternalBuild()

    const base: UserConfig = {
        // Native-ESM widgets are loaded from a path not known at build time — `/cdn/<app>/<ver>/`,
        // a `pr<N>` preview, or a `http://localhost:<port>/` dev override. A RELATIVE base makes vite
        // resolve the dynamic-import preload graph (`__vite__mapDeps` / `__vitePreload`) against each
        // chunk's own `import.meta.url` — the same way the emitted static `../chunks/…` imports already
        // resolve. Without it vite falls back to the default absolute base `/`, so every code-split
        // preload is fetched from the ORIGIN ROOT (`/chunks/…`), the static server answers its SPA
        // catch-all `index.html` (`text/html`), and the browser rejects it: "Expected a
        // JavaScript-or-Wasm module script … MIME type text/html". (The qiankun face keeps its absolute
        // `getBasePathAndPort()` base from the main config — this only affects the widgets face.)
        base: './',
        build: {
            emptyOutDir: false,
            rollupOptions: {
                input,
                // Kernel externalization is NOT done here via `external` — kernelEsmExternalRequirePlugin
                // (plugins below) owns it, so CJS deps' `require('react')` gets rewritten to imports
                // instead of rolldown's throwing browser `__require` shim (see the plugin's doc).
                output: {
                    chunkFileNames: 'chunks/[name]-[hash].js',
                    // Reusable vendor chunks (react kernel / per-package / vendor tail) — the entry stays
                    // the widget's own code; every additional widget of this app reuses the vendor chunks.
                    codeSplitting: widgetCodeSplitting(),
                    entryFileNames: 'widgets/[name].js',
                    format: 'es',
                    strictExecutionOrder: true,
                },
                // 'allow-extension' (not 'exports-only') is required alongside includeDependenciesRecursively:false;
                // widget entries only need their `mount` export preserved, which this keeps.
                preserveEntrySignatures: 'allow-extension',
            },
            target: 'es2022',
        },
        plugins: [
            ...(options.plugins ?? []),
            react(),
            svgr(),
            plugin,
            ...(kernelExternal ? [kernelImportmapManifestPlugin(), kernelEsmExternalRequirePlugin()] : []),
        ],
        // `vite preview --config vite.config.widgets.ts` serves dist cross-origin for the shell dev loop.
        preview: { cors: true },
        resolve: { tsconfigPaths: true },
    }

    return defineConfig(options.overrides ? mergeConfig(base, options.overrides) : base)
}
