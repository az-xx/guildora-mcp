import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // discord.js takes ~0.8s to import; only client.ts loads it (lazily). Elsewhere use
      // `import type` and runtime values from src/discord/api.ts.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'discord.js',
              message: 'Use `import type` from discord.js and values from src/discord/api.ts.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-restricted-imports': 'off',
      'no-console': 'off',
    },
  },
);
