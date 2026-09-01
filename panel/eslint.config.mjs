// ============================================================
//  Flat config do ESLint 10 — mesma base do core/, com o que o
//  React exige por cima.
//
//  Não usamos `eslint-config-next`: o Next 16 nem tem mais o
//  `next lint`, e o monorepo lint a partir da raiz com "npm run
//  lint --workspaces". Duas configurações de ESLint no mesmo
//  repositório dariam resultados diferentes para o mesmo
//  arquivo.
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
      // As duas regras ficam declaradas na mão, e não pela config
      // pronta do plugin.
      //
      // Deixou de ser por falta de opção: até a v6 o plugin só
      // expunha config no formato eslintrc, que não carrega aqui.
      // A v7 tem `reactHooks.configs.flat['recommended-latest']`,
      // mas ela traz junto as regras do React Compiler — 53 erros
      // neste código, quase todos `set-state-in-effect`. Adotar é
      // decisão de refatorar, não de atualizar pacote.
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
