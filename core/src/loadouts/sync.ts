// ============================================================
//  sync.ts  -  leva os LOADOUTS até o jogo.
//
//  Mesmo desenho do `origemz.vip.sync`, e vale dizer no que ele
//  DIFERE — é o que justifica um arquivo separado:
//
//   - o dado é CONFIGURAÇÃO, não estado de jogador. Ele muda quando
//     alguém edita um loadout, e não quando alguém compra VIP;
//   - o tamanho é limitado pelo NÚMERO DE GRUPOS, não pelo de
//     jogadores.
//
//  O que é IGUAL, e de propósito: o payload é o estado COMPLETO
//  (grupo que sumiu fica sem kit — é assim que "apaguei o loadout"
//  chega ao jogo), viaja em base64, e a (re)conexão do RCON manda
//  tudo de novo, porque recarregar o plugin ESVAZIA o cache dele.
//
//  ------------------------------------------------------------
//  ####  A CHAVE DO PAYLOAD, E A DECISÃO QUE ELA EXIGE  ####
//
//  MEDIDO, lendo os dois plugins: quem consome o kit é o
//  `OrigemZPlayer`, e ele pergunta ao hub por NÍVEL, não por grupo
//  — o `ResolveTier` dele devolve `admin` (pelo authLevel do Rust),
//  o tier do VIP (`gold`, `silver`, `bronze`) ou `normal`, e é essa
//  string que vai para o `GetLoadout`.
//
//  Só que o loadout deste agente é POR GRUPO DO OXIDE: é o que o
//  briefing pede ("criou um novo grupo, aparece o loadout") e é o
//  que permite dar kit a um grupo de evento que não é nível de VIP
//  nenhum.
//
//  A saída é mandar as DUAS chaves para o mesmo conteúdo:
//
//      "origemz.vip.gold"  o nome do grupo — a identidade do
//                          loadout no agente, e o que se procura ao
//                          depurar no console;
//      "gold"              o apelido do nível, quando o
//                          `OrigemZVip.json` daquele servidor diz
//                          que aquele grupo É aquele nível.
//
//  Mandar só a primeira faria o kit nunca chegar ao jogador (o
//  consumidor pergunta por `gold` e o cache não teria essa chave);
//  mandar só a segunda perderia todo grupo que não é nível de VIP.
//  O custo de mandar as duas é duplicar o kit no payload, e o teto
//  de bytes continua valendo por cima disso.
//
//  ####  E O `default` VIRA `normal`  ####
//
//  Esse par não sai de config nenhum: é a única correspondência
//  fixa, e ela existe porque os dois lados nomeiam a mesma coisa —
//  `default` é o grupo em que o Oxide põe todo mundo, e `normal` é
//  como o `OrigemZPlayer` chama quem não é VIP nem admin. Sem ela,
//  configurar o kit do `default` não teria efeito nenhum no jogo, e
//  ninguém saberia por quê.
//
//  O `admin` não precisa de apelido: o Oxide já tem um grupo com
//  esse nome, e o cache do plugin compara sem diferenciar
//  maiúsculas.
// ============================================================

import type { LoadoutRecord, LoadoutsRepository } from '../db/loadouts-repository.js';
import { pushState, type PushOutcome } from '../game/plugin-push.js';
import type { Logger } from '../logger.js';
import { disconnectedRcon, type OpsRcon } from '../ops/service.js';
import { readVipTiers, type VipTierLevel } from '../vip/tiers.js';
import type { LoadoutItem } from './items.js';

/** O comando que leva os kits ao `OrigemZAgent`. */
export const LOADOUT_SYNC_COMMAND = 'origemz.loadout.sync';

/** O grupo de todo mundo, e o nível de quem não é VIP. Ver o cabeçalho. */
export const DEFAULT_GROUP = 'default';
export const NORMAL_TIER = 'normal';

/** O que a sincronização precisa saber dos servidores. */
export interface LoadoutServers {
  ids(): readonly string[];
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
  configOf(id: string): { readonly paths: { readonly oxideConfigDir: string } } | null;
}

export interface LoadoutSyncDeps {
  readonly repository: LoadoutsRepository;
  readonly servers: LoadoutServers;
  readonly logger: Logger;
}

export interface LoadoutSyncResult {
  readonly serverId: string;
  /** Quantas CHAVES foram (grupos + apelidos). */
  readonly tiers: number;
  /** Quantos itens, somando tudo. */
  readonly items: number;
  /** Quantas o plugin guardou. Menor que `tiers` = ele descartou. */
  readonly cachedTiers: number;
  readonly cachedItems: number;
  /** `null` = o envio aconteceu. Ver `VipSyncResult.skipped`. */
  readonly skipped: string | null;
}

/** O payload, no formato do `LoadoutSyncPayload` do plugin. */
export interface LoadoutSyncPayload {
  readonly tiers: Record<string, readonly LoadoutItem[]>;
}

/**
 * Monta o payload a partir dos loadouts e dos níveis daquele
 * servidor.
 *
 * Pura e exportada porque é a regra que o teste do briefing cobre:
 * "apagar um loadout faz o grupo sumir do JSON empurrado". Ela não
 * fala com o banco nem com o RCON — recebe o que já foi lido.
 */
export function buildLoadoutPayload(
  loadouts: readonly LoadoutRecord[],
  levels: readonly VipTierLevel[],
): LoadoutSyncPayload {
  const tiers: Record<string, readonly LoadoutItem[]> = {};

  // Os grupos primeiro: eles são a identidade do loadout, e é o
  // nome deles que não pode ser sobrescrito por apelido nenhum.
  for (const loadout of loadouts) {
    if (loadout.items.length === 0) {
      continue;
    }

    tiers[loadout.groupName] = loadout.items;
  }

  const aliasOf = new Map<string, string>(
    levels.map((level) => [level.group.toLowerCase(), level.tier]),
  );

  aliasOf.set(DEFAULT_GROUP, NORMAL_TIER);

  for (const loadout of loadouts) {
    if (loadout.items.length === 0) {
      continue;
    }

    const alias = aliasOf.get(loadout.groupName.toLowerCase());

    // O apelido NÃO sobrescreve uma chave que veio de um grupo de
    // verdade: se existe um grupo chamado `normal` com kit próprio,
    // é o kit dele que vale — o apelido do `default` não pode
    // roubar o lugar de um grupo que alguém criou.
    if (alias !== undefined && tiers[alias] === undefined) {
      tiers[alias] = loadout.items;
    }
  }

  return { tiers };
}

export class LoadoutSync {
  readonly #deps: LoadoutSyncDeps;

  constructor(deps: LoadoutSyncDeps) {
    this.#deps = deps;
  }

  /**
   * Empurra o estado completo daquele servidor.
   *
   * NUNCA lança: quem grava um loadout não tem o que fazer com uma
   * exceção vinda de um servidor que estava reiniciando, e a linha
   * já está no banco. O desfecho vai na resposta, e a tela o
   * mostra.
   */
  async push(serverId: string, trigger: string): Promise<LoadoutSyncResult> {
    const loadouts = this.#deps.repository.enabled(serverId);
    const levels = await this.#levelsOf(serverId);
    const payload = buildLoadoutPayload(loadouts, levels);

    const tiers = Object.keys(payload.tiers).length;
    const items = Object.values(payload.tiers).reduce((sum, list) => sum + list.length, 0);

    const outcome = await pushState({
      rcon: this.#deps.servers.contextOf(serverId)?.rcon ?? disconnectedRcon(serverId),
      command: LOADOUT_SYNC_COMMAND,
      payload,
      logger: this.#deps.logger,
      trigger,
    });

    if (outcome.status !== 'sent') {
      return {
        serverId,
        tiers,
        items,
        cachedTiers: 0,
        cachedItems: 0,
        skipped: describe(serverId, outcome),
      };
    }

    const cachedTiers = Number(outcome.response.tiers ?? 0);
    const cachedItems = Number(outcome.response.items ?? 0);

    // Menos no cache do que o enviado significa que o plugin
    // DESCARTOU alguma coisa (slot desconhecido, shortname vazio).
    // É a única forma de perceber que estamos mandando algo que o
    // outro lado não aceita — e kit que não chega é kit que o
    // jogador não recebe.
    if (cachedItems < items) {
      this.#deps.logger.warn(
        { server: serverId, sentItems: items, cachedItems },
        'o plugin descartou itens do loadout; confira os shortnames e os slots',
      );
    }

    this.#deps.logger.info(
      { server: serverId, tiers, items, cachedTiers, cachedItems, trigger },
      'loadouts empurrados ao plugin',
    );

    return { serverId, tiers, items, cachedTiers, cachedItems, skipped: null };
  }

  /**
   * Todos os servidores. É o que roda no boot.
   *
   * Um servidor que falha não segura os outros: o motivo dele já
   * vai no `skipped` do resultado.
   */
  async pushAll(trigger: string): Promise<readonly LoadoutSyncResult[]> {
    const results: LoadoutSyncResult[] = [];

    for (const serverId of this.#deps.servers.ids()) {
      results.push(await this.push(serverId, trigger));
    }

    return results;
  }

  async #levelsOf(serverId: string): Promise<readonly VipTierLevel[]> {
    const config = this.#deps.servers.configOf(serverId);

    if (config === null) {
      return [];
    }

    return (await readVipTiers(config.paths.oxideConfigDir)).levels;
  }
}

/** O desfecho de um push vira a frase que a tela mostra. */
function describe(serverId: string, outcome: PushOutcome): string {
  switch (outcome.status) {
    case 'skipped':
      return `"${serverId}": ${outcome.reason}`;
    case 'refused':
      return (
        `Os loadouts de "${serverId}" não couberam num comando de console ` +
        `(${String(outcome.bytes)} bytes, teto de ${String(outcome.limitBytes)}). NADA foi ` +
        'enviado, e o servidor continua com os kits anteriores: meio payload faria o plugin ' +
        'trocar um cache íntegro por um incompleto, e jogadores nasceriam sem parte do kit. ' +
        'Tire itens de algum loadout, ou desligue os que não estão em uso.'
      );
    case 'failed':
      return `Não consegui empurrar os loadouts para "${serverId}": ${outcome.error.message}`;
    default:
      return `"${serverId}" respondeu de um jeito que não reconheço.`;
  }
}
