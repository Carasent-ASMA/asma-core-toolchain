import react from '@vitejs/plugin-react'
import { qiankun } from 'asma-qiankun-plugin-vite'
import { type ConfigEnv, defineConfig, loadEnv, type PluginOption, type UserConfig } from 'vite'
import svgr from 'vite-plugin-svgr'

export { isKernelExternalBuild, KERNEL_EXTERNAL_SPECIFIERS, kernelImportmapManifestPlugin } from './kernelExternal.js'

/**
 * Resolves the vite `base` and dev-server port from env, honoring the multiversion
 * deployment strategy (BASE_PATH_MULTIV_STRATEGY + VERSION segment in the base URL).
 */
export function getBasePathAndPort(mode: string) {
    process.env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }

    const PORT = process.env['PORT'] ? parseInt(process.env['PORT']) : undefined

    const MULTIV_DEPLOYMENT_STRATEGY = process.env['MULTIV_DEPLOYMENT_STRATEGY'] === 'true'

    const BASE_PATH = (
        MULTIV_DEPLOYMENT_STRATEGY ? process.env['BASE_PATH_MULTIV_STRATEGY'] : process.env['BASE_PATH']
    )?.replace(/'/g, '')

    const VERSION = process.env['VERSION']

    if (!VERSION && MULTIV_DEPLOYMENT_STRATEGY) {
        throw new Error('VERSION is not defined')
    }
    const npm_package_name = process.env['npm_package_name']

    const base = `${BASE_PATH}${MULTIV_DEPLOYMENT_STRATEGY ? '/' + npm_package_name + '/' + VERSION : ''}`

    console.info(
        'BASE_PATH',
        BASE_PATH,
        'VERSION',
        VERSION,
        'PORT',
        PORT,
        'MULTIV_DEPLOYMENT_STRATEGY',
        MULTIV_DEPLOYMENT_STRATEGY,
        'base',
        base,
    )
    return { base, PORT }
}

export type ChunkGroups = Record<string, string[]>

/**
 * The shared `manualChunks` walker used by every asma-app-* build.
 *
 * - `packageGroups`: chunk name -> npm package names (matched as `/node_modules/<name>/`).
 *   Entries starting with `./` are matched as local paths instead.
 * - `localGroups`: chunk name -> app source path fragments.
 */
export function createManualChunks(packageGroups: ChunkGroups, localGroups: ChunkGroups = {}) {
    return (moduleId: string): string | undefined => {
        const normalizedModuleId = moduleId.replaceAll('\\', '/')

        for (const [chunkName, packages] of Object.entries(packageGroups)) {
            for (const packageName of packages) {
                if (packageName.startsWith('./')) {
                    const localPath = packageName.slice(1)

                    if (normalizedModuleId.includes(localPath)) {
                        return chunkName
                    }

                    continue
                }

                if (normalizedModuleId.includes(`/node_modules/${packageName}/`)) {
                    return chunkName
                }
            }
        }

        for (const [chunkName, paths] of Object.entries(localGroups)) {
            if (paths.some((path) => normalizedModuleId.includes(path))) {
                return chunkName
            }
        }

        return undefined
    }
}

/** Standard app build options: chunk-size limit + shared manualChunks walker. */
export function createAsmaBuildOptions(
    packageGroups: ChunkGroups,
    localGroups: ChunkGroups = {},
): NonNullable<UserConfig['build']> {
    return {
        chunkSizeWarningLimit: 1000,
        rollupOptions: {
            output: {
                manualChunks: createManualChunks(packageGroups, localGroups),
            },
        },
    }
}

export type AsmaAppViteOptions = {
    /** App package name — forwarded to the qiankun plugin; must match the registered microapp name. */
    name: string
    /** Fallback dev-server port when the PORT env variable is not set. */
    port: number
    /** Dev-server host. Default: 'localhost'. */
    host?: string
    proxy?: NonNullable<UserConfig['server']>['proxy']
    /** App-specific plugins (tailwind, nodePolyfills, widgetDev, …), run before the shared qiankun/react/svgr trio. */
    plugins?: PluginOption[]
    build?: UserConfig['build']
    optimizeDeps?: UserConfig['optimizeDeps']
    /** qiankun plugin useDevMode. Default: true. */
    qiankunDevMode?: boolean
}

/**
 * Shared vite config for asma-app-* micro-frontends — the single source that used to be
 * copied from template-vitemf-react into every app. App-specific bits come in via options.
 */
export function defineAsmaAppConfig(options: AsmaAppViteOptions) {
    return ({ mode }: ConfigEnv) => {
        const { PORT, base } = getBasePathAndPort(mode)

        return defineConfig({
            base,
            build: options.build,
            optimizeDeps: options.optimizeDeps,
            plugins: [
                ...(options.plugins ?? []),
                qiankun(options.name, { useDevMode: options.qiankunDevMode ?? true }),
                react(),
                svgr(),
            ],
            resolve: {
                tsconfigPaths: true,
            },
            server: {
                cors: true,
                hmr: {
                    protocol: 'ws',
                },
                host: options.host ?? 'localhost',
                port: PORT || options.port,
                proxy: options.proxy,
            },
        })
    }
}
