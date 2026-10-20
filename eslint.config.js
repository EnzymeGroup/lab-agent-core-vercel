import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// A small set of rules that catch real bugs; formatting is left alone. `npm run lint`.
// Type-aware rules need core's built types (dist/index.d.ts); `npm run typecheck` builds them first.
export default [
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', '**/.next/**', '**/out/**',
      'packages/core/workbench/**', 'packages/core/docs/**', 'packages/core/examples/**',
      '.artifacts/**', '.test-artifacts/**', 'test-results/**', 'playwright-report/**',
      'apps/workbench/next-env.d.ts',
    ],
  },
  // Every JavaScript and TypeScript file: unused code and unused imports.
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true,
      }],
    },
  },
  // Source covered by a tsconfig: promises that are neither awaited nor handled.
  {
    files: ['packages/core/src/**/*.ts', 'packages/extras/src/**/*.ts', 'apps/workbench/{app,components,lib}/**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  // Workbench React code: hooks are called unconditionally and in the same order.
  {
    files: ['apps/workbench/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
];
