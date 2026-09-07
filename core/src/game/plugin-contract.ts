// ============================================================
//  ####  CONTRATO COMPARTILHADO COM O PLUGIN OXIDE  ####
//
//  Este arquivo descreve, do lado do agente, o formato EXATO que
//  o `OrigemZAgent.cs` (em `Plugins\`) produz. As duas pontas são
//  compiladas separadamente — não existe tipo compartilhado em
//  tempo de compilação, só este documento e os schemas abaixo.
//
//  MUDAR QUALQUER COISA AQUI EXIGE MUDAR O PLUGIN JUNTO. Se as
//  pontas divergirem, o agente RECUSA a resposta
//  (`PLUGIN_INVALID_RESPONSE`) — de propósito: uma resposta que
//  não bate com o contrato nunca é tratada como sucesso.
//
//  ####  "ZERO JOGADORES" E "NÃO CONSEGUI PERGUNTAR" SÃO
//        RESPOSTAS DIFERENTES  ####
//
//  E a segunda não pode se disfarçar da primeira. Um `catch` que
//  devolvesse lista vazia faria a tela dizer "servidor vazio"
//  quando o plugin está fora do ar — que é exatamente a hora em
//  que alguém precisa saber.
//
//  ------------------------------------------------------------
//  ####  REGRA DE OURO DO TRANSPORTE  ####
//
//  O plugin responde JSON em UMA ÚNICA LINHA, sem quebra no meio.
//  O RCON entrega a saída do console como texto solto, e o agente
//  separa as respostas por linha: um JSON indentado em várias
//  linhas chegaria como vários fragmentos inválidos.
//
//  A linha de JSON pode vir acompanhada de outras (log do
//  servidor, aviso do Oxide). Quem acha a linha certa é
//  `parsePluginResponse`, abaixo.
//
//  ------------------------------------------------------------
//  ####  A RESPOSTA É PAGINADA  ####
//
//  `origemz.players [offset] [limit]`. O frame do WebRCON não
//  negocia tamanho, e a lista completa de um servidor cheio é
//  exatamente o caminho que o trunca — resposta truncada chega
//  como JSON inválido, que parece bug do plugin e é limite de
//  transporte.
//
//  `count` é o TOTAL, e não o tamanho da página; `offset` e
//  `limit` voltam JÁ NORMALIZADOS, então quem pede 5000 recebe
//  500 e VÊ isso na resposta em vez de achar que o resto sumiu.
// ============================================================

import { z } from 'zod';

/**
 * Os comandos de console do plugin.
 *
 * O prefixo `origemz.` é o namespace do projeto: comando de
 * console no Oxide é global, e sem ele dois plugins com um
 * `players` colidiriam.
 */
export const PLUGIN_COMMANDS = {
  /** `origemz.players [offset] [limit]` — quem está online. */
  players: 'origemz.players',
  /** `origemz.player.teleport <steamId> <x> <z> [y]`. */
  teleport: 'origemz.player.teleport',
  /** `origemz.give <steamId> <shortname> <amount> <skinId> <mode>`. */
  give: 'origemz.give',
} as const;

/**
 * O plugin que serve o teleporte.
 *
 * NÃO é o mesmo do `origemz.players`: as ações sobre um jogador
 * moram no `OrigemZPlayer`, e a leitura da lista no
 * `OrigemZAgent`. Confundir os dois faria a tela oferecer arrastar
 * o boneco num servidor onde o comando não existe.
 */
export const PLAYER_ACTIONS_PLUGIN = 'OrigemZPlayer';

/** O plugin que serve o `origemz.players`. */
export const PLAYERS_PLUGIN = 'OrigemZAgent';

/** Padrão e teto do `limit`, iguais aos do plugin. */
export const PLAYERS_DEFAULT_LIMIT = 250;
export const PLAYERS_MAX_LIMIT = 500;

/**
 * Posição no mundo.
 *
 * `y` é ALTURA. Ela não entra num mapa 2D — usar `(x, y)` é o erro
 * clássico, e ele funciona até alguém subir num prédio.
 */
export const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export type Position = z.infer<typeof positionSchema>;

/**
 * Um jogador conectado.
 *
 * `steamId` é STRING, nunca número: um SteamID64 tem 17 dígitos e
 * passa de 2^53, ou seja, não sobrevive a um `number` de
 * JavaScript sem perder precisão. O plugin serializa com aspas, e
 * é assim que ele atravessa a API inteira.
 */
export const rustPlayerSchema = z.object({
  steamId: z.string().regex(/^\d{17}$/, 'steamId precisa ser um SteamID64 de 17 dígitos'),
  name: z.string(),
  /** 0 a 100. Float — o Rust não arredonda vida. */
  health: z.number(),
  isAlive: z.boolean(),
  isSleeping: z.boolean(),
  /** Ping em ms. */
  ping: z.number().int(),
  /** Segundos desde a conexão. */
  connectedSeconds: z.number().nonnegative(),
  position: positionSchema,
});

export type RustPlayer = z.infer<typeof rustPlayerSchema>;

/**
 * O envelope de erro, comum a todos os comandos:
 *
 *     {"ok":false,"error":"PLAYER_NOT_FOUND"}
 *
 * `error` é um CÓDIGO, não uma frase para o usuário. O agente o
 * repassa como veio — quem traduz para quem lê é a borda HTTP.
 */
export const pluginErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
});

/** `{"ok":true,"count":143,"offset":0,"limit":250,"players":[…]}` */
export const playersOkSchema = z.object({
  ok: z.literal(true),
  /** O TOTAL de conectados, e não o tamanho desta página. */
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  players: z.array(rustPlayerSchema),
});

export const playersResponseSchema = z.discriminatedUnion('ok', [
  playersOkSchema,
  pluginErrorSchema,
]);

export type PlayersResponse = z.infer<typeof playersResponseSchema>;

/** `origemz.players <offset> <limit>` — os dois sempre enviados. */
export function buildPlayersCommand(params: { offset: number; limit: number }): string {
  return `${PLUGIN_COMMANDS.players} ${String(params.offset)} ${String(params.limit)}`;
}

/**
 * `origemz.player.teleport <steamId> <x> <z> [y]`
 *
 * ####  O `y` É OPCIONAL, E O NORMAL É OMITI-LO  ####
 *
 * Quem arrasta o boneco no mapa escolhe X e Z — altura não existe
 * num mapa 2D. Sem o terceiro número, o PLUGIN resolve a altura
 * pelo terreno (e pela água, quando ela está por cima).
 *
 * Mandar o `y` de onde o jogador estava seria o erro clássico: ele
 * é enterrado dentro da montanha ou largado a duzentos metros do
 * chão — preso num caso, caindo no outro, e queda no Rust tira
 * vida.
 */
export function buildTeleportCommand(params: {
  steamId: string;
  x: number;
  z: number;
  y?: number | undefined;
}): string {
  const base = `${PLUGIN_COMMANDS.teleport} ${params.steamId} ${params.x.toFixed(2)} ${params.z.toFixed(2)}`;

  return params.y === undefined ? base : `${base} ${params.y.toFixed(2)}`;
}

/**
 * `{"ok":true,"steamId":"…","position":{…},"heightAdjusted":true}`
 *
 * A posição que volta é a FINAL, e não a pedida: com a altura
 * resolvida pelo terreno, só o servidor sabe onde o jogador parou.
 */
export const teleportOkSchema = z.object({
  ok: z.literal(true),
  steamId: z.string(),
  position: positionSchema,
  heightAdjusted: z.boolean(),
});

export const teleportResponseSchema = z.discriminatedUnion('ok', [
  teleportOkSchema,
  pluginErrorSchema,
]);

// ------------------------------------------------------------
//  origemz.give — pôr um item na mão de alguém
// ------------------------------------------------------------

/**
 * Onde o item deve parar.
 *
 * `auto` é o padrão de toda entrega do agente (kit, loja, resgate
 * do site): tenta o inventário e larga no chão o que não couber.
 * `inventory` recusa com `INVENTORY_FULL` em vez de largar — é o
 * modo de quem prefere não entregar a ver o item no chão de uma
 * base cheia de gente. `drop` larga direto.
 */
export const GIVE_MODES = ['auto', 'inventory', 'drop'] as const;

export type GiveMode = (typeof GIVE_MODES)[number];

/**
 * O teto por chamada, IGUAL ao `MaxGiveAmount` do plugin.
 *
 * Duplicado de propósito, e não importado: as duas pontas são
 * compiladas separadamente, e o plugin recusa sozinho porque o
 * mesmo comando pode ser digitado no console do servidor. O que
 * este número faz aqui é a recusa acontecer ANTES do RCON, com uma
 * frase em vez de um código.
 */
export const MAX_GIVE_AMOUNT = 100_000;

/**
 * Quantas pilhas uma entrega pode criar (`MaxStackPieces` do
 * plugin).
 *
 * O limite real por chamada é `min(MAX_GIVE_AMOUNT, 100 × pilha
 * máxima do item)`: flecha (pilha 64) para em 6400, AK (pilha 1)
 * para em 100. Quem sabe a pilha máxima é o catálogo, então esta
 * conta é feita na TELA, para avisar antes; o plugin continua
 * sendo quem recusa, com `TOO_MANY_STACKS`.
 */
export const MAX_GIVE_STACK_PIECES = 100;

/**
 * `origemz.give <steamId> <shortname> <amount> <skinId> <mode>`
 *
 * Cinco argumentos posicionais, todos obrigatórios — o plugin
 * responde `INVALID_ARGS` com quatro. Nada aqui é citado entre
 * aspas: `shortname` já vem pela régua de `loadoutItemSchema` (sem
 * espaço nem aspa), e os outros quatro são dígitos ou uma palavra
 * da lista fechada.
 */
export function buildGiveCommand(params: {
  steamId: string;
  shortname: string;
  amount: number;
  skinId: string;
  mode: GiveMode;
}): string {
  return (
    `${PLUGIN_COMMANDS.give} ${params.steamId} ${params.shortname} ` +
    `${String(params.amount)} ${params.skinId} ${params.mode}`
  );
}

/**
 * `{"ok":true,"delivered":"inventory","given":500,"dropped":0}`
 *
 * `delivered` diz ONDE parou, e `mixed` só existe como resultado —
 * nunca como pedido. A invariante do plugin é `given + dropped ==
 * amount`, e é ela que permite a tela dizer "3 no chão" em vez de
 * um sucesso liso que esconde metade da história.
 */
export const giveOkSchema = z.object({
  ok: z.literal(true),
  delivered: z.enum(['inventory', 'drop', 'mixed']),
  given: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
});

export const giveResponseSchema = z.discriminatedUnion('ok', [giveOkSchema, pluginErrorSchema]);

/**
 * O código do plugin vira uma frase que diz o que fazer.
 *
 * ####  "PLAYER_DEAD" NÃO É UMA EXPLICAÇÃO  ####
 *
 * MEDIDO no `server01`: um jogador CONECTADO mas morto faz o
 * `origemz.give` responder `{"ok":false,"error":"PLAYER_DEAD"}`.
 * Ou seja, "está online" não basta — e quem lê precisa saber que
 * basta renascer, em vez de abrir um chamado.
 *
 * O código cru continua no log do agente; o que fica gravado (no
 * claim de um kit, na ficha do jogador) e o que a tela mostra é a
 * frase.
 *
 * Mora aqui, e não em `kits/service.ts` onde nasceu, porque agora
 * três caminhos mandam `origemz.give` — o kit, a loja e a mão do
 * admin — e uma segunda tradução divergiria desta no primeiro
 * código novo do plugin.
 */
export function describeGiveError(code: string): string {
  switch (code) {
    case 'PLAYER_NOT_FOUND':
      return 'o jogador saiu do servidor antes da entrega';
    case 'PLAYER_DEAD':
      return 'o jogador está morto — ele precisa renascer para receber';
    case 'PLAYER_SLEEPING':
      return 'o jogador está dormindo';
    case 'ITEM_NOT_FOUND':
      return 'o jogo não conhece este shortname';
    case 'INVENTORY_FULL':
      return 'o inventário está cheio e não deu para largar no chão';
    case 'DROP_FAILED':
      return 'não deu para largar o item no chão';
    case 'TOO_MANY_STACKS':
      return 'a quantidade pedida daria pilhas demais';
    case 'INVALID_AMOUNT':
      return 'a quantidade está fora da faixa que o jogo aceita';
    default:
      return code;
  }
}

/**
 * A primeira linha da resposta que é um JSON válido.
 *
 * ####  POR QUE NÃO DÁ PARA FAZER PARSE DO TEXTO INTEIRO  ####
 *
 * O que volta do RCON pode ter linhas de log do servidor antes e
 * depois do JSON — um `Puts` de outro plugin, um aviso do Oxide,
 * uma linha de carregamento. `JSON.parse` do bloco todo falharia
 * mesmo com a resposta perfeitamente correta no meio dele.
 *
 * `null` = nenhuma linha era JSON. Quem chama transforma isso em
 * `PLUGIN_INVALID_RESPONSE` — nunca em lista vazia.
 */
export function firstJsonLine(response: string): unknown {
  for (const line of response.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed.startsWith('{')) {
      continue;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      // Linha que começa com `{` e não faz parse é ruído do
      // console, não a resposta. Segue procurando.
      continue;
    }
  }

  return null;
}
