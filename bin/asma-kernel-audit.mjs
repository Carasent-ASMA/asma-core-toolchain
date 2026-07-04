#!/usr/bin/env node
// asma-kernel-audit — the ADVISORY half of the kernel-externalization contract.
//
// The kernel set membership (which shared libs apps externalize) is a HUMAN decision recorded in
// ONE place: KERNEL_SPEC in asma-core-toolchain/src/kernel/spec.mjs. Everything downstream is
// computed from it — including the kernel PUBLISHER's package.json dependency names, which
// asma-infrastructure/asma-mfw-kernel/sync-deps.mjs GENERATES from the spec (its `--check` is the
// one hard cross-repo guard). Drift between the spec and what the kernel publishes is therefore
// impossible by construction, so the old `mirror` hard-gate is gone — this tool is now purely a
// PROMOTION SCOUT.
//
//   candidates   Scans the fleet's app package.json files for libs used by >= N apps that are NOT
//                already in the kernel and NOT deliberately excluded (KERNEL_SPEC.excluded) — the
//                promotion shortlist. ALWAYS exits 0: your push is never the moment this "drifts"
//                (another repo merging a dep is), so blocking on it would only teach --no-verify.
//                Runs on a schedule and reports into a tracking issue. A candidate is a proposal;
//                promotion stays a deliberate PR to KERNEL_SPEC (REQ-003), because externalizing a
//                lib whose browser-ESM readiness nobody verified is a runtime-crash class.
//
// Usage:
//   asma-kernel-audit candidates (--fleet <dir> | --org <org>) [--min-apps <n>] [--json]
//
// --fleet <dir>  superproject root; globs <dir>/*/asma-app-*/package.json (local / submodule CI).
// --org <org>    GitHub org; enumerates <org>/asma-app-* repos and reads each package.json via gh.
// --allow-offline  if the fleet can't be listed (no network / no gh auth), WARN and exit 0.

import { execFileSync } from 'node:child_process'
import { globSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// The single kernel declaration, imported DIRECTLY from source (plain .mjs — no `pnpm build`
// needed; REQ-002). Membership + exclusions both live here now.
import { KERNEL_SPEC } from '../src/kernel/spec.mjs'

const DEFAULT_MIN_APPS = 10

/** Every specifier apps externalize, derived from the spec. */
const KERNEL_EXTERNAL_SPECIFIERS = KERNEL_SPEC.libs.map((lib) => lib.specifier)

// ─── helpers ────────────────────────────────────────────────────────────────

/** The root package of a bare specifier: 'react/jsx-runtime' -> 'react', '@a/b/c' -> '@a/b'. */
function rootOf(specifier) {
    const parts = specifier.split('/')
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Deliberately-excluded lib → its reason, or null. `match` ending in `/` is a scope prefix. */
function isExcluded(name) {
    for (const { match, reason } of KERNEL_SPEC.excluded) {
        if (match.endsWith('/') ? name.startsWith(match) : name === match) return reason
    }
    return null
}

const stripRange = (v) => (v || '').replace(/^[\^~]/, '')

function gh(args) {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Raw file text from a repo path via the contents API (raw media type => no base64 decode). */
function ghRawFile(repo, filePath) {
    return gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${filePath}`])
}

/** All <org>/asma-app-* repo names (paginated). */
function listOrgAppRepos(org) {
    const raw = gh(['api', '--paginate', `orgs/${org}/repos?per_page=100`, '--jq', '.[].name'])
    return raw
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('asma-app-'))
        .sort()
}

/** Recursive byte size of an installed package dir (best-effort; no symlink following). */
function dirSize(dir) {
    let total = 0
    let entries
    try {
        entries = readdirSync(dir, { withFileTypes: true })
    } catch {
        return 0
    }
    for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) total += dirSize(full)
        else if (e.isFile()) {
            try {
                total += statSync(full).size
            } catch {
                /* ignore */
            }
        }
    }
    return total
}

const kb = (bytes) => `${Math.round(bytes / 1024)}kb`

// ─── candidates ─────────────────────────────────────────────────────────────

function collectApps({ fleet, org, allowOffline }) {
    if (fleet) {
        return globSync('*/asma-app-*/package.json', { cwd: fleet }).map((rel) => ({
            app: rel.split('/')[1],
            pkg: JSON.parse(readFileSync(path.join(fleet, rel), 'utf8')),
            root: path.join(fleet, path.dirname(rel)),
        }))
    }
    let repos
    try {
        repos = listOrgAppRepos(org)
    } catch (err) {
        const msg = `could not list ${org} repos (no network or no gh auth): ${err.message?.split('\n')[0]}`
        if (allowOffline) {
            console.warn(`⚠ asma-kernel-audit candidates: skipped — ${msg}`)
            process.exit(0)
        }
        console.error(`asma-kernel-audit candidates: ${msg}`)
        process.exit(2)
    }
    const apps = []
    for (const repo of repos) {
        try {
            apps.push({ app: repo, pkg: JSON.parse(ghRawFile(`${org}/${repo}`, 'package.json')), root: null })
        } catch {
            console.warn(`⚠ skipped ${org}/${repo}: no readable package.json`)
        }
    }
    return apps
}

function runCandidates(opts) {
    const minApps = opts.minApps ?? DEFAULT_MIN_APPS
    // Already in the kernel: every spec root specifier, plus the legacy alias names (the same lib
    // under a transitional name — don't nag to promote what's already served under its new name).
    const alreadyHandled = new Set(
        KERNEL_EXTERNAL_SPECIFIERS.map(rootOf).concat(Object.keys(KERNEL_SPEC.legacyAliases)),
    )

    const apps = collectApps(opts)
    // lib -> { apps: Set, versions: Set }
    const usage = new Map()
    for (const { app, pkg } of apps) {
        const deps = { ...pkg.peerDependencies, ...pkg.dependencies }
        for (const [name, range] of Object.entries(deps)) {
            if (!usage.has(name)) usage.set(name, { apps: new Set(), versions: new Set() })
            const u = usage.get(name)
            u.apps.add(app)
            u.versions.add(stripRange(range))
        }
    }

    const rows = []
    const excludedPopular = []
    for (const [name, u] of usage) {
        if (u.apps.size < minApps) continue
        if (alreadyHandled.has(rootOf(name))) continue
        const reason = isExcluded(name)
        if (reason) {
            excludedPopular.push({ name, apps: u.apps.size, reason })
            continue
        }
        rows.push({
            name,
            apps: u.apps.size,
            versions: [...u.versions].sort(),
            size: annotateSize(name, opts),
        })
    }
    rows.sort((a, b) => b.apps - a.apps || a.name.localeCompare(b.name))
    excludedPopular.sort((a, b) => b.apps - a.apps)

    if (opts.json) {
        console.log(JSON.stringify({ check: 'candidates', minApps, totalApps: apps.length, candidates: rows, excludedPopular }, null, 2))
        return
    }

    console.log(`# Kernel promotion candidates — libs used by ≥${minApps} of ${apps.length} apps, not yet in the kernel\n`)
    if (!rows.length) {
        console.log('✅ Nothing to promote.')
    } else {
        console.log('These clear the fleet-usage bar. Promotion is a deliberate PR to KERNEL_SPEC')
        console.log('(asma-core-toolchain/src/kernel/spec.mjs). Confirm each ships browser ESM and its')
        console.log('fleet version spread can converge to one kernel-served version first.\n')
        const w = Math.max(...rows.map((r) => r.name.length), 4)
        console.log(`  ${'LIB'.padEnd(w)}  APPS  ${'SIZE'.padEnd(8)}VERSIONS`)
        for (const r of rows) {
            console.log(`  ${r.name.padEnd(w)}  ${String(r.apps).padEnd(4)}  ${(r.size ?? '').padEnd(8)}${r.versions.join(', ')}`)
        }
    }
    if (excludedPopular.length) {
        console.log('\n(Popular but deliberately excluded — no action:)')
        for (const e of excludedPopular) console.log(`  - ${e.name} (${e.apps} apps): ${e.reason}`)
    }
}

/** Best-effort installed size, only when a local node_modules is reachable (--fleet mode). */
function annotateSize(name, opts) {
    if (!opts.fleet) return ''
    for (const base of [path.join(opts.fleet, 'node_modules', name), path.join(process.cwd(), 'node_modules', name)]) {
        try {
            if (statSync(base).isDirectory()) return kb(dirSize(base))
        } catch {
            /* try next */
        }
    }
    return 'n/a'
}

// ─── arg parsing + dispatch ───────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = { json: false, allowOffline: false }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--json') opts.json = true
        else if (a === '--allow-offline') opts.allowOffline = true
        else if (a === '--fleet') opts.fleet = argv[++i]
        else if (a === '--org') opts.org = argv[++i]
        else if (a === '--min-apps') opts.minApps = Number(argv[++i])
        else {
            console.error(`asma-kernel-audit: unknown option "${a}"`)
            process.exit(2)
        }
    }
    return opts
}

const command = process.argv[2]
const opts = parseArgs(process.argv.slice(3))

switch (command) {
    case 'candidates':
        if (!opts.fleet && !opts.org) {
            console.error('asma-kernel-audit candidates: pass --fleet <superproject-dir> or --org <github-org>')
            process.exit(2)
        }
        runCandidates(opts)
        break
    default:
        console.error(`asma-kernel-audit: unknown command "${command ?? ''}" — the only command is: candidates`)
        process.exit(2)
}
