# asma-core-toolchain

Shared toolchain for `asma-app-*` micro-frontends. One versioned npm package instead of
per-app copies of the same vite/tsconfig/eslint/lefthook/cspell files (the old
`template-vitemf-react` copy-and-drift flow).

Lives as a plain directory in the `asma-modules` superproject (no own repo/submodule — it
rarely changes), but is delivered like every other shared lib: published to npm, consumed as
a semver devDependency. No symlinks, no superproject checkout in CI — `pnpm install` is the
whole delivery mechanism.

## What's inside

| Export | Consumed by | Contents |
|---|---|---|
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

## Versioning & release

Manual, because changes are rare: bump `version` in `package.json` (SemVer) in the same
asma-modules PR as the change, then from this directory:

```sh
pnpm install && pnpm build && npm publish --access public
```

Apps pick up changes by bumping the devDependency — normal dependency review, no surprise
config changes on unrelated CI runs. If churn ever grows, add a path-filtered publish
workflow to `asma-modules/.github/workflows` (GitHub doesn't run workflows from
subdirectories, so the one that used to live here was dead config and was removed).

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
