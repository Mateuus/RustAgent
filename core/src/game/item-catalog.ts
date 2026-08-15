// ============================================================
//  item-catalog.ts  -  o catálogo de itens, lido do jogo e
//  guardado no agente.
//
//  ####  A LISTA PRECISA RESPONDER COM O SERVIDOR DESLIGADO  ####
//
//  É essa a razão de este módulo existir. `origemz.items` só
//  responde com um servidor no ar, e montar um kit ou uma entrega
//  é o tipo de trabalho que se faz de madrugada, com tudo parado.
//  A tabela `items` é o que separa "onde os itens estão" de
//  "quando dá para perguntar por eles".
//
//  Quem guarda é db/items-repository.ts. Aqui mora a decisão de
//  QUANDO reler, e a regra de tudo-ou-nada.
//
//  ------------------------------------------------------------
//  ####  A INVALIDAÇÃO É POR PROTOCOLO, E NÃO POR TTL  ####
//
//  Catálogo de item não envelhece com o tempo: ele muda quando o
//  JOGO muda, e só então. Um TTL de dez minutos refaria o trabalho
//  144 vezes por dia para descobrir 143 vezes que nada mudou — e
//  ainda ficaria dez minutos errado depois de um update.
//
//  O `serverinfo` devolve `Protocol` (`"2632.287.1"` hoje, MEDIDO
//  no server01), que é a versão do protocolo do jogo. Guardado
//  junto do catálogo, ele dá resposta EXATA a "preciso refazer?".
//
//  E o gatilho vem de graça: quando a Facepunch publica um update,
//  o servidor reinicia, o RCON cai e reconecta — `onRconConnected`,
//  o mesmo lugar em que a lista de banidos reconcilia e a presença
//  é conferida.
//
//  ------------------------------------------------------------
//  ####  A RODADA É TUDO OU NADA  ####
//
//  Falhou no meio (RCON caiu, resposta truncada, plugin fora do
//  contrato, total que não bate), a rodada inteira é DESCARTADA e
//  o catálogo anterior fica de pé.
//
//  Um catálogo pela metade é pior que um catálogo velho: o kit que
//  usa o item faltante quebraria sem motivo aparente, e o defeito
//  apareceria semanas depois, longe daqui. A resposta paginada tem
//  `count`, e é com ele que se sabe se chegou tudo.
//
//  ####  ELE TAMBÉM NUNCA APAGA  ####
//
//  Item que sumiu do jogo continua na tabela, marcado. Ver o
//  cabeçalho da migração 007 para o porquê.
// ============================================================

import { z } from 'zod';

import type { ItemInput, ItemScanResult, ItemsRepository } from '../db/items-repository.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';
// O `origemz.items` é servido pelo MESMO plugin do
// `origemz.players` — ver game/plugin-contract.ts, onde a
// constante nasceu com o nome daquele comando.
import { firstJsonLine, PLAYERS_PLUGIN as AGENT_PLUGIN } from './plugin-contract.js';

// ------------------------------------------------------------
//  ####  O CONTRATO DO `origemz.items`  ####
//
//  MEDIDO no server01:
//
//      origemz.items [offset] [limit]
//
//      {"ok":true,"count":1252,"offset":0,"limit":250,"items":[
//        {"shortname":"hat.wolf","displayName":"Wolf Headdress",
//         "itemId":-1478212975,"category":"Attire","maxStack":1,
//         "hasCondition":false}, …]}
//
//  `count` é o TOTAL do catálogo, e não o tamanho da página;
//  `offset` e `limit` voltam JÁ NORMALIZADOS, então quem pede 5000
//  recebe 500 e VÊ isso na resposta em vez de achar que o resto
//  sumiu. Offset além do fim devolve `items` vazio com `ok:true`,
//  que é como o agente sabe que acabou.
//
//  Ele mora aqui, e não em game/plugin-contract.ts, porque é usado
//  só por este módulo — e porque aquele arquivo é editado pelas
//  duas frentes que estão trabalhando em paralelo.
//
//  MUDAR QUALQUER COISA AQUI EXIGE MUDAR O PLUGIN JUNTO.
// ------------------------------------------------------------
export const ITEMS_COMMAND = 'origemz.items';

/** Padrão e teto do `limit`, iguais aos do plugin. */
export const ITEMS_DEFAULT_LIMIT = 250;
export const ITEMS_MAX_LIMIT = 500;

export const rustItemSchema = z.object({
  shortname: z.string().min(1),
  displayName: z.string(),
  /**
   * O id numérico do jogo. Pode ser NEGATIVO — `hat.wolf` é
   * `-1478212975`, MEDIDO. Um `.positive()` aqui recusaria metade
   * do catálogo.
   */
  itemId: z.number().int(),
  category: z.string(),
  maxStack: z.number().int(),
  hasCondition: z.boolean(),
});

export const itemsOkSchema = z.object({
  ok: z.literal(true),
  /** O TOTAL do catálogo, e não o tamanho desta página. */
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  items: z.array(rustItemSchema),
});

export const itemsResponseSchema = z.discriminatedUnion('ok', [
  itemsOkSchema,
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

/**
 * Teto de páginas por rodada.
 *
 * Com 250 por página são 10.000 itens, muito acima dos ~1250 de
 * hoje. É rede de segurança contra laço infinito: se o plugin um
 * dia devolver um `count` maior do que a quantidade que realmente
 * entrega, o laço pediria página para sempre.
 */
const MAX_PAGES = 40;

/**
 * O que o catálogo precisa saber dos servidores. E nada além.
 *
 * Interface mínima, e de propósito: quem a satisfaz em produção é
 * o `ServerSupervisor`, e um teste a satisfaz com um objeto
 * literal. Mesma escolha do `PresenceServers`.
 */
export interface ItemCatalogServers {
  ids(): readonly string[];
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

export interface ItemCatalogDeps {
  readonly repository: ItemsRepository;
  readonly servers: ItemCatalogServers;
  readonly logger: Logger;
}

/** O desfecho de uma conferência. */
export type ItemCatalogSyncResult =
  /** Nem dava para perguntar. Não é erro — ver `sync`. */
  | { readonly status: 'skipped'; readonly reason: string }
  /** O protocolo bate: nada a fazer. */
  | {
      readonly status: 'fresh';
      readonly serverId: string;
      readonly protocol: string | null;
      readonly total: number;
    }
  /** A rodada aconteceu inteira e foi aplicada. */
  | { readonly status: 'updated'; readonly serverId: string; readonly scan: ItemScanResult }
  /** A rodada foi descartada. O catálogo anterior continua de pé. */
  | { readonly status: 'failed'; readonly reason: string };

export class ItemCatalog {
  readonly #deps: ItemCatalogDeps;

  /**
   * A rodada em voo, se houver.
   *
   * Duas reconexões de RCON em sequência rápida (dois servidores
   * subindo juntos) disparariam duas leituras completas ao mesmo
   * tempo — dez idas ao RCON para montar o mesmo catálogo, e as
   * duas gravando por cima uma da outra. Uma só, compartilhada.
   */
  #inFlight: Promise<ItemCatalogSyncResult> | null = null;

  constructor(deps: ItemCatalogDeps) {
    this.#deps = deps;
  }

  /**
   * Confere o catálogo contra aquele servidor e o refaz se preciso.
   *
   * NUNCA lança: quem chama é o gancho de reconexão do RCON, onde
   * uma exceção subiria por um caminho que ninguém trata. O que
   * deu errado sai no resultado e no log.
   *
   * Servidor parado devolve `skipped`, e isso não é erro: é o
   * estado normal de metade da lista. O que não pode é agir mesmo
   * assim.
   */
  async sync(serverId: string): Promise<ItemCatalogSyncResult> {
    const pending = this.#inFlight;

    if (pending !== null) {
      return pending;
    }

    const started = this.#sync(serverId).finally(() => {
      this.#inFlight = null;
    });

    this.#inFlight = started;

    return started;
  }

  /**
   * Algum servidor está no ar para conferir o catálogo?
   *
   * É o que separa, na resposta da API, "esta lista está sendo
   * mantida em dia com o jogo" de "esta lista é a última que o
   * agente conseguiu ler". A tela precisa dizer qual das duas —
   * mostrar 1252 itens sem avisar que eles são de três versões
   * atrás é uma tela que mente.
   */
  get isServerOnline(): boolean {
    return this.#firstOnline() !== null;
  }

  /**
   * Refaz o catálogo AGORA, custe o que custar.
   *
   * É o que o botão *Atualizar agora* chama. Ao contrário do
   * `sync`, ele LANÇA: quem clicou está olhando, e a diferença
   * entre "não havia servidor no ar" e "o plugin recusou" é
   * exatamente o que a tela precisa dizer.
   *
   * @throws {ApiError} 409 sem nenhum servidor no ar; 502 quando o
   * plugin responde fora do contrato.
   */
  async refresh(): Promise<ItemScanResult> {
    const online = this.#firstOnline();

    if (online === null) {
      throw new ApiError(
        'NO_SERVER_ONLINE',
        'Nenhum servidor está no ar para perguntar quais itens existem. O catálogo é lido do ' +
          `jogo (${ITEMS_COMMAND}, do plugin ${AGENT_PLUGIN}) e se atualiza sozinho quando um ` +
          'servidor sobe — a lista continua respondendo enquanto isso.',
        409,
      );
    }

    return this.#read(online.serverId, online.rcon, true);
  }

  async #sync(serverId: string): Promise<ItemCatalogSyncResult> {
    const context = this.#deps.servers.contextOf(serverId);

    if (context === null) {
      return {
        status: 'skipped',
        reason: `O agente não está cuidando do servidor "${serverId}".`,
      };
    }

    if (!context.rcon.isConnected) {
      return {
        status: 'skipped',
        reason:
          `O RCON de "${serverId}" está fora do ar. O catálogo será conferido quando ele voltar.`,
      };
    }

    try {
      if (await this.#isFresh(context.rcon)) {
        const state = this.#deps.repository.state();

        return { status: 'fresh', serverId, protocol: state.protocol, total: state.total };
      }

      return { status: 'updated', serverId, scan: await this.#read(serverId, context.rcon, true) };
    } catch (error) {
      // Ver o cabeçalho: a rodada inteira é descartada, e o
      // catálogo anterior continua de pé. Um catálogo pela metade
      // quebraria kits sem motivo aparente.
      this.#deps.logger.warn(
        { server: serverId, err: toError(error) },
        'a leitura do catálogo de itens falhou; a rodada foi descartada e o catálogo anterior ' +
          'continua valendo',
      );

      return { status: 'failed', reason: toError(error).message };
    }
  }

  /**
   * O catálogo guardado ainda vale?
   *
   * Protocolo DESCONHECIDO responde `false` de propósito: sem ele
   * não dá para AFIRMAR que a cópia guardada continua valendo, e o
   * lado certo de errar é reler. Custa pouco — isto roda na
   * reconexão do RCON, e não a cada requisição.
   */
  async #isFresh(rcon: OpsRcon): Promise<boolean> {
    const protocol = await readGameProtocol(rcon);

    if (protocol === null) {
      return false;
    }

    const state = this.#deps.repository.state();

    return state.total > 0 && state.protocol === protocol;
  }

  /**
   * Lê o catálogo daquele servidor e o aplica.
   *
   * @throws {ApiError} quando a leitura não fecha. A rodada some
   * inteira — nada é gravado.
   */
  async #read(serverId: string, rcon: OpsRcon, announce: boolean): Promise<ItemScanResult> {
    const protocol = await readGameProtocol(rcon);
    const before = this.#deps.repository.state();

    if (announce && before.total > 0 && before.protocol !== protocol) {
      this.#deps.logger.info(
        { server: serverId, from: before.protocol, to: protocol },
        'o protocolo do jogo mudou; relendo o catálogo de itens',
      );
    }

    // A leitura inteira acontece ANTES de qualquer escrita: é o que
    // faz a rodada ser tudo-ou-nada. Uma falha no meio sai por aqui
    // sem ter tocado no banco.
    const items = await readAllItems(serverId, rcon);
    const scan = this.#deps.repository.replace({ items, protocol });

    this.#deps.logger.info(
      { server: serverId, protocol, present: scan.present, added: scan.added, removed: scan.removed },
      'catálogo de itens atualizado',
    );

    return scan;
  }

  /** O primeiro servidor com RCON de pé, se houver algum. */
  #firstOnline(): { readonly serverId: string; readonly rcon: OpsRcon } | null {
    for (const serverId of this.#deps.servers.ids()) {
      const context = this.#deps.servers.contextOf(serverId);

      if (context !== null && context.rcon.isConnected) {
        return { serverId, rcon: context.rcon };
      }
    }

    return null;
  }
}

/**
 * O `Protocol` do `serverinfo`.
 *
 * ####  O `serverinfo` NÃO RESPONDE NUMA LINHA SÓ  ####
 *
 * MEDIDO no server01: ele devolve o JSON INDENTADO, em vinte
 * linhas. É o contrário do que os plugins deste projeto fazem — e
 * por isso o `firstJsonLine`, que existe para eles, não serve
 * aqui: nenhuma linha do bloco é um JSON completo.
 *
 * O sintoma de errar isto é silencioso e caro: o protocolo vem
 * `null`, o agente conclui que não dá para afirmar que o catálogo
 * vale, e relê os ~1250 itens a CADA reconexão de RCON — a
 * invalidação por protocolo deixa de existir sem nada reclamar.
 *
 * `null` quando a resposta não deu para ler continua não sendo
 * fatal: quem chama trata "não sei em que versão o jogo está" como
 * motivo para reler, que é o lado certo de errar.
 */
export async function readGameProtocol(rcon: OpsRcon): Promise<string | null> {
  let raw: string;

  try {
    raw = await rcon.send('serverinfo');
  } catch {
    return null;
  }

  const parsed = parseJsonBlock(raw) ?? firstJsonLine(raw);

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const protocol = (parsed as { readonly Protocol?: unknown }).Protocol;

  return typeof protocol === 'string' && protocol !== '' ? protocol : null;
}

/**
 * O primeiro objeto JSON do texto, mesmo que ele ocupe N linhas.
 *
 * Recorta do primeiro `{` ao último `}` — o que tolera as linhas
 * de log que o console imprime antes e depois da resposta, que é o
 * mesmo motivo de o `firstJsonLine` existir.
 *
 * `null` quando não há um objeto legível ali.
 */
function parseJsonBlock(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');

  if (start < 0 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * O catálogo INTEIRO, página por página.
 *
 * ####  O QUE FAZ ESTA FUNÇÃO SER TUDO-OU-NADA  ####
 *
 * Ela devolve a lista completa ou lança. Não existe caminho em que
 * ela entregue meia lista, e é isso que permite ao chamador gravar
 * sem conferir mais nada.
 *
 * Três coisas fecham a conta: o `count` da resposta diz o total, o
 * avanço é pelo que CHEGOU (o plugin reduz o `limit` em silêncio, e
 * somar o pedido pularia itens), e no fim o tamanho é comparado com
 * o total anunciado.
 *
 * @throws {ApiError} 502 em qualquer desses caminhos.
 */
export async function readAllItems(serverId: string, rcon: OpsRcon): Promise<readonly ItemInput[]> {
  const items: ItemInput[] = [];
  let offset = 0;
  let total: number | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const raw = await rcon.send(`${ITEMS_COMMAND} ${String(offset)} ${String(ITEMS_DEFAULT_LIMIT)}`);
    const parsed = itemsResponseSchema.safeParse(firstJsonLine(raw));

    if (!parsed.success) {
      // Resposta vazia é o sintoma de comando inexistente: o
      // console do Rust não reclama de um comando que não conhece,
      // ele apenas não responde. Dizer isso poupa a caça a um
      // defeito que não existe.
      throw new ApiError(
        'PLUGIN_INVALID_RESPONSE',
        raw.trim() === ''
          ? `O ${AGENT_PLUGIN} não respondeu ao ${ITEMS_COMMAND} em "${serverId}". Ele está ` +
              'ligado neste servidor? A lista de itens vem desse plugin — não existe comando ' +
              'nativo do Rust que liste as definições de item.'
          : `O ${AGENT_PLUGIN} respondeu ao ${ITEMS_COMMAND} fora do contrato: ${raw
              .trim()
              .slice(0, 300)}`,
        502,
      );
    }

    if (!parsed.data.ok) {
      throw new ApiError(
        'PLUGIN_ERROR',
        `O ${AGENT_PLUGIN} recusou o ${ITEMS_COMMAND}: ${parsed.data.error}.`,
        502,
      );
    }

    total = parsed.data.count;

    // Página vazia com ok:true é como o plugin diz que acabou.
    if (parsed.data.items.length === 0) {
      break;
    }

    items.push(...parsed.data.items);

    // Avança pelo que CHEGOU, nunca pelo que foi pedido — ver o
    // cabeçalho.
    offset += parsed.data.items.length;

    if (items.length >= parsed.data.count) {
      break;
    }
  }

  if (total === null || items.length !== total) {
    throw new ApiError(
      'ITEM_CATALOG_INCOMPLETE',
      `A leitura do catálogo de "${serverId}" não fechou: o plugin anunciou ` +
        `${total === null ? '?' : String(total)} itens e chegaram ${String(items.length)}. ` +
        'A rodada foi descartada inteira — meio catálogo é pior que um catálogo velho, porque ' +
        'um kit que usasse o item faltante quebraria sem motivo aparente.',
      502,
    );
  }

  if (items.length === 0) {
    throw new ApiError(
      'ITEM_CATALOG_EMPTY',
      `O ${AGENT_PLUGIN} respondeu que "${serverId}" não tem item nenhum. Isso não acontece num ` +
        'servidor de Rust: é o sintoma de uma leitura que deu errado do outro lado, e gravá-la ' +
        'marcaria o catálogo inteiro como removido.',
      502,
    );
  }

  return items;
}
