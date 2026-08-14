import { defineConfig } from 'vitest/config';

// ============================================================
//  Testes do painel.
//
//  Node puro, sem jsdom: o que tem teste aqui é a LÓGICA de
//  ui-doc (geometria, cor, conversão para CUI, validação), e
//  nada disso toca no DOM. Componente React é verificado pelo
//  typecheck e olhando a tela — montar um DOM falso para testar
//  arrasto de mouse custaria mais do que descobre.
//
//  A mesma ferramenta do core, de propósito: um `pnpm test` que
//  se comporta igual nos dois pacotes.
// ============================================================
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    // O mesmo alias do tsconfig.json. Sem ele, um import '@/lib/...'
    // dentro do código sob teste não resolveria.
    alias: {
      '@': new URL('./src/', import.meta.url).pathname,
    },
  },
});
