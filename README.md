# asma-core-toolchain

Shared toolchain for `asma-app-*` micro-frontends. One versioned npm package instead of
per-app copies of the same vite/tsconfig/eslint/lefthook/cspell files (the old
`template-vitemf-react` copy-and-drift flow).

Lives as its own repo, checked out as a submodule of the `asma-modules` superproject, and is
delivered like every other shared lib: published to npm, consumed as a semver devDependency —
`pnpm install` is the whole delivery mechanism.

## Documentation

Canonical docs live in the superproject at `asma-modules/_docs/asma-core-toolchain/`
([index](_docs/index.md)) — the local `_docs` symlink points there, so it resolves only inside a
superproject checkout (standalone clones see a dangling link; that's the repo-wide convention).
Start with the [kernel audit runbook](_docs/operations/2026-07-04-13-55-runbook-kernel-audit.md).

## What's inside

| Export | Consumed by | Contents |
| --- | --- | --- |
| `asma-core-toolchain/vite` | `vite.config.ts` | `defineAsmaAppConfig` factory (base/port/proxy/server + qiankun/react/svgr trio), `getBasePathAndPort`, `createAsmaBuildOptions` / `createManualChunks` |
| `asma-core-toolchain/eslint` | `eslint.config.js` | `asmaAppEslintConfig()` flat-config base (js/ts-typechecked/react/hooks/regexp/de-morgan/tanstack-query + shared ignores). All plugins are dependencies of this package — apps don't declare them |
| `asma-core-toolchain/tsconfig/app.json` | `tsconfig.json` `extends` | shared `compilerOptions` baseline (Bundler resolution, strict, ESNext) |
| `node_modules/asma-core-toolchain/src/lefthook/base.yml` | `lefthook.yml` `extends` | knip / ts:check / lint pre-push, eslint-fix + format pre-commit, commitlint commit-msg |
| `asma-core-toolchain/cspell/base.json` | `cspell.json` `import` | the shared word list |

## Consuming (per app)

```jsonc
// package.json
"devDependencies": { "asma-core-toolchain": "^0.1.0" }
```

```ts
// vite.config.ts
import { defineAsmaAppConfig } from 'asma-core-toolchain/vite'
import { name } from './package.json'
export default defineAsmaAppConfig({
    name,
    port: 3003,
    plugins: [/* app-specific: tailwindcss(), nodePolyfills(), widgetDev(), … */],
})
```

```jsonc
// tsconfig.json — plugins/include/paths stay app-side
{
    "extends": ["asma-core-toolchain/tsconfig/app.json", "./tsconfig.paths.json"],
    "compilerOptions": { "plugins": [/* gql.tada schemas, css-modules */] },
    "include": ["src", "generated", "./*.ts"]
}
```

```js
// eslint.config.js — append app-specific blocks (tailwind flavor, extra rules)
import { defineConfig } from 'eslint/config'
import { asmaAppEslintConfig } from 'asma-core-toolchain/eslint'
export default defineConfig(asmaAppEslintConfig(), /* app blocks */)
```

```yaml
# lefthook.yml
extends:
  - node_modules/asma-core-toolchain/src/lefthook/base.yml
```

```jsonc
// cspell.json
{ "import": ["asma-core-toolchain/cspell/base.json"], "words": [] }
```

Shell (`asma-app-shell`) consumes the same factory and passes its shell-only plugins/options —
shell-specific files stay in the shell repo.

## Kernel spec (single source of truth)

The kernel-externalization contract — which shared libs `asma-app-*` builds externalize — is
declared ONCE, as data, in [`src/kernel/spec.mjs`](src/kernel/spec.mjs) (`KERNEL_SPEC`), exported as
`asma-core-toolchain/kernel/spec`. Everything else is **computed** from it:

- `KERNEL_EXTERNAL_SPECIFIERS` / `KERNEL_PINNED_ROOT_SPECIFIERS` in
  [`src/vite/kernelExternal.ts`](src/vite/kernelExternal.ts) derive from the spec.
- `asma-infrastructure/asma-mfw-kernel` **generates** its `package.json` dependency names from the
  spec (`sync-deps.mjs`) and derives `gather.mjs`'s react-adjacent / react-free sets from it —
  consumed via the published `asma-core-toolchain` devDependency. Its CI `sync-deps.mjs --check` is
  the one hard cross-repo guard, so spec↔publisher drift is impossible by construction (no more
  `mirror` audit).

`asma-kernel-audit candidates` (bin) is now purely advisory: it scans the fleet for libs that have
crossed the promotion bar but aren't in the kernel yet, annotating deliberate exclusions from
`KERNEL_SPEC.excluded`. Promotion stays a deliberate PR to the spec. See the
[kernel audit runbook](_docs/operations/2026-07-04-13-55-runbook-kernel-audit.md).

## Versioning & release

Manual, because changes are rare: bump `version` in `package.json` (SemVer) in the same
asma-modules PR as the change, then from this directory:

```sh
pnpm install && pnpm build && npm publish --access public
```

Apps pick up changes by bumping the devDependency — normal dependency review, no surprise
config changes on unrelated CI runs. (This package is now its own repo/submodule, so its
`.github/workflows/` do run — `publish.yml` publishes on push to `master`.)

## Local development

No pnpm workspace exists across repos, so to test unpublished changes against an app:

```sh
cd shared/asma-core-toolchain && pnpm i && pnpm build && pnpm pack
cd ../../directory/asma-app-directory
pnpm add -D ../../shared/asma-core-toolchain/asma-core-toolchain-<version>.tgz   # temporary — revert to semver before PR
```

## Migration checklist (per app)

1. `pnpm add -D asma-core-toolchain`
2. Replace `vite.config.ts` body with `defineAsmaAppConfig({...})`; delete `vite.config.helpers.ts`; reduce `vite.config.build.ts` to chunk-group maps + `createAsmaBuildOptions`
3. `tsconfig.json` → `extends` array; keep `plugins`/`include`/paths local
4. `eslint.config.js` → `asmaAppEslintConfig()` + app blocks; drop the shared eslint plugins from devDependencies
5. `lefthook.yml` → `extends` base; `skip: true` per hook that doesn't pass yet
6. `cspell.json` → `import` base; keep only app-specific `words`
7. Verify: `pnpm build`, `pnpm exec eslint --print-config src/App.tsx`, `pnpm exec lefthook dump`
