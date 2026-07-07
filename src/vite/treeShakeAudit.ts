import fs from 'node:fs'
import path from 'node:path'

import type { Plugin, ResolvedConfig } from 'vite'
import { parseSync } from 'vite'

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

const Y = (s: string) => `${C.yellow}${s}${C.reset}`
const G = (s: string) => `${C.green}${s}${C.reset}`
const Cc = (s: string) => `${C.cyan}${s}${C.reset}`
const D = (s: string) => `${C.dim}${s}${C.reset}`
const B = (s: string) => `${C.bold}${s}${C.reset}`
const Bl = (s: string) => `${C.blue}${s}${C.reset}`

/** bytes → "12.3 KB" (the ONLY place bytes become KB — everything internal stays in bytes) */
const kb = (bytes: number) => `${(bytes / KB).toFixed(1)} KB`
const SEP = D('─'.repeat(70))

// How much retained weight a package must carry before we bother auditing it (bytes).
const PKG_THRESHOLD_BYTES = 40 * KB
// A root whose own rendered body is smaller than this and that re-exports same-package
// modules is treated as a barrel and "exploded" into the symbols it re-exports.
const BARREL_MAX_BYTES = 1.5 * KB
// Presentation caps.
const MAX_PACKAGES = 12
const MAX_SYMBOLS = 8
// Flag packages where less than this fraction of bundled bytes is attributable to imports.
const UTILIZATION_FLAG = 0.75

// ── Public API ──────────────────────────────────────────────────────────────

export interface TreeShakeAuditOptions {
    /**
     * Directories to scan for source imports (relative to the project root).
     * Default: ['src', 'configs', 'generated']. Add app-specific directories
     * like 'openreplay' as needed.
     */
    sourceDirs?: string[]
}

// ── Source import scanner (symbol NAMES for the header only) ──────────────────

interface PkgImport {
    /** Named/default/namespace symbols, e.g. ["Button", "Table"] or ["default"] */
    symbols: string[]
    /** Source files that import from this package */
    files: string[]
}

/** Scan the bundled source roots' *.ts/*.tsx for import statements. Returns map of package → imports. */
function scanSourceImports(root: string, sourceDirs: string[]): Map<string, PkgImport> {
    const imports = new Map<string, PkgImport>()
    // Everything that can land in the app bundle — not just src/.
    const files: string[] = []
    for (const dir of sourceDirs) {
        const full = path.join(root, dir)
        if (fs.existsSync(full)) files.push(...walkTs(full))
    }
    const rootEntry = path.join(root, 'index.ts')
    if (fs.existsSync(rootEntry)) files.push(rootEntry)

    for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8')
        const rel = path.relative(root, file)

        const record = (pkg: string, symbols: string[]): void => {
            if (pkg.startsWith('.') || pkg.startsWith('@/') || pkg.startsWith('node:')) return
            const existing = imports.get(pkg) ?? { files: [], symbols: [] }
            for (const sym of symbols) {
                if (!existing.symbols.includes(sym)) existing.symbols.push(sym)
            }
            if (!existing.files.includes(rel)) existing.files.push(rel)
            imports.set(pkg, existing)
        }

        // import d from | import { a, b } from | import d, { a } from | import * as x from |
        // export { a } from | export * from. Type-only imports are skipped (they cost 0 bytes).
        // ReDoS lint disabled: this only ever runs on our own trusted source tree.
        const re =
            // eslint-disable-next-line regexp/no-super-linear-backtracking
            /(?:import|export)\s+(type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s*(?:as\s+\w+)?)?\s*from\s*['"]([^'"]+)['"]/g
        let m: RegExpExecArray | null
        while ((m = re.exec(content)) !== null) {
            if (m[1]) continue
            const symbols: string[] = m[2] ? ['default'] : []
            for (const raw of (m[3] ?? '').split(',')) {
                const s = raw.replace(/\s+as\s+[\w$]+/, '').trim()
                if (s && !s.startsWith('type ')) symbols.push(s)
            }
            record(m[4]!, symbols.length > 0 ? symbols : ['*'])
        }
        // (await import('pkg')).member — a statically-known single symbol.
        const dynMemberRe = /import\(\s*['"]([^'"]+)['"]\s*\)\s*\)\s*\.\s*([\w$]+)/g
        while ((m = dynMemberRe.exec(content)) !== null) record(m[1]!, [m[2]!])
        // Dynamic import('pkg') and bare side-effect import 'pkg'.
        const extraRe = /import\s*(?:\(\s*)?['"]([^'"]+)['"]/g
        while ((m = extraRe.exec(content)) !== null) record(m[1]!, ['*'])
    }

    return imports
}

function walkTs(dir: string): string[] {
    const files: string[] = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue
            files.push(...walkTs(full))
        } else if (/\.(?:ts|tsx)$/.test(e.name)) {
            files.push(full)
        }
    }
    return files
}

// ── Module-id → package + relative-path parsing ──────────────────────────────

const PKG_RE_PNPM = /node_modules[\\/]\.pnpm[\\/].+?[\\/]node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)[\\/](.*)/
const PKG_RE_PLAIN = /node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)[\\/](.*)/

function parseId(id: string): { pkg: string; rel: string } | null {
    const m = id.match(PKG_RE_PNPM) ?? id.match(PKG_RE_PLAIN)
    if (!m) return null
    return { pkg: m[1]!, rel: m[2]! }
}

/** Human-friendly symbol label from a module's relative path (drops dist/es/lib + index). */
function symbolLabel(rel: string): string {
    let p = rel.replace(/\.(?:m?js|cjs)$/, '')
    p = p.replace(/^(?:dist\/)?(?:es|esm|lib|src|module|cjs|dist)\//, '')
    p = p.replace(/\/index$/, '')
    return p.split('/').filter(Boolean).join('/') || rel
}

// ── Statement-level attribution inside a single non-tree-shakable module ─────
//
// Tree-shaking cannot split a blob module, but we can still answer "what do MY
// symbols actually cost inside it". We parse the module's ORIGINAL source (the
// rendered code has import/export statements rewritten away), build a top-level
// declaration graph (statement → statements whose declarations it references),
// and BFS from the exports the app imports. Shared internal helpers are counted
// ONCE (union), split into exclusive vs shared per symbol — the same semantics
// as the module-level engine. Byte counts are scaled original → rendered.

interface EsNode {
    type: string
    start?: number
    end?: number
    [key: string]: unknown
}

export interface BlobSymbolWeight {
    name: string
    /** bytes only this symbol needs (freed if you stop importing it) */
    exclusiveBytes: number
    /** bytes this symbol needs at all (exclusive + shared internals it touches) */
    reachBytes: number
    /** exclusiveBytes scaled to shipped (minified) size */
    exclusiveMinBytes: number
    /** reachBytes scaled to shipped (minified) size */
    reachMinBytes: number
}

export interface BlobAnalysis {
    symbols: BlobSymbolWeight[]
    /** union of your symbols' reach + top-level side effects — each byte counted once */
    neededBytes: number
    /** neededBytes scaled to shipped (minified) size */
    neededMinBytes: number
    /** the module's full rendered size */
    totalBytes: number
    /** the module's shipped (minified) estimate */
    totalMinBytes: number
    /** bytes of top-level statements not reachable from any export (run on import) */
    sideEffectBytes: number
    exportCount: number
}

/** Names declared by a top-level statement (incl. import locals and exported decls). */
function declaredNames(stmt: EsNode): string[] {
    switch (stmt.type) {
        case 'ExportDefaultDeclaration':
        case 'ExportNamedDeclaration': {
            const d = stmt['declaration'] as EsNode | null | undefined
            return d && typeof d === 'object' && 'type' in d ? declaredNames(d) : []
        }
        case 'ClassDeclaration':
        case 'FunctionDeclaration': {
            const id = stmt['id'] as { name?: string } | null | undefined
            return id?.name ? [id.name] : []
        }
        case 'ImportDeclaration': {
            const out: string[] = []
            for (const s of (stmt['specifiers'] as EsNode[] | undefined) ?? []) {
                const local = s['local'] as { name?: string } | undefined
                if (local?.name) out.push(local.name)
            }
            return out
        }
        case 'VariableDeclaration': {
            const out = new Set<string>()
            for (const d of (stmt['declarations'] as EsNode[] | undefined) ?? []) {
                collectIdentifiers(d['id'], out)
            }
            return [...out]
        }
        default:
            return []
    }
}

/** All identifier names referenced in a node (skips non-computed member/property keys). */
function collectIdentifiers(node: unknown, out: Set<string>): void {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
        for (const n of node) collectIdentifiers(n, out)
        return
    }
    const n = node as EsNode
    if (n.type === 'Identifier' && typeof n['name'] === 'string') {
        out.add(n['name'])
        return
    }
    const skipKey = n['computed']
        ? null
        : n.type === 'MemberExpression'
          ? 'property'
          : n.type === 'Property' || n.type === 'MethodDefinition' || n.type === 'PropertyDefinition'
            ? 'key'
            : null
    for (const [k, v] of Object.entries(n)) {
        if (k === 'type' || k === 'start' || k === 'end' || k === skipKey) continue
        collectIdentifiers(v, out)
    }
}

/** export name → { local decl names, statement index }. */
function collectExports(body: EsNode[]): Map<string, { locals: string[]; stmtIdx: number }> {
    const map = new Map<string, { locals: string[]; stmtIdx: number }>()
    body.forEach((stmt, i) => {
        if (stmt.type === 'ExportNamedDeclaration') {
            for (const spec of (stmt['specifiers'] as EsNode[] | undefined) ?? []) {
                const exported = spec['exported'] as { name?: string; value?: string } | undefined
                const local = spec['local'] as { name?: string } | undefined
                const name = exported?.name ?? exported?.value
                if (name) map.set(name, { locals: local?.name ? [local.name] : [], stmtIdx: i })
            }
            for (const name of declaredNames(stmt)) map.set(name, { locals: [name], stmtIdx: i })
        } else if (stmt.type === 'ExportDefaultDeclaration') {
            const d = stmt['declaration'] as EsNode | undefined
            const locals = d?.type === 'Identifier' && typeof d['name'] === 'string' ? [d['name']] : []
            map.set('default', { locals, stmtIdx: i })
        }
    })
    return map
}

/**
 * Statement-level per-symbol cost for a blob module. Returns null when the file
 * cannot be parsed or exposes no static ESM exports (e.g. CJS interop).
 */
function analyzeBlobModule(
    moduleId: string,
    renderedBytes: number,
    minifiedBytes: number,
    importedSymbols: string[],
): BlobAnalysis | null {
    const file = moduleId.split('?')[0]!
    if (file.startsWith('\0') || !fs.existsSync(file)) return null
    let body: EsNode[]
    try {
        const parsed = parseSync(file, fs.readFileSync(file, 'utf-8')) as unknown as {
            program?: { body?: EsNode[] }
        }
        body = parsed.program?.body ?? []
    } catch {
        return null
    }
    const exportsMap = collectExports(body)
    if (exportsMap.size === 0) return null // ponytail: CJS blobs stay module-level only

    const declToStmt = new Map<string, number>()
    const stmtBytes = body.map((s) => Math.max(0, (s.end ?? 0) - (s.start ?? 0)))
    body.forEach((s, i) => {
        for (const name of declaredNames(s)) declToStmt.set(name, i)
    })
    const originalTotal = stmtBytes.reduce((a, b) => a + b, 0)
    if (originalTotal === 0) return null
    const scale = renderedBytes / originalTotal
    const minScale = minifiedBytes / originalTotal

    // Edges: statement → statements declaring the names it references.
    const edges: number[][] = body.map((s) => {
        const refs = new Set<string>()
        collectIdentifiers(s, refs)
        const out = new Set<number>()
        for (const r of refs) {
            const t = declToStmt.get(r)
            if (t !== undefined) out.add(t)
        }
        return [...out]
    })
    const reach = (starts: number[]): Set<number> => {
        const seen = new Set<number>(starts)
        const stack = [...starts]
        while (stack.length) {
            for (const n of edges[stack.pop()!] ?? []) {
                if (!seen.has(n)) {
                    seen.add(n)
                    stack.push(n)
                }
            }
        }
        return seen
    }
    const rootsOf = (name: string): number[] => {
        const e = exportsMap.get(name)
        if (!e) return []
        const starts = [e.stmtIdx]
        for (const local of e.locals) {
            const t = declToStmt.get(local)
            if (t !== undefined) starts.push(t)
        }
        return starts
    }

    // Which exports does the app import? Named symbols win; namespace-only or
    // unresolvable → all exports.
    let wanted = importedSymbols.filter((s) => s !== '*' && exportsMap.has(s))
    if (wanted.length === 0) wanted = [...exportsMap.keys()]

    const perSymbol = new Map<string, Set<number>>()
    const reachedBy = new Map<number, number>()
    for (const name of wanted) {
        const reached = reach(rootsOf(name))
        perSymbol.set(name, reached)
        for (const i of reached) reachedBy.set(i, (reachedBy.get(i) ?? 0) + 1)
    }

    // Statements unreachable from ANY export run on import — always needed.
    const allExportReach = reach([...exportsMap.keys()].flatMap(rootsOf))
    let sideEffectBytes = 0
    const union = new Set<number>()
    body.forEach((_, i) => {
        if (!allExportReach.has(i)) sideEffectBytes += stmtBytes[i]!
    })
    for (const reached of perSymbol.values()) for (const i of reached) union.add(i)
    let unionBytes = 0
    for (const i of union) unionBytes += stmtBytes[i]!

    const symbols: BlobSymbolWeight[] = [...perSymbol.entries()]
        .map(([name, reached]) => {
            let exclusiveBytes = 0
            let reachBytes = 0
            for (const i of reached) {
                reachBytes += stmtBytes[i]!
                if (reachedBy.get(i) === 1) exclusiveBytes += stmtBytes[i]!
            }
            return {
                exclusiveBytes: Math.round(exclusiveBytes * scale),
                exclusiveMinBytes: Math.round(exclusiveBytes * minScale),
                name,
                reachBytes: Math.round(reachBytes * scale),
                reachMinBytes: Math.round(reachBytes * minScale),
            }
        })
        .sort((a, b) => b.reachBytes - a.reachBytes)

    const neededOriginal = Math.min(unionBytes + sideEffectBytes, originalTotal)
    return {
        exportCount: exportsMap.size,
        neededBytes: Math.round(neededOriginal * scale),
        neededMinBytes: Math.round(neededOriginal * minScale),
        sideEffectBytes: Math.round(sideEffectBytes * scale),
        symbols,
        totalBytes: renderedBytes,
        totalMinBytes: minifiedBytes,
    }
}

// ── Bundle-graph engine ───────────────────────────────────────────────────────

interface ModRec {
    pkg: string | null
    rel: string | null
    /** rendered (post-tree-shake, pre-minify) bytes that landed in the bundle */
    bytes: number
    /** rendered bytes scaled by the owning chunk's minify ratio (shipped estimate) */
    minBytes: number
    /** pre-tree-shake module source bytes */
    originalBytes: number
    used: string[]
    removed: string[]
}

export interface SymbolWeight {
    label: string
    /** bytes reachable ONLY from this symbol (within the package's retained subtree) */
    exclusiveBytes: number
    /** bytes reachable from this symbol at all (exclusive + shared it touches) */
    reachBytes: number
    /** exclusiveBytes as shipped (minified) estimate */
    exclusiveMinBytes: number
    /** reachBytes as shipped (minified) estimate */
    reachMinBytes: number
    moduleCount: number
}

export interface PkgFinding {
    pkg: string
    /** bytes of the package's OWN modules that landed */
    ownBytes: number
    /** pre-tree-shake bytes of the package's own modules that landed */
    originalBytes: number
    /** 0..1 — fraction of retained bytes attributable to your imports (null = unknown) */
    utilization: number | null
    /** statement-level attribution when the package is one non-tree-shakable blob */
    blob: BlobAnalysis | null
    /**
     * Retained bytes: everything that would be FREED from the bundle if you dropped this
     * package (own modules + private deps like rc-* or motion-dom, but NOT shared peers like
     * react that are reachable without going through this package).
     */
    retainedBytes: number
    /** retained bytes reached by ≥2 symbols, counted once */
    sharedBytes: number
    /** retained bytes not reachable from any symbol root (side-effect / boot-only) */
    unattributedBytes: number
    /** ownBytes scaled by the owning chunk's minify ratio — what actually ships (pre-gzip) */
    ownMinifiedBytes: number
    symbols: SymbolWeight[]
    moduleCount: number
    /** the single dominant module when the package is one blob (for advice) */
    soleModule: { rel: string; bytes: number; used: number } | null
    sourceSymbols: string[]
}

interface ChunkLike {
    code?: string | null
    modules?: Record<
        string,
        | {
              originalLength?: number
              renderedLength?: number
              removedExports?: string[]
              renderedExports?: string[]
          }
        | undefined
    >
}

type GetModuleInfo = (id: string) => {
    importedIds?: readonly string[]
    importers?: readonly string[]
    isEntry?: boolean
} | null

export interface Analysis {
    findings: PkgFinding[]
    graphOk: boolean
    /** Σ minified chunk code ÷ Σ rendered module bytes — a rough shipped-size multiplier. */
    minifyRatio: number
    renderedTotalBytes: number
    minifiedTotalBytes: number
}

export interface BundleMeta extends Analysis {
    generatedAt: string
}

function analyze(chunks: ChunkLike[], getModuleInfo: GetModuleInfo, sourceImports: Map<string, PkgImport>): Analysis {
    // 1. Collect every landed module with its rendered size. Modules are 1:1 with chunks
    //    (rolldown does not duplicate), but take max defensively in case one ever is.
    //    Each module also gets a minified estimate scaled by ITS OWN chunk's minify ratio
    //    (comment-heavy libs like lodash-es minify far better than the app average).
    const mods = new Map<string, ModRec>()
    let renderedTotal = 0
    for (const c of chunks) {
        const chunkRendered = Object.values(c.modules ?? {}).reduce((s, m) => s + (m?.renderedLength ?? 0), 0)
        const chunkRatio = chunkRendered > 0 ? (c.code?.length ?? 0) / chunkRendered : 1
        for (const [id, m] of Object.entries(c.modules ?? {})) {
            const bytes = m?.renderedLength ?? 0
            renderedTotal += bytes
            const prev = mods.get(id)
            if (prev) {
                if (bytes > prev.bytes) {
                    prev.bytes = bytes
                    prev.minBytes = Math.round(bytes * chunkRatio)
                }
            } else {
                const parsed = parseId(id)
                mods.set(id, {
                    bytes,
                    minBytes: Math.round(bytes * chunkRatio),
                    originalBytes: m?.originalLength ?? bytes,
                    pkg: parsed?.pkg ?? null,
                    rel: parsed?.rel ?? null,
                    removed: m?.removedExports ?? [],
                    used: m?.renderedExports ?? [],
                })
            }
        }
    }
    const minifiedTotal = chunks.reduce((s, c) => s + (c.code?.length ?? 0), 0)
    const minifyRatio = renderedTotal > 0 ? minifiedTotal / renderedTotal : 1

    // 2. Static import graph, restricted to modules that actually landed. Also record entry
    //    modules (true entries + anything with no static importer, e.g. dynamic-import targets).
    const edges = new Map<string, string[]>()
    const importers = new Map<string, string[]>()
    const roots: string[] = []
    let edgeCount = 0
    for (const id of mods.keys()) {
        const info = getModuleInfo(id)
        const out = (info?.importedIds ?? []).filter((x) => mods.has(x))
        edgeCount += out.length
        edges.set(id, out)
        const landedImporters = (info?.importers ?? []).filter((x) => mods.has(x))
        importers.set(id, landedImporters)
        if (info?.isEntry || landedImporters.length === 0) roots.push(id)
    }
    const graphOk = edgeCount > 0

    // 3. Per-package landed size (own modules only).
    const pkgLanded = new Map<string, number>()
    const pkgMinified = new Map<string, number>()
    const pkgOriginal = new Map<string, number>()
    const pkgMods = new Map<string, string[]>()
    for (const [id, m] of mods) {
        if (!m.pkg) continue
        pkgLanded.set(m.pkg, (pkgLanded.get(m.pkg) ?? 0) + m.bytes)
        pkgMinified.set(m.pkg, (pkgMinified.get(m.pkg) ?? 0) + m.minBytes)
        pkgOriginal.set(m.pkg, (pkgOriginal.get(m.pkg) ?? 0) + m.originalBytes)
        const arr = pkgMods.get(m.pkg)
        if (arr) arr.push(id)
        else pkgMods.set(m.pkg, [id])
    }

    /** BFS over static edges, optionally confined to `within` and skipping `skip`. */
    const walk = (starts: string[], opts: { within?: Set<string>; skip?: Set<string> } = {}): Set<string> => {
        const seen = new Set<string>()
        const stack: string[] = []
        for (const s of starts) {
            if (opts.skip?.has(s)) continue
            if (!seen.has(s)) {
                seen.add(s)
                stack.push(s)
            }
        }
        while (stack.length) {
            const x = stack.pop()!
            for (const n of edges.get(x) ?? []) {
                if (opts.skip?.has(n)) continue
                if (opts.within && !opts.within.has(n)) continue
                if (!seen.has(n)) {
                    seen.add(n)
                    stack.push(n)
                }
            }
        }
        return seen
    }

    const targets = [...pkgLanded.entries()]
        .filter(([, bytes]) => bytes >= PKG_THRESHOLD_BYTES)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_PACKAGES)
        .map(([pkg]) => pkg)

    const findings: PkgFinding[] = []

    for (const pkg of targets) {
        const own = pkgMods.get(pkg)!
        const ownBytes = pkgLanded.get(pkg) ?? 0
        const ownSet = new Set(own)

        // Single-blob package: attribute per-symbol at STATEMENT level inside the module.
        if (own.length === 1) {
            const only = mods.get(own[0]!)!
            const srcSymbols = sourceImports.get(pkg)?.symbols ?? []
            const blob = analyzeBlobModule(own[0]!, only.bytes, only.minBytes, srcSymbols)
            findings.push({
                blob,
                moduleCount: 1,
                originalBytes: only.originalBytes,
                ownBytes,
                ownMinifiedBytes: only.minBytes,
                pkg,
                retainedBytes: only.bytes,
                sharedBytes: 0,
                soleModule: { bytes: only.bytes, rel: only.rel ?? own[0]!, used: only.used.length },
                sourceSymbols: srcSymbols,
                symbols: [],
                unattributedBytes: 0,
                utilization: blob ? blob.neededBytes / Math.max(blob.totalBytes, 1) : null,
            })
            continue
        }

        // Retained set = landed modules that become unreachable from the entries once this
        // package is removed. `survives` is everything still reachable WITHOUT the package;
        // the rest is what this package uniquely drags in (own modules + private deps).
        const survives = graphOk ? walk(roots, { skip: ownSet }) : new Set<string>()
        const retained = new Set<string>()
        for (const id of mods.keys()) if (!survives.has(id)) retained.add(id)

        // Symbol roots: package modules imported from OUTSIDE the package (or entry-less),
        // then explode re-export barrels so roots line up with real symbols, not the index.
        let symbolRoots = own.filter((id) => {
            const imps = importers.get(id) ?? []
            return imps.length === 0 || imps.some((imp) => !ownSet.has(imp))
        })
        if (symbolRoots.length === 0) symbolRoots = own.slice()

        const rootSet = new Set(symbolRoots)
        let changed = true
        let guard = 0
        while (changed && guard++ < 20) {
            changed = false
            for (const r of Array.from(rootSet)) {
                const rec = mods.get(r)!
                const childrenInPkg = (edges.get(r) ?? []).filter((x) => ownSet.has(x))
                const base = (rec.rel ?? '').split('/').pop() ?? ''
                // A barrel/aggregator re-exports many same-package modules and holds little of
                // its own. Explode it into those modules so roots line up with real symbols
                // (Button, debounce, …) instead of the package index that pulls everything.
                const isBarrel =
                    childrenInPkg.length >= 20 ||
                    (childrenInPkg.length >= 6 && (base.startsWith('index.') || rec.bytes <= BARREL_MAX_BYTES)) ||
                    (rec.bytes <= BARREL_MAX_BYTES && childrenInPkg.length > 0)
                if (isBarrel) {
                    rootSet.delete(r)
                    for (const x of childrenInPkg) rootSet.add(x)
                    changed = true
                }
            }
        }
        const finalRoots = [...rootSet]

        // Reach per symbol, confined to the retained subtree (so we never charge react et al.).
        const reachedBy = new Map<string, number>()
        const perRoot = new Map<string, Set<string>>()
        for (const r of finalRoots) {
            const reached = walk([r], { within: retained })
            perRoot.set(r, reached)
            for (const id of reached) reachedBy.set(id, (reachedBy.get(id) ?? 0) + 1)
        }

        let retainedBytes = 0
        let sharedBytes = 0
        let unattributedBytes = 0
        for (const id of retained) {
            const bytes = mods.get(id)!.bytes
            retainedBytes += bytes
            const c = reachedBy.get(id) ?? 0
            if (c === 0) unattributedBytes += bytes
            else if (c >= 2) sharedBytes += bytes
        }

        const symbols: SymbolWeight[] = finalRoots
            .map((r) => {
                const reached = perRoot.get(r)!
                let exclusiveBytes = 0
                let reachBytes = 0
                let exclusiveMinBytes = 0
                let reachMinBytes = 0
                for (const id of reached) {
                    const rec = mods.get(id)!
                    reachBytes += rec.bytes
                    reachMinBytes += rec.minBytes
                    if ((reachedBy.get(id) ?? 0) === 1) {
                        exclusiveBytes += rec.bytes
                        exclusiveMinBytes += rec.minBytes
                    }
                }
                return {
                    exclusiveBytes,
                    exclusiveMinBytes,
                    label: symbolLabel(mods.get(r)!.rel ?? r),
                    moduleCount: reached.size,
                    reachBytes,
                    reachMinBytes,
                }
            })
            .sort((a, b) => b.reachBytes - a.reachBytes)

        findings.push({
            blob: null,
            moduleCount: own.length,
            originalBytes: pkgOriginal.get(pkg) ?? ownBytes,
            ownBytes,
            ownMinifiedBytes: pkgMinified.get(pkg) ?? ownBytes,
            pkg,
            retainedBytes,
            sharedBytes,
            soleModule: null,
            sourceSymbols: sourceImports.get(pkg)?.symbols ?? [],
            symbols,
            unattributedBytes,
            utilization: retainedBytes > 0 ? (retainedBytes - unattributedBytes) / retainedBytes : null,
        })
    }

    return {
        findings,
        graphOk,
        minifiedTotalBytes: minifiedTotal,
        minifyRatio,
        renderedTotalBytes: renderedTotal,
    }
}

// ── Reporter ──────────────────────────────────────────────────────────────────

const DEFAULT_SOURCE_DIRS = ['src', 'configs', 'generated']

function report({ findings, graphOk, minifyRatio, renderedTotalBytes, minifiedTotalBytes }: Analysis): void {
    if (findings.length === 0) return

    console.warn(`\n${SEP}`)
    console.warn(
        `${Cc(B('◈ tree-shaking audit'))}  ${D(`per-symbol retained weight · packages ≥ ${PKG_THRESHOLD_BYTES / KB} KB`)}`,
    )
    console.warn(SEP)
    console.warn(
        `  ${B(`Total JS: ${kb(minifiedTotalBytes)} minified`)} ${D(`(matches build report, pre-gzip) · ${kb(renderedTotalBytes)} rendered pre-minify (×${minifyRatio.toFixed(2)})`)}`,
    )
    console.warn(
        D(
            `  First size = rendered (pre-minify) bytes · ≈ size = shipped (minified) estimate scaled by each chunk's own ratio.`,
        ),
    )
    if (!graphOk) {
        console.warn(`  ${Y('⚠ import graph unavailable (getModuleInfo gave no edges) — showing landed totals only')}`)
    }

    for (const f of findings) {
        const depBytes = f.retainedBytes - f.ownBytes
        const depNote = depBytes > KB ? D(`  (+${kb(depBytes)} private deps → ${kb(f.retainedBytes)} retained)`) : ''
        const imp = f.sourceSymbols.length
        const intro = imp > 0 ? `your ${Y(String(imp))} import(s)` : 'landed'
        console.warn(
            `\n  ${Cc('◈')} ${Bl(f.pkg)} ${D('—')} ${intro} · ${Y(kb(f.ownBytes))} ${D(`≈ ${kb(f.ownMinifiedBytes)} shipped`)} ${D(`(${f.moduleCount} modules)`)}${depNote}`,
        )

        if (f.sourceSymbols.length > 0) {
            const shown = f.sourceSymbols.slice(0, MAX_SYMBOLS).join(', ')
            const more = f.sourceSymbols.length > MAX_SYMBOLS ? ` +${f.sourceSymbols.length - MAX_SYMBOLS} more` : ''
            console.warn(`    ${D('Imported:')} ${Bl('{' + shown + more + '}')}`)
        }

        // Utilization flag: < 75% of what you bundle from this lib is attributable to
        // your imports → you pay for bytes you don't use.
        if (f.utilization !== null && f.utilization < UTILIZATION_FLAG) {
            const pct = (f.utilization * 100).toFixed(0)
            const waste = f.retainedBytes - Math.round(f.retainedBytes * f.utilization)
            console.warn(`    ${Y('⚠')} ${Y(`you use ~${pct}% of what you bundle — ~${kb(waste)} is dead weight.`)}`)
        }
        // Tree-shake yield: how much rolldown already removed from the landed modules.
        if (f.originalBytes > f.ownBytes + KB) {
            const shaken = f.originalBytes - f.ownBytes
            console.warn(
                `    ${D(`Tree-shaking already removed ${kb(shaken)} of ${kb(f.originalBytes)} original (kept ${((f.ownBytes / f.originalBytes) * 100).toFixed(0)}%).`)}`,
            )
        }

        // Waste signal: several NAMED symbols imported but far more modules landed → barrel
        // not shaken. Only NAMED symbols count — default/namespace imports of a monolithic
        // lib (axios, tracker-assist) genuinely need everything and must not false-positive.
        const named = f.sourceSymbols.filter((s) => s !== '*' && s !== 'default').length
        if (named >= 2 && f.moduleCount >= 10 && f.moduleCount > named * 4) {
            console.warn(
                `    ${Y('⚠')} ${Y(`${named} symbol(s) imported but ${f.moduleCount} modules landed — low tree-shake yield (full-barrel import somewhere?).`)}`,
            )
        }

        // Single-blob package: statement-level per-symbol costs when we could parse it.
        if (f.soleModule) {
            console.warn(
                `    ${Bl('↳')} ${Bl(`${kb(f.soleModule.bytes)} in 1 module (${f.soleModule.used} export${f.soleModule.used === 1 ? '' : 's'}) — tree-shaking cannot split it.`)}`,
            )
            console.warn(`       ${D(f.soleModule.rel)}`)
            if (f.blob) {
                console.warn(
                    `    ${D(`Per-symbol (statement-level inside the blob · shared internals counted once):`)}`,
                )
                for (const s of f.blob.symbols.slice(0, MAX_SYMBOLS)) {
                    const own = `${Y(kb(s.exclusiveBytes))} ${D(`≈ ${kb(s.exclusiveMinBytes)}`)}`.padEnd(40)
                    console.warn(
                        `      ${D('·')} ${own} ${Bl(s.name.padEnd(28))} ${D(`pulls ${kb(s.reachBytes)} ≈ ${kb(s.reachMinBytes)}`)}`,
                    )
                }
                if (f.blob.symbols.length > MAX_SYMBOLS) {
                    console.warn(`      ${D(`· ... and ${f.blob.symbols.length - MAX_SYMBOLS} more symbol(s)`)}`)
                }
                const se =
                    f.blob.sideEffectBytes > KB ? ` ${D(`(incl. ${kb(f.blob.sideEffectBytes)} side-effects)`)}` : ''
                console.warn(
                    `    ${Bl('↳')} ${G(`${kb(f.blob.neededBytes)} needed ≈ ${kb(f.blob.neededMinBytes)} shipped`)}${se} ${D('of')} ${B(`${kb(f.blob.totalBytes)} ≈ ${kb(f.blob.totalMinBytes)}`)} ${D(`bundled (${f.blob.exportCount} exports total)`)}`,
                )
            }
            console.warn(`       ${D('Dynamic import() if not needed at boot, or deep-import a lighter entry.')}`)
            continue
        }

        // Per-symbol table.
        if (f.symbols.length > 0) {
            console.warn(`    ${D('Per-symbol (own = frees only this · pulls = incl. shared, both within retained):')}`)
        }
        for (const s of f.symbols.slice(0, MAX_SYMBOLS)) {
            const own = `${Y(kb(s.exclusiveBytes))} ${D(`≈ ${kb(s.exclusiveMinBytes)}`)}`.padEnd(40)
            const pulls = D(`pulls ${kb(s.reachBytes)} ≈ ${kb(s.reachMinBytes)}`)
            const mc = D(`${s.moduleCount} mod`)
            console.warn(`      ${D('·')} ${own} ${Bl(s.label.padEnd(30))} ${pulls}  ${mc}`)
        }
        if (f.symbols.length > MAX_SYMBOLS) {
            console.warn(`      ${D(`· ... and ${f.symbols.length - MAX_SYMBOLS} more symbol(s)`)}`)
        }

        // Reconciliation: Σ exclusive + shared (+ boot) = retained.
        const exclusiveSum = f.symbols.reduce((s, x) => s + x.exclusiveBytes, 0)
        const bootNote = f.unattributedBytes > KB ? ` ${D('+')} ${D(kb(f.unattributedBytes) + ' boot')}` : ''
        console.warn(
            `    ${Bl('↳')} ${G(kb(exclusiveSum) + ' exclusive')} ${D('+')} ${Y(kb(f.sharedBytes) + ' shared')}${bootNote} ${D('=')} ${B(kb(f.retainedBytes))} ${D('retained')}`,
        )
        if (f.sharedBytes / Math.max(f.retainedBytes, 1) > 0.35) {
            console.warn(
                `       ${D('High shared fraction — symbols overlap heavily; dropping one frees only its "own", not its "pulls".')}`,
            )
        }
    }

    console.info('')
}

// ── Debug: inspect the raw rolldown data shape (TSA_DEBUG=1) ───────────────────

function debugDump(chunks: ChunkLike[], getModuleInfo: GetModuleInfo): void {
    let renderedTotal = 0
    const minifiedTotal = chunks.reduce((s, c) => s + (c.code?.length ?? 0), 0)
    const occ = new Map<string, number>()
    const len = new Map<string, number>()
    let modEntries = 0

    for (const c of chunks) {
        for (const [id, m] of Object.entries(c.modules ?? {})) {
            modEntries++
            const bytes = m?.renderedLength ?? 0
            renderedTotal += bytes
            occ.set(id, (occ.get(id) ?? 0) + 1)
            if (!len.has(id)) len.set(id, bytes)
        }
    }

    console.warn('\n===== TSA_DEBUG =====')
    console.warn(`chunks=${chunks.length} uniqueModules=${occ.size} moduleEntries=${modEntries}`)
    console.warn(
        `minified(code)=${(minifiedTotal / KB).toFixed(1)}KB rendered=${(renderedTotal / KB).toFixed(1)}KB ratio=${(minifiedTotal / renderedTotal).toFixed(3)}`,
    )
    const hist = new Map<number, number>()
    for (const n of occ.values()) hist.set(n, (hist.get(n) ?? 0) + 1)
    console.warn(
        'occ histogram:',
        [...hist.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([k, v]) => `${k}×:${v}`)
            .join('  '),
    )
    const firstId = [...occ.keys()][0]
    if (firstId) {
        const info = getModuleInfo(firstId)
        console.warn('getModuleInfo keys:', info ? Object.keys(info).join(',') : 'null')
    }
    console.warn('===== /TSA_DEBUG =====\n')
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export function treeShakeAuditPlugin(options?: TreeShakeAuditOptions): Plugin {
    const sourceDirs = options?.sourceDirs ?? DEFAULT_SOURCE_DIRS
    let resolvedRoot = ''
    let sourceImports = new Map<string, PkgImport>()

    return {
        apply: 'build',

        buildStart() {
            if (resolvedRoot) sourceImports = scanSourceImports(resolvedRoot, sourceDirs)
        },

        configResolved(config: ResolvedConfig) {
            resolvedRoot = config.root
        },
        enforce: 'post',

        generateBundle(_options, bundle) {
            const chunks = Object.values(bundle).filter(
                (c): c is Extract<(typeof bundle)[string], { type: 'chunk' }> => c.type === 'chunk',
            )
            const getInfo = (id: string) => this.getModuleInfo(id) as ReturnType<GetModuleInfo>
            if (process.env['TSA_DEBUG']) {
                debugDump(chunks, getInfo)
                return
            }
            const analysis = analyze(chunks, getInfo, sourceImports)
            report(analysis)
            // Machine-readable snapshot for scripts/analyze-bundle-usage.ts (same numbers,
            // no re-derivation from chunk filenames).
            const meta: BundleMeta = { ...analysis, generatedAt: new Date().toISOString() }
            this.emitFile({
                fileName: '.bundle-meta.json',
                source: JSON.stringify(meta, null, 2),
                type: 'asset',
            })
        },
        name: 'asma-tree-shake-audit',
    }
}
