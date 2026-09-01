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
  // ####  NÃO REMOVA SEM LER  ####
  //
  // O tsconfig.json manda `jsx: "preserve"` porque quem compila
  // JSX aqui é o Next. A partir do Vite 7 (vitest 4) o transform
  // OBEDECE esse campo: ao importar um .tsx ele deixa o JSX
  // intacto, e o Vite tropeça em "invalid JS syntax".
  //
  // Os testes importam funções puras que moram em arquivos .tsx
  // — buildMonthGrid, projectNow — e o arquivo inteiro precisa
  // ser transformado para chegar até elas. Este `jsx` vale só
  // para o vitest e não muda nada do build do Next.
  //
  // É `oxc` e não `esbuild`: o Vite 7 trocou o transformador, e
  // com os dois presentes ele ignora o bloco `esbuild` em
  // silêncio.
  oxc: {
    jsx: { runtime: 'automatic' },
  },

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
