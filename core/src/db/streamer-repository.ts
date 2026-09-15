// ============================================================
//  streamer-repository.ts  -  quem é streamer, e o que some da
//  tela dele.
//
//  Uma tabela só (`player_streamer`, migração 087), e a ausência
//  de linha é o padrão: não liberado, não ativo. Quem inventa o
//  perfil vazio é `defaultStreamerProfile`, em types/streamer.ts —
//  aqui só entra e sai linha.
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO NÃO FALA COM O JOGO  ####
//
//  Empurrar `origemz.streamer.config` é trabalho de
//  game/streamer-sync.ts, e decidir se o jogador pode ligar o modo
//  é de streamer/service.ts. A separação é a mesma do
//  `spawn-status-repository.ts`, e serve à mesma coisa: as regras
//  que importam ("um jogador sem liberação não liga o modo",
//  "desligar não apaga o que o admin escolheu esconder") são
//  testáveis com um banco em memória, sem servidor de Rust nenhum.
//
//  ####  O steamId É STRING, SEMPRE  ####
//
//  17 dígitos passam de 2^53. Ver o cabeçalho de
//  players-repository.ts: convertido para número, ele volta
//  arredondado — e o modo seria ligado para OUTRA PESSOA, sem erro
//  nenhum no caminho.
// ============================================================

import type { AgentDatabase } from './database.js';
import { defaultStreamerProfile, type StreamerProfile } from '../types/streamer.js';

/** A linha crua, com os booleanos do SQLite ainda como 0 e 1. */
interface StreamerRow {
  readonly steam_id: string;
  readonly allowed: number;
  readonly active: number;
  readonly hide_logo: number;
  readonly hide_ads: number;
  readonly hide_messages: number;
  readonly activated_at: number | null;
  readonly granted_by: string | null;
  readonly updated_at: number;
}

/**
 * O que se pode gravar. Tudo opcional: a tela salva uma chave sem
 * reenviar as outras, e o serviço grava `active` sem tocar no
 * resto.
 */
export interface StreamerWrite {
  readonly allowed?: boolean;
  readonly active?: boolean;
  readonly hideLogo?: boolean;
  readonly hideAds?: boolean;
  readonly hideMessages?: boolean;
  readonly grantedBy?: string | null;
}

const COLUMNS = `steam_id, allowed, active, hide_logo, hide_ads, hide_messages,
                 activated_at, granted_by, updated_at`;

export class StreamerRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  /**
   * O perfil de um jogador — o dele, ou o padrão.
   *
   * NUNCA devolve `null`, e isso é deliberado: "este jogador não
   * tem linha" e "este jogador não é streamer" são a mesma coisa
   * para todo mundo que chama, e devolver `null` faria cada um
   * deles inventar o mesmo objeto vazio.
   */
  get(steamId: string): StreamerProfile {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM player_streamer WHERE steam_id = ?`)
      .get(steamId) as StreamerRow | undefined;

    return row === undefined ? defaultStreamerProfile(steamId) : toProfile(row);
  }

  /**
   * Todos os LIBERADOS, ativos ou não.
   *
   * É o que desce aos plugins: o overlay precisa saber quem está
   * escondendo agora, e o comando `/streamer` precisa saber quem
   * tem direito de ligar. Ver types/streamer-transport.ts.
   *
   * Ordenado pelo SteamID para a carga ser ESTÁVEL: sem ordem, duas
   * leituras iguais podem gerar dois JSONs diferentes, e o
   * `streamer-sync` perde a capacidade de não reenviar o que não
   * mudou.
   */
  allowed(): readonly StreamerProfile[] {
    const rows = this.#db
      .prepare(`SELECT ${COLUMNS} FROM player_streamer WHERE allowed = 1 ORDER BY steam_id`)
      .all() as StreamerRow[];

    return rows.map(toProfile);
  }

  /**
   * Quem está com o modo LIGADO neste instante.
   *
   * Usada pelo chat, a cada broadcast: a lista é pequena (streamers
   * em live), e o índice da migração 087 cobre o filtro.
   */
  active(): readonly StreamerProfile[] {
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM player_streamer
          WHERE allowed = 1 AND active = 1
          ORDER BY steam_id`,
      )
      .all() as StreamerRow[];

    return rows.map(toProfile);
  }

  /**
   * Grava o que veio e devolve como o perfil ficou.
   *
   * ####  ELE FAZ UPSERT, E O QUE NÃO VEIO NÃO É TOCADO  ####
   *
   * O `COALESCE(@campo, coluna)` do `DO UPDATE` é o que permite
   * "o jogador ligou o modo" não apagar as três escolhas do admin,
   * e "o admin desmarcou a logo" não desligar a live de quem está
   * no ar.
   *
   * Na INSERÇÃO, o que não veio cai no padrão da tabela — que é o
   * mesmo do `defaultStreamerProfile`. As duas metades precisam
   * concordar, e por isso a migração 087 traz os três `hide_*`
   * nascendo em 1.
   *
   * ####  `activated_at` SÓ ANDA PARA FRENTE  ####
   *
   * Ele marca quando o modo foi LIGADO, e por isso só é reescrito
   * quando `active` chega verdadeiro. Desligar preserva o valor: a
   * pergunta que ele responde ("desde quando ele está em live?")
   * continua tendo resposta depois que a live acaba.
   */
  save(steamId: string, write: StreamerWrite, now: number = Date.now()): StreamerProfile {
    const params = {
      steam_id: steamId,
      allowed: toFlag(write.allowed),
      active: toFlag(write.active),
      hide_logo: toFlag(write.hideLogo),
      hide_ads: toFlag(write.hideAds),
      hide_messages: toFlag(write.hideMessages),
      granted_by: write.grantedBy ?? null,
      // Só preenchido quando o modo está sendo LIGADO agora. Ver o
      // cabeçalho: desligar não apaga a marca.
      activated_at: write.active === true ? now : null,
      updated_at: now,
    };

    this.#db
      .prepare(
        `INSERT INTO player_streamer
           (steam_id, allowed, active, hide_logo, hide_ads, hide_messages,
            activated_at, granted_by, updated_at)
         VALUES
           (@steam_id,
            COALESCE(@allowed, 0),
            COALESCE(@active, 0),
            COALESCE(@hide_logo, 1),
            COALESCE(@hide_ads, 1),
            COALESCE(@hide_messages, 1),
            @activated_at, @granted_by, @updated_at)
         ON CONFLICT (steam_id) DO UPDATE SET
           allowed       = COALESCE(@allowed, allowed),
           active        = COALESCE(@active, active),
           hide_logo     = COALESCE(@hide_logo, hide_logo),
           hide_ads      = COALESCE(@hide_ads, hide_ads),
           hide_messages = COALESCE(@hide_messages, hide_messages),
           activated_at  = COALESCE(@activated_at, activated_at),
           granted_by    = COALESCE(@granted_by, granted_by),
           updated_at    = @updated_at`,
      )
      .run(params);

    return this.get(steamId);
  }

}

/**
 * `undefined` continua `undefined` — é ele que o `COALESCE` lê
 * como "não toque nesta coluna". `false` vira 0, e não some.
 */
function toFlag(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function toProfile(row: StreamerRow): StreamerProfile {
  return {
    steamId: row.steam_id,
    allowed: row.allowed === 1,
    active: row.active === 1,
    hideLogo: row.hide_logo === 1,
    hideAds: row.hide_ads === 1,
    hideMessages: row.hide_messages === 1,
    activatedAt: row.activated_at,
    grantedBy: row.granted_by,
    updatedAt: row.updated_at,
  };
}
