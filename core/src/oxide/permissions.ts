// ============================================================
//  permissions.ts  -  os grupos e as permissões do Oxide.
//
//  ####  QUEM MANDA AQUI É O OXIDE, E SÓ SE FALA COM ELE PELO
//        CONSOLE  ####
//
//  O estado mora em `oxide\data\oxide.groups.data` e
//  `oxide.users.data` — arquivos PROTOBUF, binários, reescritos
//  pelo próprio Oxide. Editá-los é impraticável e perigoso: o
//  servidor no ar tem tudo em memória e sobrescreve o disco quando
//  decidir.
//
//  Então isto aqui é como a aba Admins: o arquivo NÃO é tocado, e
//  quem muda o estado é o comando pelo RCON. A diferença é que o
//  Oxide, ao contrário do `users.cfg`, também responde à leitura —
//  `oxide.show` é a fonte, e ela está sempre fresca.
//
//  ------------------------------------------------------------
//  ####  O CONSOLE MENTE SOBRE O QUE ACEITA  ####
//
//  `oxide.group` sem argumento imprime `Usage: oxide.group
//  <add|set> <name> [title] [rank]` — e mesmo assim `remove` e
//  `parent` funcionam. MEDIDO no servidor (Oxide 2.0.7585): os
//  dois respondem "Group 'x' doesn't exist" em vez de imprimir o
//  uso, que é como se sabe que o subcomando existe.
//
//  Vale dizer em voz alta porque a conclusão contrária — "o
//  console não sabe definir grupo pai" — deixaria a herança do VIP
//  sem tela, quando ela é justamente o que se precisa ver.
//
//  ####  ELE TAMBÉM NÃO DEVOLVE CÓDIGO DE ERRO  ####
//
//  Devolve PROSA, em inglês:
//
//      Group 'x' doesn't exist
//      Permission 'x' doesn't exist
//      Player 'x' not found
//      Usage: oxide.grant <group|user> <name|id> <permission>
//
//  Reconhecer essas frases é o que transforma "mandei e não
//  aconteceu nada" num erro com motivo. O que não for reconhecido
//  passa como sucesso de propósito: um alarme falso a cada
//  concessão faria ninguém acreditar no verdadeiro — a mesma regra
//  do `lastReload.failed` em oxide/library.ts.
//
//  ####  A PERMISSÃO PRECISA EXISTIR ANTES  ####
//
//  Quem as registra é o PLUGIN, ao carregar
//  (`permission.RegisterPermission`). O `oxide.grant` recusa o que
//  ninguém registrou — e por isso a tela oferece uma lista, e não
//  um campo de texto: digitar uma permissão que não existe é o
//  jeito mais rápido de achar que se concedeu alguma coisa.
// ============================================================

import { ApiError } from '../http/error-response.js';
import type { OpsRcon } from '../ops/service.js';

/**
 * O que pode ser nome de grupo ou de permissão.
 *
 * Eles vão para a LINHA DE COMANDO do console do servidor. O regex
 * estrito é a mesma trava do nome de plugin (ver `pluginPath`):
 * sem ele, um nome com espaço ou aspas viraria dois argumentos — e
 * o comando faria outra coisa, em silêncio.
 *
 * O Oxide aceita mais que isto; restringir custa nada e fecha a
 * porta. Todo grupo que os plugins deste projeto criam
 * (`origemz.vip.bronze`) cabe aqui com folga.
 */
export const OXIDE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Um grupo, como o console o descreve. */
export interface OxideGroup {
  readonly name: string;
  /** Quem está DENTRO dele. */
  readonly members: readonly OxideMember[];
  /** O que foi concedido DIRETAMENTE a ele. */
  readonly permissions: readonly string[];
  /**
   * A cadeia de pais, do mais próximo ao mais distante.
   *
   * O `oxide.show group` não anuncia o pai: ele lista as
   * permissões dele logo abaixo, numa seção própria. É de onde
   * esta lista sai — e é a única forma de ver a herança sem abrir
   * o protobuf.
   */
  readonly parents: readonly string[];
  /** O que ele ganha de cada pai. */
  readonly inherited: readonly {
    readonly group: string;
    readonly permissions: readonly string[];
  }[];
}

export interface OxideMember {
  readonly steamId: string;
  /** O nome de quando o Oxide o viu. `null` = ele não trouxe. */
  readonly name: string | null;
}

/** O que um jogador tem naquele servidor. */
export interface OxideUser {
  readonly steamId: string;
  readonly name: string | null;
  readonly groups: readonly string[];
  readonly permissions: readonly string[];
}

/** Um plugin CARREGADO — o que o Oxide diz estar rodando. */
export interface OxideLoadedPlugin {
  readonly name: string;
  readonly version: string | null;
  readonly author: string | null;
  readonly file: string | null;
}

export interface OxideVersion {
  readonly version: string | null;
  readonly branch: string | null;
}

/**
 * Teto de grupos detalhados numa leitura.
 *
 * ####  UM COMANDO POR GRUPO, E É POR ISSO QUE HÁ TETO  ####
 *
 * O console não tem um "mostre tudo": `oxide.show groups` devolve
 * só os nomes, e o conteúdo sai de um `oxide.show group <nome>`
 * por vez. Com os seis grupos de um servidor normal são oito
 * comandos por abertura de tela — aceitável. Com trezentos seria
 * uma tela que demora meio minuto e ocupa a fila do RCON.
 */
export const MAX_GROUPS_READ = 60;

export interface OxidePermissionsView {
  readonly groups: readonly OxideGroup[];
  /** Tudo o que os plugins registraram naquele servidor. */
  readonly permissions: readonly string[];
  /**
   * Quantos grupos ficaram sem detalhe.
   *
   * `0` é o normal. Diferente disso, a tela precisa dizer — uma
   * lista truncada que não avisa que truncou é pior que lista
   * nenhuma (a mesma regra do `droppedLines` do log de operação).
   */
  readonly truncated: number;
}

// ------------------------------------------------------------
//  Leitura
// ------------------------------------------------------------

export async function readPermissions(rcon: OpsRcon): Promise<OxidePermissionsView> {
  const names = parseGroupNames(await rcon.send('oxide.show groups'));
  const permissions = parsePermissionNames(await rcon.send('oxide.show perms'));

  const groups: OxideGroup[] = [];

  for (const name of names.slice(0, MAX_GROUPS_READ)) {
    groups.push(parseGroup(name, await rcon.send(`oxide.show group ${name}`)));
  }

  return { groups, permissions, truncated: Math.max(0, names.length - MAX_GROUPS_READ) };
}

/** O que um jogador tem: os grupos dele e as permissões soltas. */
export async function readUser(rcon: OpsRcon, steamId: string): Promise<OxideUser> {
  return parseUser(steamId, await rcon.send(`oxide.show user ${steamId}`));
}

/** A versão do Oxide e o que ele diz estar rodando. */
export async function readOxideStatus(rcon: OpsRcon): Promise<{
  readonly oxide: OxideVersion;
  readonly plugins: readonly OxideLoadedPlugin[];
}> {
  const oxide = parseVersion(await rcon.send('oxide.version'));
  const plugins = parseLoadedPlugins(await rcon.send('oxide.plugins'));

  return { oxide, plugins };
}

// ------------------------------------------------------------
//  Escrita
// ------------------------------------------------------------

export interface CreateGroupInput {
  readonly name: string;
  /** O rótulo que os plugins usam como tag no chat. */
  readonly title?: string | null;
  /** A ordem entre grupos. O Oxide aceita qualquer inteiro. */
  readonly rank?: number | null;
  /** De quem ele herda as permissões. */
  readonly parent?: string | null;
}

/**
 * Cria o grupo (e define o pai, se pedido).
 *
 * ####  CRIAR NÃO É O CAMINHO NORMAL DO VIP  ####
 *
 * Os grupos de VIP são criados pelo PRÓPRIO plugin ao carregar, a
 * partir do config dele (`permission.CreateGroup`). Criar um à mão
 * aqui e esperar que o plugin o use é ao contrário: quem decide o
 * nome é o config.
 *
 * A criação existe para o resto — o grupo de evento, o de
 * construtor, o que um plugin de terceiro espera encontrar pronto.
 *
 * @throws {ApiError} 400 no nome fora de formato, 404 quando o
 * Oxide recusa por não conhecer o pai.
 */
export async function createGroup(rcon: OpsRcon, input: CreateGroupInput): Promise<string> {
  assertOxideName(input.name, 'grupo');

  const parts = ['oxide.group add', input.name];

  // O título vai entre aspas porque ele tem espaço ("VIP Ouro").
  // Sem o par de aspas, "Ouro" viraria o `rank` — e o comando
  // funcionaria, com o resultado errado.
  if (input.title != null && input.title !== '') {
    parts.push(`"${sanitizeTitle(input.title)}"`);

    if (input.rank != null) {
      // O rank só entra DEPOIS do título: são posicionais. Mandar
      // rank sem título faria o número virar o título.
      parts.push(String(Math.trunc(input.rank)));
    }
  }

  const output = assertAccepted(await rcon.send(parts.join(' ')), { group: input.name });

  if (input.parent != null && input.parent !== '') {
    await setGroupParent(rcon, input.name, input.parent);
  }

  await save(rcon);

  return output;
}

/**
 * Muda título e rank de um grupo que já existe.
 *
 * O console NÃO devolve os valores atuais (o `oxide.show group` só
 * mostra membros e permissões), então isto é uma escrita cega de
 * propósito: a tela pede os dois juntos, em vez de fingir que sabe
 * o que está lá.
 */
export async function setGroupTitle(
  rcon: OpsRcon,
  name: string,
  title: string,
  rank: number | null,
): Promise<string> {
  assertOxideName(name, 'grupo');

  const parts = ['oxide.group set', name, `"${sanitizeTitle(title)}"`];

  if (rank != null) {
    parts.push(String(Math.trunc(rank)));
  }

  const output = assertAccepted(await rcon.send(parts.join(' ')), { group: name });

  await save(rcon);

  return output;
}

/**
 * Define de quem o grupo herda.
 *
 * É o que faz `origemz.vip.gold` valer tudo o que o silver e o
 * bronze valem. Pai vazio DESLIGA a herança.
 */
export async function setGroupParent(
  rcon: OpsRcon,
  name: string,
  parent: string | null,
): Promise<string> {
  assertOxideName(name, 'grupo');

  if (parent !== null && parent !== '') {
    assertOxideName(parent, 'grupo');

    if (parent === name) {
      throw new ApiError(
        'OXIDE_INVALID_PARENT',
        `Um grupo não pode herdar de si mesmo ("${name}").`,
        400,
      );
    }
  }

  const output = assertAccepted(
    await rcon.send(`oxide.group parent ${name} ${parent ?? ''}`.trim()),
    { group: name },
  );

  await save(rcon);

  return output;
}

/**
 * Apaga o grupo.
 *
 * ####  ISTO NÃO SE DESFAZ PELO CONSOLE  ####
 *
 * Some com as permissões dele e com a lista de quem estava dentro.
 * Um grupo que um plugin espera encontrar é recriado por ele no
 * próximo carregamento — VAZIO. Quem confirma é a tela, com o
 * número de membros na frase.
 */
export async function removeGroup(rcon: OpsRcon, name: string): Promise<string> {
  assertOxideName(name, 'grupo');

  const output = assertAccepted(await rcon.send(`oxide.group remove ${name}`), { group: name });

  await save(rcon);

  return output;
}

/** Concede uma permissão a um grupo. Ela precisa EXISTIR. */
export async function grantToGroup(
  rcon: OpsRcon,
  group: string,
  permission: string,
): Promise<string> {
  assertOxideName(group, 'grupo');
  assertOxideName(permission, 'permissão');

  const output = assertAccepted(await rcon.send(`oxide.grant group ${group} ${permission}`), {
    group,
    permission,
  });

  await save(rcon);

  return output;
}

export async function revokeFromGroup(
  rcon: OpsRcon,
  group: string,
  permission: string,
): Promise<string> {
  assertOxideName(group, 'grupo');
  assertOxideName(permission, 'permissão');

  const output = assertAccepted(await rcon.send(`oxide.revoke group ${group} ${permission}`), {
    group,
    permission,
  });

  await save(rcon);

  return output;
}

/**
 * Põe ou tira um jogador de um grupo.
 *
 * O comando aceita nome OU SteamID, e aqui é sempre o SteamID —
 * MEDIDO: `oxide.usergroup add <steamid64> <grupo>` resolve o
 * jogador. Nome muda, SteamID não, e dois jogadores podem ter o
 * mesmo nome no mesmo dia.
 *
 * O jogador precisa ser CONHECIDO do servidor (ter entrado uma
 * vez): o Oxide responde "Player 'x' not found" para quem nunca
 * pisou lá.
 */
export async function setUserGroup(
  rcon: OpsRcon,
  steamId: string,
  group: string,
  member: boolean,
): Promise<string> {
  assertOxideName(group, 'grupo');

  const output = assertAccepted(
    await rcon.send(`oxide.usergroup ${member ? 'add' : 'remove'} ${steamId} ${group}`),
    { group, steamId },
  );

  await save(rcon);

  return output;
}

/**
 * `oxide.save` depois de cada mudança.
 *
 * Mesma razão do `server.writecfg` da BanList: sem ele o estado
 * fica na memória do Oxide até ele decidir gravar, e um crash
 * perde a concessão que alguém acabou de fazer. Falhar aqui não
 * desfaz a mudança — ela já vale no servidor.
 */
async function save(rcon: OpsRcon): Promise<void> {
  try {
    await rcon.send('oxide.save');
  } catch {
    // Ver o cabeçalho: o que se perde é a gravação em disco, e só
    // num crash. Não é motivo para dizer que a ação falhou.
  }
}

// ------------------------------------------------------------
//  Os parsers
//
//  Todos toleram linha de log no meio: a resposta do RCON traz o
//  que o servidor estava imprimindo naquele instante.
// ------------------------------------------------------------

/** `Groups:\ndefault, admin, origemz.vip.gold` */
export function parseGroupNames(raw: string): readonly string[] {
  return parseNameList(raw, 'Groups:');
}

/** `Permissions:\noxide.plugins, oxide.load, …` */
export function parsePermissionNames(raw: string): readonly string[] {
  return parseNameList(raw, 'Permissions:');
}

function parseNameList(raw: string, header: string): readonly string[] {
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex((line) => line === header);

  if (start < 0) {
    return [];
  }

  const names: string[] = [];

  // A lista pode quebrar em várias linhas num servidor com muitos
  // grupos; ela termina na primeira linha vazia ou noutro
  // cabeçalho.
  for (const line of lines.slice(start + 1)) {
    if (line === '' || line.endsWith(':')) {
      break;
    }

    for (const name of line.split(',')) {
      const trimmed = name.trim();

      if (trimmed !== '') {
        names.push(trimmed);
      }
    }
  }

  return names;
}

/**
 * A resposta de `oxide.show group <nome>`:
 *
 *     Group 'origemz.vip.gold' players:
 *     76561198065694695 (Mateuus)
 *
 *     Group 'origemz.vip.gold' permissions:
 *     No permissions currently granted
 *     Parent group 'origemz.vip.silver' permissions:
 *     alguma.permissao
 *
 * As frases "No players currently in group" e "No permissions
 * currently granted" são listas VAZIAS, e não conteúdo — sem
 * reconhecê-las, elas apareceriam na tela como um jogador chamado
 * "No players currently in group".
 */
export function parseGroup(name: string, raw: string): OxideGroup {
  const members: OxideMember[] = [];
  const permissions: string[] = [];
  const parents: string[] = [];
  const inherited: { group: string; permissions: string[] }[] = [];

  let section: 'nada' | 'players' | 'permissions' | 'parent' = 'nada';
  let parent: { group: string; permissions: string[] } | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed === '') {
      continue;
    }

    if (/^Group '(.+)' players:$/.test(trimmed)) {
      section = 'players';
      continue;
    }

    if (/^Group '(.+)' permissions:$/.test(trimmed)) {
      section = 'permissions';
      continue;
    }

    const parentHeader = /^Parent group '(.+)' permissions:$/.exec(trimmed);

    if (parentHeader !== null) {
      section = 'parent';
      parent = { group: parentHeader[1] ?? '', permissions: [] };
      parents.push(parent.group);
      inherited.push(parent);
      continue;
    }

    if (isEmptyMarker(trimmed)) {
      continue;
    }

    if (section === 'players') {
      const member = parseMember(trimmed);

      if (member !== null) {
        members.push(member);
      }

      continue;
    }

    if (section === 'permissions') {
      permissions.push(trimmed);
      continue;
    }

    if (section === 'parent' && parent !== null) {
      parent.permissions.push(trimmed);
    }
  }

  return { name, members, permissions, parents, inherited };
}

/**
 * A resposta de `oxide.show user <id>`:
 *
 *     Player 'Mateuus (76561198065694695)' permissions:
 *     No permissions currently granted
 *
 *     Player 'Mateuus (76561198065694695)' groups:
 *     default
 */
export function parseUser(steamId: string, raw: string): OxideUser {
  const groups: string[] = [];
  const permissions: string[] = [];
  let name: string | null = null;
  let section: 'nada' | 'permissions' | 'groups' = 'nada';

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed === '') {
      continue;
    }

    const header = /^Player '(.*?)\s*\((\d{17})\)' (permissions|groups):$/.exec(trimmed);

    if (header !== null) {
      name = header[1] === undefined || header[1] === '' ? name : header[1];
      section = header[3] === 'groups' ? 'groups' : 'permissions';
      continue;
    }

    if (isEmptyMarker(trimmed)) {
      continue;
    }

    if (section === 'groups') {
      groups.push(trimmed);
    } else if (section === 'permissions') {
      permissions.push(trimmed);
    }
  }

  return { steamId, name, groups, permissions };
}

/**
 * `Oxide.Rust Version: 2.0.7585` + `Oxide.Rust Branch: master`
 *
 * `null` nos dois quando a resposta não veio no formato: dizer
 * "desconhecida" é melhor que inventar um número de versão, que é
 * o que alguém usaria para decidir atualizar.
 */
export function parseVersion(raw: string): OxideVersion {
  const version = /Version:\s*(\S+)/.exec(raw);
  const branch = /Branch:\s*(\S+)/.exec(raw);

  return { version: version?.[1] ?? null, branch: branch?.[1] ?? null };
}

/**
 * A resposta de `oxide.plugins`:
 *
 *     Listing 6 plugins:
 *       01 "OrigemZAgent" (0.3.0) by OrigemZ (0.14s / 2 MB) - OrigemZAgent.cs
 *
 * ####  ISTO NÃO É O ACERVO DO AGENTE  ####
 *
 * É o que o Oxide CARREGOU de verdade, agora. Um plugin que o
 * acervo diz estar ligado e que não aparece aqui é um plugin que
 * não compilou — e essa diferença é justamente o que a aba mostra.
 */
export function parseLoadedPlugins(raw: string): readonly OxideLoadedPlugin[] {
  const plugins: OxideLoadedPlugin[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*\d+\s+"(.+?)"\s+\((\S+)\)\s+by\s+(.+?)\s+\(.*?\)(?:\s+-\s+(\S+))?\s*$/.exec(
      line,
    );

    if (match === null) {
      continue;
    }

    plugins.push({
      name: match[1] ?? '',
      version: match[2] ?? null,
      author: match[3] ?? null,
      file: match[4] ?? null,
    });
  }

  return plugins;
}

/** "não há nada nesta seção", nas palavras do Oxide. */
function isEmptyMarker(line: string): boolean {
  return (
    line.startsWith('No players currently') ||
    line.startsWith('No permissions currently') ||
    line.startsWith('No groups currently')
  );
}

/** `76561198065694695 (Mateuus)` — e o nome é opcional. */
function parseMember(line: string): OxideMember | null {
  const match = /^(\d{17})(?:\s*\((.*)\))?$/.exec(line);

  if (match === null) {
    return null;
  }

  return {
    steamId: match[1] ?? '',
    name: match[2] === undefined || match[2] === '' ? null : match[2],
  };
}

// ------------------------------------------------------------
//  A recusa em prosa
// ------------------------------------------------------------

/** Sobre o que o comando falava, para a mensagem saber dizer. */
export interface OxideTarget {
  readonly group?: string;
  readonly permission?: string;
  readonly steamId?: string;
}

/**
 * O Oxide aceitou?
 *
 * Ele não devolve código: devolve frase, em inglês. Estas quatro
 * são as que ele usa, MEDIDAS no servidor — e cada uma vira um
 * erro com o motivo em português, porque "mandei e não aconteceu
 * nada" é o pior desfecho possível para quem clicou.
 *
 * O que não casar passa como sucesso, de propósito: o console
 * imprime linhas de log entre as respostas, e um alarme falso a
 * cada concessão faria ninguém acreditar no verdadeiro.
 *
 * @throws {ApiError} 404 quando faltou grupo, permissão ou
 * jogador; 502 quando ele respondeu com o uso do comando.
 */
export function assertAccepted(raw: string, target: OxideTarget = {}): string {
  const text = raw.trim();

  if (/Group '(.+)' doesn't exist/.test(text)) {
    throw new ApiError(
      'OXIDE_GROUP_NOT_FOUND',
      `O Oxide não conhece o grupo "${target.group ?? '?'}" neste servidor. Ele nasce quando um ` +
        'plugin o cria ao carregar, ou aqui mesmo, em Criar grupo.',
      404,
    );
  }

  if (/Permission '(.+)' doesn't exist/.test(text)) {
    throw new ApiError(
      'OXIDE_PERMISSION_NOT_FOUND',
      `Nenhum plugin registrou a permissão "${target.permission ?? '?'}" neste servidor. Quem ` +
        'cria permissão é o plugin, ao carregar — a lista da tela é o que existe de verdade.',
      404,
    );
  }

  if (/Player '(.+)' not found/.test(text)) {
    throw new ApiError(
      'OXIDE_PLAYER_NOT_FOUND',
      `O Oxide não conhece o jogador ${target.steamId ?? ''} neste servidor. Ele passa a ` +
        'conhecê-lo na primeira vez que o jogador entrar.',
      404,
    );
  }

  if (/^Usage:/m.test(text)) {
    throw new ApiError(
      'OXIDE_COMMAND_REFUSED',
      `O Oxide recusou o comando e respondeu com o uso dele: ${text.slice(0, 200)}`,
      502,
    );
  }

  return text;
}

/**
 * @throws {ApiError} 400.
 *
 * A mensagem diz o formato porque o engano comum é o espaço no
 * meio — "vip ouro" em vez de "vip.ouro" — e o console aceitaria o
 * primeiro pedaço em silêncio.
 */
export function assertOxideName(value: string, kind: 'grupo' | 'permissão'): void {
  if (!OXIDE_NAME_PATTERN.test(value)) {
    throw new ApiError(
      'OXIDE_INVALID_NAME',
      `"${value}" não serve como nome de ${kind}: use letras, números, ponto, hífen ou ` +
        'sublinhado, sem espaço e sem acento (o nome vai para a linha de comando do servidor). ' +
        'Os grupos deste projeto se parecem com "origemz.vip.bronze".',
      400,
    );
  }
}

/**
 * O título vai entre aspas no comando, então uma aspa dentro dele
 * fecharia o argumento cedo — e o resto viraria `rank`.
 *
 * Mesma limpeza do motivo de banimento (`sanitizeArgument`).
 */
function sanitizeTitle(title: string): string {
  return title.replace(/["\r\n]/g, '').trim().slice(0, 64);
}
