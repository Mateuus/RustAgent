// ============================================================
//  settings.ts  -  a configuração do site que o PAINEL edita.
//
//  ####  POR QUE ELA NÃO MORA NO .env  ####
//
//  O `.env` continua sendo o padrão da instalação, e o valor daqui o
//  sobrescreve. O que a tela NÃO faz é reescrever o `.env`: é lá que
//  moram os segredos que trancam o operador do lado de fora — o
//  `AGENT_API_TOKEN` e a senha do painel —, e um writer com defeito
//  ali custa o acesso à própria tela que consertaria o problema.
//
//  Errar a URL do site é barato em comparação: a loja fica
//  indisponível, o painel continua de pé, e dá para consertar por
//  onde se errou.
//
//  ####  O PAREAMENTO NÃO ESTÁ AQUI  ####
//
//  `SITE_SERVER_ID` e `SITE_TOKEN` são de CADA servidor, e moram em
//  `Configs\<id>.ini`, junto da senha de RCON. Aqui fica só o que
//  vale para o agente inteiro — a URL é a mesma para todos, porque o
//  site é um só.
// ============================================================

/** A chave na tabela `meta`. Prefixo por assunto, como as outras. */
export const SITE_BASE_URL_KEY = 'site.base_url';

/**
 * Recusa uma URL que não serve, com a frase que ensina.
 *
 * `null` = está boa. Vazia também está: é o jeito de DESLIGAR a
 * integração pela tela, e o agente volta para a carteira local.
 */
export function rejectSiteBaseUrl(raw: string): string | null {
  const value = raw.trim();

  if (value === '') {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return 'A URL do site precisa ser completa, com https:// na frente. Ex.: https://origemznetwork.com';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'A URL do site precisa começar com https:// (ou http://, só em desenvolvimento).';
  }

  // ####  O /api NO FIM É O ERRO QUE CUSTA UMA TARDE  ####
  //
  // O agente acrescenta `/api/agent/...` sozinho. Uma URL que já
  // termine em `/api` monta `.../api/api/agent/...`, e o sintoma é
  // 404 em tudo — quer dizer, "a loja parou". Ninguém procura uma
  // barra a mais quando a loja para.
  if (/\/api\/?$/i.test(parsed.pathname)) {
    return (
      'Tire o /api do fim: esta é a ORIGEM do site (https://exemplo.com), e o agente ' +
      'acrescenta /api/agent/... sozinho.'
    );
  }

  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return `Tire o caminho "${parsed.pathname}" do fim: aqui vai só o endereço do site, sem página.`;
  }

  return null;
}

/** A forma canônica: origem, sem barra no fim. */
export function normalizeSiteBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}
