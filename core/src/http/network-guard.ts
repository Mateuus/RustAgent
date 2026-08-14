// ============================================================
//  ####  QUEM CHEGA NA PORTA, ANTES DE QUALQUER TOKEN  ####
//
//  A autenticacao responde "esta chamada tem credencial?". Estes
//  dois hooks respondem uma pergunta anterior: "esta chamada
//  deveria ter chegado ate aqui?".
//
//  Eles rodam na instancia RAIZ, e nao no escopo /api — porque o
//  que precisa de protecao nao e so a API.
//
//  ------------------------------------------------------------
//  ####  O PAINEL CARREGA O TOKEN DENTRO DELE  ####
//
//  O painel e um export estatico servido por este mesmo processo,
//  e o `NEXT_PUBLIC_AGENT_TOKEN` fica EMBUTIDO no bundle em tempo
//  de build. Isso e inerente ao export estatico e esta no README
//  do painel — mas tem uma consequencia que a lista de IPs
//  precisava cobrir e nao cobria:
//
//      GET /_next/static/chunks/<qualquer>.js
//
//  nao passava por autenticacao nenhuma (nem devia: e um arquivo
//  estatico) e TAMBEM nao passava pela lista de IPs, que valia so
//  para /api. Ou seja: quem alcancasse a porta baixava o bundle,
//  lia o token com escopo total e voltava autenticado.
//
//  A lista de IPs agora vale para a PORTA inteira. Quem nao esta
//  nela nao baixa o painel, nao le /health e nao chega na API.
//
//  ------------------------------------------------------------
//  ####  DNS REBINDING: O ATAQUE QUE NAO PRECISA DA PORTA  ####
//
//  "A porta e so local, ninguem de fora alcanca" e verdade sobre
//  o SOCKET e falsa sobre o NAVEGADOR de quem administra.
//
//  O ataque: a vitima abre um site qualquer. O dominio dele
//  responde, com TTL zero, o IP do proprio atacante; segundos
//  depois, o MESMO dominio passa a responder 127.0.0.1. O
//  JavaScript da pagina entao faz `fetch('http://evil.com:8787/')`
//  — para o navegador continua sendo a mesma origem, e a conexao
//  sai da propria maquina da vitima.
//
//  A partir dai o script do atacante le o painel (com o token
//  dentro) e chama a API a vontade. Firewall, NAT e "so escuta em
//  127.0.0.1" nao impedem nada: quem conectou foi a vitima.
//
//  A defesa e olhar o cabecalho `Host`. Numa conexao legitima ele
//  e `localhost`, `127.0.0.1` ou o IP da maquina na rede local;
//  no ataque ele e o dominio do atacante, porque foi o que o
//  navegador digitou. Nome que nao esta na lista nao entra.
//
//  E por isso que a regra padrao aceita IP LITERAL e recusa NOME:
//  para fazer o navegador conectar por IP literal, o atacante
//  teria que fazer a vitima abrir `http://127.0.0.1:8787` — e ai
//  a pagina dele nao esta na mesma origem, e o navegador nao
//  deixa ler nada.
// ============================================================

import type { FastifyReply, FastifyRequest } from 'fastify';
import { isIP } from 'node:net';

import { isIpAllowed, type IpRule } from './ip-allowlist.js';

/**
 * Hook de `onRequest` que aplica a lista de IPs a TODAS as rotas.
 *
 * Lista vazia = ninguem e barrado, o mesmo padrao de
 * `AGENT_ALLOWED_IPS` (ver ip-allowlist.ts).
 *
 * A resposta e 403 e nao 401: 401 quer dizer "faltou
 * credencial", e credencial nenhuma resolve estar na rede errada.
 */
export function createIpGuardHook(rules: readonly IpRule[]) {
  return async function ipGuardHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    if (rules.length === 0 || isIpAllowed(request.ip, rules)) {
      return undefined;
    }

    request.log.warn(
      { ip: request.ip, method: request.method, url: request.url },
      'origem fora de AGENT_ALLOWED_IPS',
    );

    return reply.code(403).send({ ok: false, error: 'IP_NOT_ALLOWED' });
  };
}

/**
 * Os nomes que sempre valem.
 *
 * `localhost` e o que o operador digita; os `.localhost` existem
 * porque a RFC 6761 reserva o sufixo inteiro para o loopback, e
 * nenhum resolvedor publico pode devolver outra coisa para ele.
 */
function isAlwaysAllowedHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/**
 * `host: "192.168.0.10:8787"` -> `192.168.0.10`.
 *
 * IPv6 chega entre colchetes (`[::1]:8787`), e a porta so pode
 * ser separada DEPOIS deles — cortar no primeiro `:` picaria o
 * endereco no meio.
 */
export function hostnameOf(header: string): string {
  const value = header.trim().toLowerCase();

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return close < 0 ? value : value.slice(1, close);
  }

  const colon = value.indexOf(':');
  return colon < 0 ? value : value.slice(0, colon);
}

/**
 * Hook de `onRequest` contra DNS rebinding. Ver o cabecalho.
 *
 * `allowedHosts` sao nomes extras (`AGENT_ALLOWED_HOSTS`), para
 * quem acessa o painel por um nome de rede local ou por um proxy
 * reverso com dominio proprio.
 */
export function createHostGuardHook(allowedHosts: readonly string[]) {
  const extras = new Set(allowedHosts.map((host) => hostnameOf(host)));

  return async function hostGuardHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    const header = request.headers.host;

    // Sem `Host` nao ha rebinding possivel: o ataque depende de o
    // NAVEGADOR mandar o dominio do atacante, e navegador sempre
    // manda. Um cliente HTTP/1.0 sem o cabecalho passa.
    if (typeof header !== 'string' || header.trim() === '') {
      return undefined;
    }

    const hostname = hostnameOf(header);

    // IP literal passa: o atacante nao consegue fazer o navegador
    // da vitima tratar `http://127.0.0.1:8787` como a origem dele.
    if (isIP(hostname) !== 0 || isAlwaysAllowedHost(hostname) || extras.has(hostname)) {
      return undefined;
    }

    request.log.warn(
      { ip: request.ip, host: hostname, url: request.url },
      'Host recusado — se este nome e legitimo, acrescente-o a AGENT_ALLOWED_HOSTS',
    );

    return reply.code(403).send({
      ok: false,
      error: 'HOST_NOT_ALLOWED',
      message:
        'este agente so aceita requisicoes por IP, por localhost ou pelos nomes de AGENT_ALLOWED_HOSTS',
    });
  };
}
