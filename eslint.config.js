// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript strict + type-checked rules
  ...tseslint.configs.recommendedTypeChecked,

  // Prettier disables formatting rules that conflict with prettier
  prettier,

  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Types
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],

      // Promise safety
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Import discipline
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],

      // Non-null assertions are a code smell — warn instead of error so we see them
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Use the logging patterns (writeUnifiedMemory, console.error) — not console.log
      'no-console': ['error', { allow: ['error', 'warn'] }],

      // Style
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': ['error', 'always'],
    },
  },

  // Ignore built artifacts, vendored code, and the dashboard (managed separately)
  {
    ignores: ['dist/**', 'node_modules/**', 'vendor/**', 'apps/**', 'scripts/**'],
  }
);
