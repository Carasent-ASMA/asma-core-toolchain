#!/usr/bin/env node
// Shared dev/build/preview runner for asma-app-* micro-frontends.
// Replaces the per-app `dev` / `dev:win` / `build` / `preview` scripts that had
// drifted into many variants (10 `build` variants across 16 apps). Cross-platform
// (plain Node fs + spawn), so the Windows-only `dev:win` copy dance is no longer needed.
//
// Usage (in an app's package.json):
//   "dev": "asma-app dev", "build": "asma-app build", "preview": "asma-app preview"
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const NODE_OPTIONS = '--max_old_space_size=4164'

/** Seed configs/env.local.ts from the example on first run (apps gitignore env.local.ts). */
function ensureEnvLocal() {
    if (!existsSync('configs/env.local.ts') && existsSync('configs/env.local.example.ts')) {
        copyFileSync('configs/env.local.example.ts', 'configs/env.local.ts')
    }
}

/** True if the app uses gql.tada (declares the dep) — gates the `gql-tada check` build step. */
function usesGqlTada() {
    try {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
        return 'gql.tada' in { ...pkg.dependencies, ...pkg.devDependencies }
    } catch {
        return false
    }
}

// Run a node_modules/.bin command line, inheriting stdio; exit on failure.
// Passed as a single trusted string (no user input) so `shell: true` stays free of
// Node's DEP0190 arg-escaping warning while still resolving .bin/.cmd cross-platform.
function run(commandLine, extraEnv = {}) {
    const res = spawnSync(commandLine, { stdio: 'inherit', shell: true, env: { ...process.env, ...extraEnv } })
    if (res.status !== 0) {
        process.exit(res.status ?? 1)
    }
}

const command = process.argv[2]

switch (command) {
    case 'dev': {
        ensureEnvLocal()
        run('vite')
        break
    }
    case 'build': {
        ensureEnvLocal()
        const env = { NODE_OPTIONS }
        run('tsc', env)
        if (usesGqlTada()) {
            run('gql-tada check', env)
        }
        run('vite build', env)
        break
    }
    case 'preview': {
        if (existsSync('configs/env.local.ts')) {
            mkdirSync(dirname('generated/__ENV.ts'), { recursive: true })
            copyFileSync('configs/env.local.ts', 'generated/__ENV.ts')
        }
        run('vite preview')
        break
    }
    default: {
        console.error(`asma-app: unknown command "${command ?? ''}" — use one of: dev | build | preview`)
        process.exit(1)
    }
}
