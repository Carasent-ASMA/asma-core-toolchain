import type { Plugin } from 'vite'

const KB = 1024

// ── ANSI helpers ────────────────────────────────────────────────────────────
const C = {
    blue: '\x1b[94m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
    gray: '\x1b[90m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    reset: '\x1b[0m',
    yellow: '\x1b[33m',
}

const R = (s: string) => `${C.red}${s}${C.reset}`
const G = (s: string) => `${C.green}${s}${C.reset}`
const Y = (s: string) => `${C.yellow}${s}${C.reset}`
const Cc = (s: string) => `${C.cyan}${s}${C.reset}`
const D = (s: string) => `${C.dim}${s}${C.reset}`
const B = (s: string) => `${C.bold}${s}${C.reset}`
const Bl = (s: string) => `${C.blue}${s}${C.reset}`

const fmtKB = (bytes: number) => (bytes / KB).toFixed(1)
const SEP = D('─'.repeat(70))

// ── Tier definitions (mobile-first) ─────────────────────────────────────────
// prettier-ignore
const TIERS = [
    {
        bar: '▕',
        color: R,
        guide: 'Keep only if: (a) dynamic-import-only, or (b) kernel lib needing 1:1 import-map target',
        label: '< 15 KB',
        maxKB: 15,
        tag: 'too small — merge into vendor',
        warn: true,
    },
    {
        bar: '▏',
        color: Y,
        guide: 'Keep if it changes independently often. Otherwise → vendor',
        label: '15–30 KB',
        maxKB: 30,
        tag: 'borderline — consider merging',
        warn: false,
    },
    {
        bar: '▎',
        color: D,
        guide: 'Could absorb nearby small deps to hit the green sweet spot',
        label: '30–80 KB',
        maxKB: 80,
        tag: 'fine — merge smaller chunks to reach 80 KB ✓',
        warn: false,
    },
    { bar: '▍', color: G, guide: '', label: '80–150 KB', maxKB: 150, tag: 'sweet spot ✓', warn: false },
    {
        bar: '▌',
        color: Y,
        guide: 'Heavy lib — must be behind dynamic import(). If in entry chunk, move it',
        label: '150–300 KB',
        maxKB: 300,
        tag: 'acceptable only if lazy-loaded',
        warn: false,
    },
    {
        bar: '▋',
        color: R,
        guide: 'Too large for a single chunk on mobile. Split into smaller libs or lazy-load',
        label: '300+ KB',
        maxKB: Infinity,
        tag: 'over limit — split or lazy-load',
        warn: true,
    },
] as const

const DEFAULT_MAX_TOTAL_MB = 5
const BAR_MAX = 20
const TOO_SMALL_THRESHOLD = TIERS[0].maxKB
const TOO_BIG_THRESHOLD = TIERS[TIERS.length - 2]!.maxKB

// Built-in exemptions — always safe, never app-specific.
const BUILTIN_EXEMPT_RE = /(?:^|\/)(?:vendor|index|rolldown-runtime|esm-external-require)-/

// ── Public API ──────────────────────────────────────────────────────────────

/** One exclusion rule — a regex tested against the chunk file name and a human-readable reason. */
export interface ChunkGuardExclude {
    /** Regex tested against the chunk file name (e.g. `chunks/asma-types-abc123.js`). */
    test: RegExp
    /** Why this chunk is exempt — printed in the guard output so the reason is always documented. */
    reason: string
}

export interface ChunkGuardOptions {
    /** Total JS budget in MB. Default 5. */
    maxTotalMB?: number
    /**
     * Chunks matching these patterns are exempt from the < 15 KB "too small" rule.
     * Use for kernel libs (1:1 import-map targets), known dynamic-import-only chunks,
     * and deliberate small-leaf chunks that must stay separate.
     */
    smallExcludes?: ChunkGuardExclude[]
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Walk the static import graph from all entry chunks. Any chunk reachable via
 * static imports from an entry is loaded at boot. Chunks NOT reachable via
 * static imports are dynamic-import-only (or dead code) — fine at any size.
 */
function buildStaticReachableSet(chunks: { fileName: string; isEntry?: boolean; imports?: string[] }[]): Set<string> {
    const reachable = new Set<string>()
    const queue: string[] = []
    for (const c of chunks) {
        if (c.isEntry) {
            reachable.add(c.fileName)
            queue.push(c.fileName)
        }
    }
    const chunkMap = new Map(chunks.map((c) => [c.fileName, c]))
    while (queue.length > 0) {
        const name = queue.shift()!
        const chunk = chunkMap.get(name)
        if (!chunk) continue
        for (const imp of chunk.imports ?? []) {
            if (!reachable.has(imp)) {
                reachable.add(imp)
                queue.push(imp)
            }
        }
    }
    return reachable
}

/**
 * Check a chunk against the exclude list. Returns the matching exclude entry
 * (with its reason) or null.
 */
function findExemption(fileName: string, excludes: ChunkGuardExclude[]): ChunkGuardExclude | null {
    for (const ex of excludes) {
        if (ex.test.test(fileName)) return ex
    }
    return null
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export function chunkGuardPlugin(options?: ChunkGuardOptions): Plugin {
    const maxTotalMB = options?.maxTotalMB ?? DEFAULT_MAX_TOTAL_MB
    const excludes = options?.smallExcludes ?? []
    const MAX_TOTAL_JS_BYTES = maxTotalMB * KB * KB

    return {
        apply: 'build',
        enforce: 'post',
        name: 'asma-chunk-guard',

        generateBundle(_options, bundle) {
            const chunks = Object.values(bundle).filter(
                (c): c is Extract<(typeof bundle)[string], { type: 'chunk' }> => c.type === 'chunk',
            )
            const totalBytes = chunks.reduce((sum, c) => sum + (c.code?.length ?? 0), 0)

            // ── Bucket every chunk into a tier ───────────────────────────────
            const buckets: { tier: (typeof TIERS)[number]; chunks: typeof chunks }[] = TIERS.map((t) => ({
                chunks: [],
                tier: t,
            }))

            // Pre-compute static-reachable set: chunks reachable from entries
            // via static imports are loaded at boot. Everything else is
            // dynamic-import-only (or dead code) — fine at any size.
            const staticReachable = buildStaticReachableSet(chunks)

            // Track exempted chunks with their reasons for the summary.
            const exempted: { chunk: (typeof chunks)[number]; reason: string }[] = []

            for (const c of chunks) {
                const sizeKB = (c.code?.length ?? 0) / KB
                if (sizeKB < TOO_SMALL_THRESHOLD) {
                    // Built-in exemptions (vendor, index, runtime, esm-external-require).
                    if (BUILTIN_EXEMPT_RE.test(c.fileName)) {
                        buckets[1]!.chunks.push(c)
                        continue
                    }
                    // Dynamic-import-only — automatic, no config needed.
                    if (!staticReachable.has(c.fileName)) {
                        exempted.push({ chunk: c, reason: 'dynamic-import-only (not in static boot graph)' })
                        buckets[1]!.chunks.push(c)
                        continue
                    }
                    // User-configured excludes with required reasons.
                    const exemption = findExemption(c.fileName, excludes)
                    if (exemption) {
                        exempted.push({ chunk: c, reason: exemption.reason })
                        buckets[1]!.chunks.push(c)
                        continue
                    }
                }
                for (const b of buckets) {
                    if (sizeKB <= b.tier.maxKB) {
                        b.chunks.push(c)
                        break
                    }
                }
            }

            // ── Header ───────────────────────────────────────────────────────
            console.info(`\n${SEP}`)
            console.info(`${Cc(B('▸ chunk guard'))}  ${D(`mobile-first · total budget ${maxTotalMB} MB`)}`)
            console.info(SEP)

            // ── Distribution bar ─────────────────────────────────────────────
            const maxCount = Math.max(1, ...buckets.map((b) => b.chunks.length))
            for (const { tier, chunks: tierChunks } of buckets) {
                const n = tierChunks.length
                const barLen = Math.max(n > 0 ? 1 : 0, Math.round((n / maxCount) * BAR_MAX))
                const bar = tier.color(tier.bar.repeat(Math.min(barLen, BAR_MAX)))
                const count = n > 0 ? B(String(n)) : D('0')
                const pct = D(`(${((n / chunks.length) * 100).toFixed(0)}%)`)
                const label = tier.color(tier.label.padEnd(11))
                const tag = n > 0 ? tier.color(tier.tag) : ''
                console.info(`  ${bar} ${label} ${count} ${pct}  ${tag}`)
                if (n > 0 && tier.guide) {
                    console.info(`         ${Bl('↳')} ${Bl(tier.guide)}`)
                }
            }

            // ── Violations ───────────────────────────────────────────────────
            const tiny = buckets[0]!.chunks
            if (tiny.length > 0) {
                console.warn(`\n  ${Y('●')} ${Y(`${tiny.length} chunk(s) too small (< ${TOO_SMALL_THRESHOLD} KB):`)}`)
                for (const c of tiny) {
                    console.warn(`    ${D('·')} ${Y(fmtKB(c.code?.length ?? 0) + ' KB')}  ${D(c.fileName)}`)
                }
                console.warn(`    ${Y('Each costs ~5–10ms parse overhead. Merge into vendor?')}`)
            }

            const fat = buckets[buckets.length - 1]!.chunks
            for (const c of fat) {
                console.warn(
                    `\n  ${R('●')} ${R(fmtKB(c.code?.length ?? 0) + ' KB')}  ${D(c.fileName)}  ${R('↑ over ' + TOO_BIG_THRESHOLD + ' KB — split or lazy-load')}`,
                )
            }

            // ── Exempt summary ────────────────────────────────────────────────
            if (exempted.length > 0) {
                console.info(
                    `\n  ${Bl('ℹ')} ${Bl(`${exempted.length} chunk(s) exempt from < ${TOO_SMALL_THRESHOLD} KB rule:`)}`,
                )
                for (const { chunk, reason } of exempted) {
                    console.info(`    ${D('·')} ${Bl(fmtKB(chunk.code?.length ?? 0) + ' KB')}  ${Bl(chunk.fileName)}`)
                    console.info(`      ${D(reason)}`)
                }
            }

            // ── Total ────────────────────────────────────────────────────────
            const totalMB = fmtKB(totalBytes / KB)
            const overBudget = totalBytes > MAX_TOTAL_JS_BYTES
            if (overBudget) {
                console.warn(
                    `\n  ${R('●')} ${R('Total JS: ' + totalMB + ' MB')}  ${R('over ' + maxTotalMB + ' MB budget — audit the diff')}`,
                )
            } else {
                console.info(`\n  ${G('✓')} ${G(totalMB + ' MB total JS')}  ${D(`across ${chunks.length} chunks`)}`)
            }

            const violationCount = (tiny.length > 0 ? 1 : 0) + fat.length + (overBudget ? 1 : 0)
            if (violationCount === 0) {
                console.info(`  ${G('✓')} ${G('All chunks within guard rails')}\n`)
            } else {
                console.warn(`  ${Y(`⚠ ${violationCount} guard violation(s)`)}\n`)
            }
        },
    }
}
