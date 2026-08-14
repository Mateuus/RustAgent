// ============================================================
//  Flat config do ESLint 9 — mesma base do core/, com o que o
//  React exige por cima.
//
//  Não usamos `eslint-config-next`: o `next build` está com o
//  lint desligado (ver next.config.mjs) e o monorepo lint a
//  partir da raiz com "pnpm -r lint". Duas configurações de
//  ESLint no mesmo repositório dariam resultados diferentes para
//  o mesmo arquivo.
// ============================================================
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // O plugin do React expõe as configs no formato antigo
      // (eslintrc), que não carrega em flat config — as duas
      // regras são declaradas na mão de propósito.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Requisito do painel: nada de `any`. Já vem de
      // tseslint.configs.recommended; fica explícito para não
      // sumir numa troca de preset.
      '@typescript-eslint/no-explicit-any': 'error',

      // Igual ao core: "_" na frente marca não-uso intencional.
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
