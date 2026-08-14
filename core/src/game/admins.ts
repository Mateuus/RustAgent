// ============================================================
//  admins.ts  -  quem manda naquele servidor.
//
//  O Rust tem dois níveis, e eles não são o mesmo:
//
//      ownerid       auth level 2 — tudo, inclusive os comandos
//                    que mexem no servidor
//      moderatorid   auth level 1 — expulsar, banir, teleportar
//
//  ------------------------------------------------------------
//  ####  O ARQUIVO É LIDO, E NUNCA ESCRITO  ####
//
//  `Servers\<id>\server\<identity>\cfg\users.cfg` é gravado pelo
//  PRÓPRIO jogo, a partir do que ele tem em memória, a cada
//  `server.writecfg`. Editá-lo com o servidor no ar não adianta:
//  a próxima gravação reescreve o arquivo inteiro e a mudança some
//  — sem erro, sem log, sem nada ligando uma coisa à outra.
//
//  Quem muda o estado é o COMANDO pelo RCON, sempre. O arquivo
//  serve para uma coisa só, e ela é útil: listar os admins de um
//  servidor PARADO, que é quando não há RCON para perguntar.
//
//  ####  E COM O SERVIDOR NO AR, QUEM RESPONDE É ELE  ####
//
//  O `users.cfg` de um servidor no ar está desatualizado por
//  definição: ele reflete o último `writecfg`, e os `ownerid` desta
//  sessão ainda não entraram nele. Por isso a leitura prefere o
//  comando quando dá, e o arquivo é a queda.
// ============================================================

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sanitizeArgument, STEAM_ID_PATTERN } from '../bans/rust-bans.js';
import { ApiError } from '../http/error-response.js';
import type { OpsRcon } from '../ops/service.js';

/** Os dois níveis do Rust. */
export type AdminLevel = 'owner' | 'moderator';

export interface AdminEntry {
  readonly steamId: string;
  readonly level: AdminLevel;
  /** O nome que o `users.cfg` guardou. `null` = não havia. */
  readonly name: string | null;
  /** A nota que acompanha a linha. `null` = não havia. */
  readonly note: string | null;
}

export interface AdminList {
  readonly admins: readonly AdminEntry[];
  /**
   * De onde a lista veio.
   *
   *   `servidor`  do `users.cfg` gravado pelo jogo
   *   `ausente`   o arquivo ainda não existe — é o estado normal
   *               de um servidor que nunca subiu
   */
  readonly source: 'servidor' | 'ausente';
  /** O caminho lido. Vai para a tela: ele explica o resto. */
  readonly path: string;
}

/** `Servers\<id>\server\<identity>\cfg\users.cfg`. */
export function usersCfgPath(installDir: string, identity: string): string {
  return join(installDir, 'server', identity, 'cfg', 'users.cfg');
}

/**
 * Os admins daquele servidor, lidos do arquivo.
 *
 * Arquivo ausente NÃO é erro: é o estado de um servidor que nunca
 * subiu, e a resposta certa é uma lista vazia dizendo isso — não
 * um 500 que assusta.
 */
export async function readAdmins(installDir: string, identity: string): Promise<AdminList> {
  const path = usersCfgPath(installDir, identity);

  let content: string;

  try {
    content = await readFile(path, 'utf8');
  } catch {
    return { admins: [], source: 'ausente', path };
  }

  return { admins: parseUsersCfg(content), source: 'servidor', path };
}

/**
 * `ownerid 765… "Fulano" "nota"`, uma linha por admin.
 *
 * O parser é tolerante de propósito: o arquivo é editável à mão e
 * quem o edita nem sempre põe os dois campos entre aspas. O que
 * ele exige é o comando e um SteamID de 17 dígitos — sem os dois,
 * a linha não descreve um admin.
 */
export function parseUsersCfg(content: string): readonly AdminEntry[] {
  const admins: AdminEntry[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === '' || line.startsWith('#') || line.startsWith('//')) {
      continue;
    }

    const level: AdminLevel | null = line.startsWith('ownerid')
      ? 'owner'
      : line.startsWith('moderatorid')
        ? 'moderator'
        : null;

    if (level === null) {
      continue;
    }

    const steamId = /\b(\d{17})\b/.exec(line)?.[1];

    if (steamId === undefined) {
      continue;
    }

    const quoted = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '');

    admins.push({
      steamId,
      level,
      name: nonEmpty(quoted[0]),
      note: nonEmpty(quoted[1]),
    });
  }

  return admins;
}

/**
 * Promove pelo RCON.
 *
 * ####  O COMANDO É QUEM MUDA O ESTADO  ####
 *
 * Ele vale na hora, com o jogador dentro do jogo inclusive. O
 * `server.writecfg` depois é o que faz a mudança sobreviver a um
 * crash — sem ele, o `users.cfg` só é gravado quando o servidor
 * decidir.
 *
 * @throws {ApiError} 400 no SteamID fora de formato, 503 sem RCON.
 */
export async function grantAdmin(
  serverId: string,
  rcon: OpsRcon,
  input: { readonly steamId: string; readonly name: string | null; readonly level: AdminLevel },
): Promise<string> {
  assertAdminSteamId(input.steamId);
  assertConnected(serverId, rcon);

  const command = input.level === 'owner' ? 'ownerid' : 'moderatorid';
  // Aspas no nome fechariam o argumento cedo e o resto da frase
  // viraria o argumento seguinte. Ver `sanitizeArgument`.
  const name = sanitizeArgument(input.name, 'sem nome');

  const output = await rcon.send(`${command} ${input.steamId} "${name}" ""`);

  await writeConfig(rcon);

  return output;
}

/**
 * Rebaixa pelo RCON.
 *
 * O comando é o par do que promoveu: `removeowner` não tira um
 * moderador, e vice-versa. Mandar o errado não dá erro — não faz
 * nada, que é pior.
 *
 * @throws {ApiError} 400 no SteamID fora de formato, 503 sem RCON.
 */
export async function revokeAdmin(
  serverId: string,
  rcon: OpsRcon,
  input: { readonly steamId: string; readonly level: AdminLevel },
): Promise<string> {
  assertAdminSteamId(input.steamId);
  assertConnected(serverId, rcon);

  const command = input.level === 'owner' ? 'removeowner' : 'removemoderator';
  const output = await rcon.send(`${command} ${input.steamId}`);

  await writeConfig(rcon);

  return output;
}

/**
 * `server.writecfg` — grava o `users.cfg` agora.
 *
 * Falhar aqui não desfaz a promoção: ela já vale na memória do
 * servidor. O que se perde é a sobrevivência a um crash, e isso é
 * um aviso, não um erro que devolva a ação.
 */
async function writeConfig(rcon: OpsRcon): Promise<void> {
  try {
    await rcon.send('server.writecfg');
  } catch {
    // Ver o comentário acima. Quem quiser o detalhe tem o log do
    // console do servidor, na aba ao lado.
  }
}

function assertAdminSteamId(steamId: string): void {
  if (!STEAM_ID_PATTERN.test(steamId)) {
    throw new ApiError(
      'INVALID_STEAM_ID',
      `"${steamId}" não é um SteamID64. Ele tem exatamente 17 dígitos e começa com 7656 — é o ` +
        'que aparece na coluna SteamID da aba Jogadores.',
      400,
    );
  }
}

function assertConnected(serverId: string, rcon: OpsRcon): void {
  if (!rcon.isConnected) {
    throw new ApiError(
      'RCON_UNAVAILABLE',
      `Sem conexão com o RCON do servidor "${serverId}". Promover e rebaixar admin é comando, ` +
        'e comando precisa do servidor no ar — editar o users.cfg à mão não adianta, porque o ' +
        'jogo reescreve o arquivo inteiro no próximo server.writecfg.',
      503,
    );
  }
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';

  return trimmed === '' ? null : trimmed;
}
