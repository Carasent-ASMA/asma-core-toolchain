import eslint from '@eslint/js'
import pluginQuery from '@tanstack/eslint-plugin-query'
import { defineConfig, globalIgnores } from 'eslint/config'
import betterTailwind from 'eslint-plugin-better-tailwindcss'
import deMorgan from 'eslint-plugin-de-morgan'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import reactYouMightNotNeedAnEffect from 'eslint-plugin-react-you-might-not-need-an-effect'
import * as regexpPlugin from 'eslint-plugin-regexp'
import tseslint from 'typescript-eslint'

/**
 * Shared eslint flat-config base for asma-app-* micro-frontends.
 * App-specific blocks (extra rules) are appended in the app's eslint.config.js:
 *
 *   export default defineConfig(asmaAppEslintConfig({ tailwind: true }), ...appSpecificBlocks)
 *
 * @param {{ ignores?: string[]; tailwind?: boolean }} [options]
 *   - ignores: extra globalIgnores patterns on top of the shared list
 *   - tailwind: include the fleet-standard `eslint-plugin-better-tailwindcss` layer
 *     (Tailwind v4-compatible; the convergence target for all apps). Off by default so
 *     apps still on the legacy `eslint-plugin-tailwindcss` are unaffected until they migrate.
 */
export function asmaAppEslintConfig({ ignores = [], tailwind = false } = {}) {
    return defineConfig(
        eslint.configs.recommended,
        tseslint.configs.recommendedTypeChecked,
        tseslint.configs.stylistic,
        globalIgnores([
            'node_modules/**',
            'dist/**',
            'build/**',
            'packages/**',
            '**/packages/**',
            'generated/**',
            '**/generated/**',
            '.vscode/**',
            '/src/*.spec.js',
            '/src/**/*.spec.js',
            '/src/*.test.js',
            '/src/**/*.test.js',
            'deployment',
            'tailwind.config.js',
            'src/index.html',
            'index.html',
            ...ignores,
        ]),

        // mobx-state-tree models legitimately use interfaces
        {
            files: ['src/mst/**/*.{ts,tsx}', 'src/**/mst/**/*.{ts,tsx}'],
            rules: {
                '@typescript-eslint/consistent-type-definitions': 'off',
            },
        },
        {
            extends: [tseslint.configs.disableTypeChecked],
            files: ['**/*.cjs'],
            languageOptions: {
                sourceType: 'commonjs',
            },
        },
        {
            extends: [tseslint.configs.disableTypeChecked],
            files: [
                'eslint.config.js',
                'postcss.config.js',
                'tailwind.config.eslint.js',
                'configs/env.local.example.ts',
                'configs/env.local.ts',
            ],
            languageOptions: {
                sourceType: 'module',
            },
        },
        {
            files: ['**/*.{js,jsx,ts,tsx}'],
            ignores: [
                'eslint.config.js',
                'postcss.config.js',
                'tailwind.config.eslint.js',
                'configs/env.local.example.ts',
                'configs/env.local.ts',
            ],

            languageOptions: {
                ecmaVersion: 'latest',
                parserOptions: {
                    projectService: {
                        defaultProject: 'tsconfig.json',
                    },
                },
                sourceType: 'module',
            },
            rules: {
                '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
                '@typescript-eslint/consistent-type-imports': 'error',
                '@typescript-eslint/no-empty-object-type': [
                    'error',
                    {
                        allowInterfaces: 'with-single-extends',
                    },
                ],
                '@typescript-eslint/no-unused-vars': [
                    'error',
                    {
                        args: 'after-used',
                        argsIgnorePattern: '^_',
                        vars: 'all',
                        varsIgnorePattern: '^_',
                    },
                ],
                '@typescript-eslint/switch-exhaustiveness-check': 'error',
                '@typescript-eslint/unbound-method': 'off',
            },
        },
        {
            ...reactPlugin.configs.flat.recommended,
            rules: {
                'react/react-in-jsx-scope': 'off',
            },
        },
        reactHooksPlugin.configs.flat.recommended,
        reactYouMightNotNeedAnEffect.configs['recommended'],
        regexpPlugin.configs['flat/recommended'],
        ...pluginQuery.configs['flat/recommended'],
        deMorgan.configs.recommended,
        ...(tailwind
            ? [
                  {
                      files: ['**/*.{js,jsx,ts,tsx}'],
                      plugins: { 'better-tailwindcss': betterTailwind },
                      rules: {
                          ...betterTailwind.configs['recommended-warn'].rules,
                          ...betterTailwind.configs['recommended-error'].rules,
                          // line-wrapping is noisy; enable per-app later
                          'better-tailwindcss/enforce-consistent-line-wrapping': ['off', { printWidth: 120 }],
                      },
                  },
              ]
            : []),
    )
}
