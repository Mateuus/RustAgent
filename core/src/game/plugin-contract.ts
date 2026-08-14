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
