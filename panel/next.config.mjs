// ============================================================
//  next.config.mjs
//
//  O painel é um EXPORT ESTÁTICO: `next build` cospe HTML/CSS/JS
//  em out/, e nada roda em servidor. Isso é o que permite servir
//  o painel pelo próprio core (ou por qualquer servidor de
//  arquivos) sem subir um segundo processo Node.
//
//  O preço é que estes recursos do Next NÃO existem aqui, e o
//  build falha se alguém usar: API Routes, Server Actions, ISR,
//  middleware, cookies()/headers(), rewrites e redirects.
//  TODA chamada à API do agente sai do NAVEGADOR — ver
//  src/lib/api/client.ts.
// ============================================================

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  reactStrictMode: true,

  // ####  NÃO REMOVA SEM LER  ####
  //
  // Com `trailingSlash: false` (o padrão), o export gera
  // `out/jogadores.html`. O core serve o `out/` com
  // @fastify/static, que NÃO tenta acrescentar ".html" ao
  // caminho: um GET em /jogadores cairia no notFoundHandler e
  // receberia o index.html — ou seja, o dashboard desenhado numa
  // URL de outra página, com o roteador do Next tentando casar
  // uma rota que o HTML não contém.
  //
  // Com `true` o export gera `out/jogadores/index.html`, e o
  // @fastify/static já está configurado com `index:
  // ['index.html']` — o diretório resolve sozinho. O <Link> do
  // Next passa a emitir "/jogadores/" também, então a navegação e
  // o F5 batem no mesmo caminho.
  //
  // Sobra uma aresta: /jogadores SEM a barra final continua caindo
  // no fallback (o @fastify/static está com `redirect: false`, o
  // padrão). Só acontece com URL digitada à mão; resolver de vez
  // pede `redirect: true` no core, que está fora do escopo deste
  // pacote.
  trailingSlash: true,

  // Sem servidor não existe o otimizador de imagens do Next.
  // Com `unoptimized` o <Image> vira um <img> comum; sem isso o
  // build quebra ao encontrar o primeiro <Image>.
  images: { unoptimized: true },

  // O lint roda por "pnpm lint" (eslint flat config, igual ao
  // core). Deixar o `next build` disparar a versão dele do
  // ESLint só duplicaria a checagem — e com uma configuração
  // diferente da que o resto do monorepo usa.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
