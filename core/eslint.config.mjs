// ============================================================
//  Flat config do ESLint 9.
//
//  Fica dentro de core/ (e não na raiz do workspace) porque as
//  dependências do lint estão declaradas no package.json de
//  core/. Assim "pnpm -r lint" na raiz funciona sem duplicar
//  eslint em dois pacotes.
// ============================================================
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Parâmetro/variável começando com "_" é intencionalmente
      // não usado (handler do Fastify que só olha o reply, por
      // exemplo).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
