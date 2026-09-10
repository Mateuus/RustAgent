// ============================================================
//  materializer.ts  -  a planta sai do banco e vira arquivo.
//
//  ####  O BANCO É A VERDADE; O ARQUIVO É A CÓPIA DE TRABALHO  ####
//
//  Salvar no painel grava a linha e reescreve o arquivo nos
//  servidores onde aquela planta vale. Um arquivo apagado à mão
//  volta no próximo save ou no boot — e é isso que faz o painel ser
//  a única fonte da verdade de verdade, e não de mentirinha.
//
//  ####  POR QUE O DISCO, E NÃO O CONSOLE  ####
//
//  A maior planta herdada tem 512 KB. O frame do WebRCON aguenta
//  ~70 KB medidos, `plugin-push.ts` corta em 50 KB e `ui-images.ts`
//  corta imagem em 45.000 caracteres de base64. Não existe chunking
//  em lugar nenhum deste projeto, e inventá-lo aqui seria construir
//  a peça mais frágil do sistema para um problema que não precisa
//  dela.
//
//  O agente e os servidores rodam na MESMA máquina — é a premissa
//  do projeto (Docs/README.md) — e `oxide/data-files.ts` já sabe
//  escrever ali, com trava de `..` e backup antes de toda escrita.
//
//  Então: o comando de console leva o SLUG (26 bytes), e o plugin
//  lê os bytes do próprio disco.
//
//  ####  E O CAMINHO É `<plugin>/<arquivo>.json`, SEM SUBPASTA  ####
//
//  Não é preferência: `pluginDataPath` aceita um nome de plugin e um
//  de arquivo, os dois sem barra, e é essa restrição que faz a trava
//  de `..` valer. O plugin lê de `oxide/data/OrigemZDungeon/` e
//  pronto.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §5.4.
// ============================================================

import type { DungeonBlueprintsRepository } from '../db/dungeon-blueprints-repository.js';
import type { Logger } from '../logger.js';
import { writePluginDataFile } from '../oxide/data-files.js';
import { toError } from '../util.js';

/** A pasta do plugin dentro de `oxide/data`. */
export const DUNGEON_PLUGIN = 'OrigemZDungeon';

/** O que o materializador precisa saber de um servidor. */
export interface MaterializerServers {
  /** Os ids que o agente cuida. */
  readonly ids: () => readonly string[];
  /** `null` = o agente não cuida daquele servidor. */
  readonly dataDirOf: (serverId: string) => string | null;
}

export interface MaterializerDeps {
  readonly blueprints: DungeonBlueprintsRepository;
  readonly servers: MaterializerServers;
  readonly logger?: Logger;
}

/** Quantas plantas foram escritas, e quantas falharam. */
export interface MaterializeResult {
  readonly written: number;
  readonly failed: number;
}

export class BlueprintMaterializer {
  readonly #deps: MaterializerDeps;

  constructor(deps: MaterializerDeps) {
    this.#deps = deps;
  }

  /**
   * Põe TODAS as plantas no disco de um servidor.
   *
   * ####  TODAS, E NÃO SÓ AS QUE MUDARAM  ####
   *
   * Escrever o acervo inteiro num boot custa 1,1 MB de escrita e
   * responde a pergunta que importa: "o disco daquele servidor
   * bate com o banco?". Um delta precisaria de um registro do que
   * já foi escrito — e esse registro é a coisa que fica errada
   * quando alguém copia uma pasta de servidor para outra máquina.
   */
  async syncServer(serverId: string): Promise<MaterializeResult> {
    const dataDir = this.#deps.servers.dataDirOf(serverId);

    if (dataDir === null) return { written: 0, failed: 0 };

    let written = 0;
    let failed = 0;

    for (const summary of this.#deps.blueprints.list()) {
      const blueprint = this.#deps.blueprints.get(summary.id);

      if (blueprint === null) continue;

      try {
        await writePluginDataFile(dataDir, DUNGEON_PLUGIN, blueprint.id, blueprint.content);
        written += 1;
      } catch (cause) {
        // Uma planta que não grava não pode impedir as outras seis.
        // O servidor fica com o acervo incompleto e o log diz qual
        // faltou — melhor que nenhum acervo e um erro genérico.
        failed += 1;
        this.#deps.logger?.warn(
          { server: serverId, blueprint: blueprint.id, error: toError(cause).message },
          'não consegui gravar a planta no disco do servidor',
        );
      }
    }

    if (written > 0 || failed > 0) {
      this.#deps.logger?.debug({ server: serverId, written, failed }, 'plantas materializadas');
    }

    return { written, failed };
  }

  /** Uma planta, em todos os servidores. É o caminho do "salvei no painel". */
  async syncBlueprint(blueprintId: string): Promise<MaterializeResult> {
    const blueprint = this.#deps.blueprints.get(blueprintId);

    if (blueprint === null) return { written: 0, failed: 0 };

    let written = 0;
    let failed = 0;

    for (const serverId of this.#deps.servers.ids()) {
      const dataDir = this.#deps.servers.dataDirOf(serverId);

      if (dataDir === null) continue;

      try {
        await writePluginDataFile(dataDir, DUNGEON_PLUGIN, blueprint.id, blueprint.content);
        written += 1;
      } catch (cause) {
        failed += 1;
        this.#deps.logger?.warn(
          { server: serverId, blueprint: blueprint.id, error: toError(cause).message },
          'não consegui gravar a planta no disco do servidor',
        );
      }
    }

    return { written, failed };
  }

  /** Todas as plantas em todos os servidores. É o caminho do boot. */
  async syncAll(): Promise<MaterializeResult> {
    let written = 0;
    let failed = 0;

    for (const serverId of this.#deps.servers.ids()) {
      const result = await this.syncServer(serverId);

      written += result.written;
      failed += result.failed;
    }

    return { written, failed };
  }
}
