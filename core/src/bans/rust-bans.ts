// ============================================================
//  rust-bans.ts  -  o vocabulário de banimento DO JOGO.
//
//  Montar as três linhas de comando e ler a resposta de uma
//  delas. Nada aqui conhece a tabela `bans` — quem decide o que
//  mandar é bans/service.ts, e essa separação é o que permite
//  testar o parser com uma string, sem servidor nenhum.
//
//  ------------------------------------------------------------
//  ####  É `banid`, NUNCA `ban`  ####
//
//  O `ban` do Rust age sobre quem está CONECTADO: ele procura o
//  jogador na lista de ativos e, não achando, não faz nada — sem
//  erro. A maioria dos banimentos por sincronização é de gente
//  offline, então usar `ban` produziria uma lista que "aplicou"
//  sem aplicar.
//
//  `banid <steamid> "<nome>" "<motivo>"` funciona com o jogador em
//  qualquer estado, porque o que ele guarda é o ID.
//
//  ####  E O `server.writecfg` NÃO É ZELO  ####
//
//  O Rust mantém a lista em memória e grava o `bans.cfg` quando
//  ele decide (no save, no quit limpo). Um crash entre o `banid` e
//  essa gravação perde o banimento inteiro — e ninguém liga uma
//  coisa à outra, porque a tela do agente continua dizendo que o
//  jogador está banido.
//
//  ------------------------------------------------------------
//  ####  ASPAS SÃO O PERIGO REAL AQUI  ####
//
//  O nome e o motivo entram entre aspas na linha de comando, e os
//  dois vêm de fora: o nome é escolhido pelo jogador, o motivo é
//  digitado por quem bane. Uma aspa no meio de qualquer um deles
//  FECHA o argumento cedo, e o resto da frase vira argumento
//  seguinte — no melhor caso o motivo sai truncado, no pior o
//  console lê um comando que ninguém escreveu.
//
//  `sanitizeArgument` é a única porta por onde esses dois passam.
// ============================================================

import type { OpsRcon } from '../ops/service.js';

/** Um banimento como o SERVIDOR o conhece. */
export interface RustBan {
  readonly steamId: string;
  /** `null` quando a resposta não trouxe nome. */
  readonly name: string | null;
  /** `null` quando a resposta não trouxe motivo. */
  readonly reason: string | null;
}

/** SteamID64: 17 dígitos, sempre. */
export const STEAM_ID_PATTERN = /^\d{17}$/;

/**
 * O texto que pode ir entre aspas num comando de console.
 *
 * Some o que quebraria a linha (aspas, `\r`, `\n`) e o excesso de
 * espaço. O corte em 128 caracteres é prático: um motivo de dois
 * parágrafos não cabe no `bans.cfg` de forma útil, e a linha de
 * comando tem teto do outro lado.
 *
 * O `fallback` existe para o campo ausente: `banid <id> "" "motivo"`
 * é aceito pelo Rust, e produz uma lista onde ninguém sabe de quem
 * é o ID.
 */
export function sanitizeArgument(value: string | null, fallback: string): string {
  const clean = (value ?? '')
    .replace(/["'\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 128);

  return clean === '' ? fallback : clean;
}

/** `banid <steamid> "<nome>" "<motivo>"`. */
export function buildBanCommand(ban: {
  readonly steamId: string;
  readonly name: string | null;
  readonly reason: string;
}): string {
  const name = sanitizeArgument(ban.name, 'desconhecido');
  const reason = sanitizeArgument(ban.reason, 'sem motivo registrado');

  return `banid ${ban.steamId} "${name}" "${reason}"`;
}

export function buildUnbanCommand(steamId: string): string {
  return `unban ${steamId}`;
}

/**
 * O que o servidor tem hoje.
 *
 * ####  O FORMATO DA RESPOSTA NÃO É ESTÁVEL  ####
 *
 * O `playerlist` responde JSON; o `banlist` já respondeu texto e
 * já respondeu JSON, dependendo da versão do jogo — e nada avisa
 * qual dos dois virá. Um parser que aceitasse só um deles
 * devolveria lista vazia na versão errada, e lista vazia aqui tem
 * uma consequência específica e ruim: a reconciliação concluiria
 * que o servidor não tem ban nenhum e reaplicaria tudo a cada
 * rodada.
 *
 * Por isso a leitura tenta o JSON primeiro e cai para a varredura
 * por linha, que só depende de uma coisa que os dois formatos têm:
 * o SteamID de 17 dígitos.
 *
 * `null` = não deu para entender a resposta. Diferente de `[]`,
 * que é "o servidor não tem ninguém banido" — e é essa diferença
 * que impede a reconciliação de agir sobre um palpite.
 */
export function parseBanList(response: string): readonly RustBan[] | null {
  const text = response.trim();

  if (text === '') {
    // Servidor sem banimento nenhum responde vazio. É um fato, e
    // não uma falha de leitura.
    return [];
  }

  const asJson = parseJsonBanList(text);

  if (asJson !== null) {
    return asJson;
  }

  const bans: RustBan[] = [];

  for (const line of text.split(/\r?\n/)) {
    const steamId = /\b(\d{17})\b/.exec(line)?.[1];

    if (steamId === undefined) {
      continue;
    }

    // `"Fulano" "motivo"`, na ordem em que o Rust escreve o
    // `bans.cfg`. Faltando um dos dois, o que sobra é o nome — é o
    // que a linha `banid <id> "<nome>"` produz.
    const quoted = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '');

    bans.push({
      steamId,
      name: nonEmpty(quoted[0]),
      reason: nonEmpty(quoted[1]),
    });
  }

  // Texto sem SteamID nenhum é resposta que não entendemos — e não
  // um servidor sem banidos. Ver o cabeçalho.
  return bans.length === 0 ? null : bans;
}

/**
 * Manda o `banlist` e devolve o que o servidor tem.
 *
 * `null` em dois casos, e do ponto de vista de quem chama eles são
 * o mesmo: não deu para perguntar (RCON fora, comando falhou) ou
 * não deu para entender. Nos dois, a resposta certa é adiar a
 * reconciliação — nunca supor lista vazia.
 */
export async function readServerBans(rcon: OpsRcon): Promise<readonly RustBan[] | null> {
  if (!rcon.isConnected) {
    return null;
  }

  try {
    return parseBanList(await rcon.send('banlist'));
  } catch {
    return null;
  }
}

/**
 * Grava o `bans.cfg` agora.
 *
 * Usa `sendWithoutReply` quando o cliente o oferece: o
 * `server.writecfg` responde VAZIO, e num tempo que depende do que
 * o servidor está fazendo — esperar por essa resposta é o caminho
 * conhecido de transformar um comando ENTREGUE em timeout
 * registrado (ver o cabeçalho de `sendWithoutReply`, em
 * rcon/client.ts).
 */
export async function writeServerConfig(rcon: OpsRcon): Promise<void> {
  const withoutReply = (rcon as { sendWithoutReply?: (command: string) => Promise<void> })
    .sendWithoutReply;

  if (typeof withoutReply === 'function') {
    await withoutReply.call(rcon, 'server.writecfg');
    return;
  }

  await rcon.send('server.writecfg');
}

/** `[{"steamid":"765…","username":"Fulano","notes":"motivo"}]` */
function parseJsonBanList(text: string): readonly RustBan[] | null {
  if (!text.startsWith('[') && !text.startsWith('{')) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.bans)
      ? parsed.bans
      : null;

  if (list === null) {
    return null;
  }

  const bans: RustBan[] = [];

  for (const entry of list) {
    if (!isRecord(entry)) {
      continue;
    }

    // Os nomes de campo variam entre versões (`steamid`, `SteamID`,
    // `steamId`). Aceitar os três custa uma linha e evita um parser
    // que funciona só na versão em que foi escrito.
    const steamId = firstString(entry, ['steamid', 'SteamID', 'steamId', 'id']);

    if (steamId === null || !STEAM_ID_PATTERN.test(steamId)) {
      continue;
    }

    bans.push({
      steamId,
      name: firstString(entry, ['username', 'name', 'DisplayName']),
      reason: firstString(entry, ['notes', 'reason', 'note']),
    });
  }

  return bans;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }

    // O SteamID às vezes vem como número no JSON. Ele não
    // sobrevive a isso com precisão — mas recusá-lo aqui seria
    // ignorar um ban que EXISTE no servidor. Melhor lê-lo e deixar
    // a validação de 17 dígitos decidir.
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';

  return trimmed === '' ? null : trimmed;
}
