// ============================================================
//  loot-native.ts  -  o loot que o JOGO põe naquela caixa.
//
//  ####  POR QUE O AGENTE PRECISA PERGUNTAR ISTO  ####
//
//  O BetterLoot lê a tabela nativa do jogo UMA vez: quando cria a
//  entrada daquele prefab no `LootTables.json`
//  (BetterLoot.cs:1833-2040, `LoadAllContainers`). Dali em diante
//  o arquivo é a única verdade que ele conhece.
//
//  A consequência aparece no painel de três jeitos, e os três
//  chegaram como reclamação:
//
//    1. caixa que alguém montou só com perfis perdeu a lista de
//       itens do jogo, e ela não volta sozinha nunca;
//    2. caixa marcada como "jogo" não tem como ser adotada com o
//       conteúdo que ela de fato entrega hoje;
//    3. e, em qualquer caixa, não dá para dizer o que é item do
//       jogo e o que alguém acrescentou — a tabela guarda os dois
//       no mesmo dicionário, sem marca nenhuma.
//
//  As três perguntas têm a mesma resposta: a tabela nativa, lida
//  do jogo ao vivo. É o que este módulo busca.
//
//  ####  ELE NÃO ESCREVE NADA  ####
//
//  Leitura pura, e isso é o ponto. A alternativa — apagar a
//  entrada do `LootTables.json` e deixar o plugin regenerá-la no
//  reload — traz os itens do jogo de volta, mas apaga junto tudo
//  o que o admin tinha posto ali, e nunca permite COMPARAR as
//  duas listas. A comparação é o produto.
//
//  ####  O PLUGIN PODE SER VELHO  ####
//
//  `origemz.loot.native` nasceu no OrigemZAgent 0.6.0. Um servidor
//  com o plugin anterior não conhece o comando — e o console do
//  Rust não reclama de comando que não existe, ele simplesmente
//  não responde. Por isso a resposta vazia tem mensagem própria
//  aqui: sem ela, o admin caçaria um defeito que não existe.
// ============================================================

import { z } from 'zod';

import { ApiError } from '../http/error-response.js';
import type { OpsRcon } from '../ops/service.js';
import { firstJsonLine, PLAYERS_PLUGIN as AGENT_PLUGIN } from './plugin-contract.js';

// ------------------------------------------------------------
//  ####  O CONTRATO DO `origemz.loot.native`  ####
//
//  MEDIDO no server01, OrigemZAgent 0.6.0:
//
//      origemz.loot.native <offset> <limit> <prefab>
//
//      {"ok":true,
//       "prefab":"assets/bundled/prefabs/radtown/crate_elite.prefab",
//       "source":"container","slotsMin":8,"slotsMax":8,"scrap":25,
//       "count":145,"offset":0,"limit":500,
//       "items":[{"shortname":"riflebody","min":1,"max":1}],
//       "guaranteed":[]}
//
//  ####  OS NÚMEROS VÊM ANTES DO PREFAB  ####
//
//  Fora de ordem de propósito, e a razão é do outro lado: o
//  caminho do prefab tem ESPAÇO em dezessete casos medidos
//  (`dmloot/dm ammo.prefab`), e o console do Rust quebra argumento
//  no espaço. Com o prefab na frente, nada distinguiria o último
//  pedaço dele de um offset.
//
//  MUDAR QUALQUER COISA AQUI EXIGE MUDAR O PLUGIN JUNTO.
// ------------------------------------------------------------
export const LOOT_NATIVE_COMMAND = 'origemz.loot.native';

/** Padrão e teto do `limit`, iguais aos do plugin. */
export const LOOT_NATIVE_LIMIT = 500;

/**
 * Teto de páginas por caixa.
 *
 * A maior tabela nativa medida tem 211 itens (os cientistas) e o
 * limite é 500 — ou seja, toda caixa que existe hoje fecha na
 * primeira página. As oito existem como rede contra laço infinito,
 * do mesmo jeito que o `MAX_PAGES` do catálogo de itens: se o
 * plugin um dia anunciar um `count` maior do que o que entrega, o
 * laço pediria página para sempre.
 */
const MAX_PAGES = 8;

/**
 * De onde o plugin tirou a tabela.
 *
 * Vai até a tela porque muda o que os números SIGNIFICAM: corpo de
 * cientista não tem scrap, e presente conta TENTATIVAS de abrir, e
 * não itens por caixa.
 */
export const lootNativeSourceSchema = z.enum(['container', 'npc', 'lootfill', 'unwrap']);

export type LootNativeSource = z.infer<typeof lootNativeSourceSchema>;

/**
 * Um item da tabela nativa.
 *
 * O `shortname` é a CHAVE do `LootTables.json`, e não o shortname
 * do catálogo: itens que nascem como projeto vêm com o sufixo
 * `.blueprint` grudado. É por essa chave que o agente casa a
 * tabela com o padrão — casar pelo shortname puro faria
 * `metal.facemask` e `metal.facemask.blueprint` virarem o mesmo
 * item, que é justamente a distinção que o jogo faz.
 */
export const lootNativeItemSchema = z.object({
  shortname: z.string().min(1),
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
});

export type LootNativeItem = z.infer<typeof lootNativeItemSchema>;

export const lootNativeOkSchema = z.object({
  ok: z.literal(true),
  prefab: z.string().min(1),
  source: lootNativeSourceSchema,
  slotsMin: z.number().int().nonnegative(),
  slotsMax: z.number().int().nonnegative(),
  scrap: z.number().int().nonnegative(),
  /** O TOTAL da caixa, e não o tamanho desta página. */
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  items: z.array(lootNativeItemSchema),
  /** Inteiro em toda página — o maior medido tem 6 itens. */
  guaranteed: z.array(lootNativeItemSchema),
});

export const lootNativeResponseSchema = z.discriminatedUnion('ok', [
  lootNativeOkSchema,
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

/** A tabela nativa de uma caixa, inteira. */
export interface LootNativeTable {
  readonly prefab: string;
  readonly source: LootNativeSource;
  readonly slotsMin: number;
  readonly slotsMax: number;
  readonly scrap: number;
  readonly items: readonly LootNativeItem[];
  readonly guaranteed: readonly LootNativeItem[];
}

/**
 * Lê a tabela nativa daquela caixa, do jogo, ao vivo.
 *
 * ####  TUDO-OU-NADA  ####
 *
 * Devolve a tabela completa ou lança — mesma regra do
 * `readAllItems`, e pelo mesmo motivo: meia tabela nativa faria a
 * tela marcar como "acrescentado" item que é do jogo, e o admin
 * apagaria loot original achando que estava limpando o que ele
 * mesmo pôs.
 *
 * Três coisas fecham a conta: o `count` diz o total, o avanço é
 * pelo que CHEGOU (o plugin reduz o `limit` em silêncio, e somar o
 * pedido pularia itens), e no fim o tamanho é comparado com o
 * total anunciado.
 *
 * @throws {ApiError} 502 quando o plugin não responde, responde
 * fora do contrato ou a leitura não fecha; 404 quando o prefab não
 * existe naquele build; 409 quando existe e não é caixa.
 */
export async function readNativeLoot(
  serverId: string,
  rcon: OpsRcon,
  prefab: string,
): Promise<LootNativeTable> {
  const items: LootNativeItem[] = [];
  let offset = 0;
  let head: z.infer<typeof lootNativeOkSchema> | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const raw = await rcon.send(
      `${LOOT_NATIVE_COMMAND} ${String(offset)} ${String(LOOT_NATIVE_LIMIT)} ${prefab}`,
    );
    const parsed = lootNativeResponseSchema.safeParse(firstJsonLine(raw));

    if (!parsed.success) {
      // Resposta vazia é o sintoma de comando inexistente: o
      // console do Rust não reclama de um comando que não conhece,
      // ele apenas não responde. Ver o cabeçalho.
      throw new ApiError(
        'PLUGIN_INVALID_RESPONSE',
        raw.trim() === ''
          ? `O ${AGENT_PLUGIN} não respondeu ao ${LOOT_NATIVE_COMMAND} em "${serverId}". Esse ` +
              'comando nasceu na versão 0.6.0 do plugin — o servidor provavelmente está com uma ' +
              'anterior. Atualize o plugin e tente de novo; nada foi alterado.'
          : `O ${AGENT_PLUGIN} respondeu ao ${LOOT_NATIVE_COMMAND} fora do contrato: ${raw
              .trim()
              .slice(0, 300)}`,
        502,
      );
    }

    if (!parsed.data.ok) {
      throw errorOf(parsed.data.error, serverId, prefab);
    }

    head = parsed.data;

    // Página vazia com ok:true é como o plugin diz que acabou.
    if (parsed.data.items.length === 0) {
      break;
    }

    items.push(...parsed.data.items);

    // Avança pelo que CHEGOU, nunca pelo que foi pedido.
    offset += parsed.data.items.length;

    if (items.length >= parsed.data.count) {
      break;
    }
  }

  if (head === null || items.length !== head.count) {
    throw new ApiError(
      'LOOT_NATIVE_INCOMPLETE',
      `A leitura do loot do jogo para "${prefab}" não fechou: o plugin anunciou ` +
        `${head === null ? '?' : String(head.count)} itens e chegaram ${String(items.length)}. ` +
        'Nada foi alterado — meia tabela faria a tela marcar item do jogo como acrescentado.',
      502,
    );
  }

  return {
    prefab: head.prefab,
    source: head.source,
    slotsMin: head.slotsMin,
    slotsMax: head.slotsMax,
    scrap: head.scrap,
    items,
    guaranteed: head.guaranteed,
  };
}

/**
 * Traduz o código do plugin para a resposta da API.
 *
 * Os dois casos do prefab não são 502: o plugin funcionou e
 * respondeu certo — quem errou foi a pergunta. Devolvê-los como
 * "erro do plugin" mandaria o admin olhar o servidor quando o
 * problema está no caminho que ele digitou (ou num prefab que o
 * update do jogo levou embora).
 */
function errorOf(code: string, serverId: string, prefab: string): ApiError {
  if (code === 'PREFAB_NOT_FOUND') {
    return new ApiError(
      'PREFAB_NOT_FOUND',
      `O jogo de "${serverId}" não conhece o prefab "${prefab}". Se ele está no arquivo do ` +
        'BetterLoot, é resto de uma versão anterior do Rust — o update levou a caixa embora.',
      404,
    );
  }

  if (code === 'PREFAB_NOT_LOOT') {
    return new ApiError(
      'PREFAB_NOT_LOOT',
      `"${prefab}" existe no jogo, mas não é caixa nem corpo: não há loot padrão para ler.`,
      409,
    );
  }

  return new ApiError(
    'PLUGIN_ERROR',
    `O ${AGENT_PLUGIN} recusou o ${LOOT_NATIVE_COMMAND} para "${prefab}": ${code}.`,
    502,
  );
}
