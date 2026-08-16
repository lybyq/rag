import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

/**
 * ESLint 同时负责语法质量和架构边界的第一道门禁。
 * 更完整的跨目录依赖检查由 dependency-cruiser 执行，两者互相补充。
 *
 * @requirement BASE-005
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'openapi/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.ts', '**/*.vue'],
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['apps/**/*', 'libs/**/*'],
      'boundaries/elements': [
        { type: 'app', pattern: 'apps/*/src/**/*', capture: ['app'] },
        { type: 'contracts', pattern: 'libs/contracts/src/**/*' },
        { type: 'domain', pattern: 'libs/domain/src/**/*' },
        { type: 'application', pattern: 'libs/application/src/**/*' },
        {
          type: 'adapter',
          pattern: [
            'libs/persistence-*/src/**/*',
            'libs/model-gateway/src/**/*',
            'libs/auth/src/**/*',
          ],
        },
        { type: 'library', pattern: 'libs/*/src/**/*' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          policies: [
            {
              from: { element: { type: 'contracts' } },
              disallow: {
                to: {
                  element: {
                    types: { anyOf: ['app', 'domain', 'application', 'adapter', 'library'] },
                  },
                },
              },
            },
            {
              from: { element: { type: 'domain' } },
              disallow: {
                to: {
                  element: { types: { anyOf: ['app', 'application', 'adapter', 'library'] } },
                },
              },
            },
            {
              from: { element: { type: 'application' } },
              disallow: { to: { element: { types: { anyOf: ['app', 'adapter'] } } } },
            },
            {
              from: { element: { types: { anyOf: ['adapter', 'library'] } } },
              disallow: { to: { element: { type: 'app' } } },
            },
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/web-console/**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      'vue/block-order': ['error', { order: ['script', 'template', 'style'] }],
      'vue/component-name-in-template-casing': ['error', 'PascalCase'],
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-closing-bracket-newline': 'off',
    },
  },
  {
    files: ['**/*.cjs', '**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
