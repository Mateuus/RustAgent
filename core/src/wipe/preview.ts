// ============================================================
//  preview.ts  -  O QUE ESTE WIPE VAI APAGAR. Sem apagar.
//
//  ####  A LISTA VEM ANTES DO BOTÃO  ####
//
//  E ela é lida do DISCO, arquivo por arquivo, com tamanho e
//  motivo — não é um texto fixo dizendo o que *deveria* estar lá.
//  Um wipe é a operação que zera o trabalho de todos os
//  jogadores; quem clica precisa ter visto a lista de verdade.
//
//  ####  ELA NÃO ESCREVE NADA. EM LUGAR NENHUM.  ####
//
//  Nem no disco, nem no banco, nem no servidor de jogo. É uma
//  leitura, e é isso que a torna segura de chamar a cada abertura
//  de tela, com o servidor no ar e cheio de gente.
//
//  ####  E ELA É A MESMA CLASSIFICAÇÃO QUE O PASSO `apagar` USA  ####
//
//  Ver save-files.ts. Uma lista do que SERIA apagado e outra do
//  que É apagado seriam duas verdades sobre a mesma pasta, e a
//  divergência entre elas só apareceria depois do estrago.
//
//  ------------------------------------------------------------
//  ####  IMPEDIMENTO É DIFERENTE DE AVISO  ####
//
//  `blockers`  o wipe NÃO PODE rodar assim, e cada um tem
//              conserto — a mensagem diz qual. Eles viram as
//              recusas ANTES do 202 em `POST /wipe/runs`.
//  `warnings`  o wipe roda, mas alguém precisa saber. Fila de
//              mapas vazia não impede nada: o agente sorteia. Só
//              significa que ninguém escolheu o mundo.
// ============================================================

import type { MapPoolRepository, MapPoolRecord } from '../db/map-pool-repository.js';
import type { WipeExecSettings } from '../db/wipe-runs-repository.js';
import type { WipeScheduleReader } from '../db/wipe-schedule-repository.js';
import type { BpPolicy, WipePlan } from '../types/wipe.js';
import { checkBackupSpace, type BackupSpace } from './backup.js';
import { listPluginData, type PluginDataListing } from './plugin-data.js';
import { classifySaveFolder, saveFolderPath, type SaveFolderSummary } from './save-files.js';
import { nextForcedWipe } from './schedule.js';

export interface WipeNotice {
  readonly code: string;
  readonly message: string;
}

export interface WipePreview {
  /** O relógio DO AGENTE, como em toda rota de wipe. */
  readonly now: number;
  /** O próximo wipe marcado. `null` = nada materializado. */
  readonly plan: WipePlan | null;
  /** O forçado da Facepunch, derivado da regra. */
  readonly nextForcedAt: number;
  /**
   * A política que vale para ESTE wipe.
   *
   * Sai do plano quando existe um. Sem plano é `keep` — o padrão
   * do próprio jogo, e a escolha que não tira nada de ninguém.
   */
  readonly bpPolicy: BpPolicy;
  /** Este wipe leva também a lista de dados de plugin. */
  readonly fullWipe: boolean;
  /** O mundo que entra. `null` = fila vazia, e o agente sorteia. */
  readonly nextMap: MapPoolRecord | null;
  readonly server: {
    readonly id: string;
    readonly identity: string;
    /** O mundo em que o servidor está AGORA, do `.ini` dele. */
    readonly level: string | null;
    readonly seed: string | null;
    readonly worldSize: number | null;
    readonly saveFolder: string;
    /** `null` quando não foi possível perguntar. */
    readonly running: boolean | null;
    readonly rconConnected: boolean;
    /** `null` = não deu para perguntar, e isso é diferente de zero. */
    readonly online: number | null;
  };
  /** Os arquivos da pasta do save, classificados. */
  readonly files: SaveFolderSummary;
  /** O que o full wipe levaria além disso. Vazio quando desligado. */
  readonly pluginData: PluginDataListing;
  readonly backup: BackupSpace & { readonly dir: string; readonly enabled: boolean };
  readonly blockers: readonly WipeNotice[];
  readonly warnings: readonly WipeNotice[];
}

export interface WipePreviewDeps {
  readonly serverId: string;
  readonly identity: string;
  /** `ServerConfig.paths.installDir`. */
  readonly installDir: string;
  /** `ServerConfig.paths.backupsDir`. */
  readonly backupsDir: string;
  /** O mundo do `.ini` de hoje. */
  readonly current: {
    readonly level: string | null;
    readonly seed: string | null;
    readonly worldSize: number | null;
  };
  readonly schedule: WipeScheduleReader;
  readonly mapPool: MapPoolRepository;
  readonly exec: WipeExecSettings;
  /** `null` quando não deu para perguntar (OPS_ENABLED=0, por exemplo). */
  readonly running?: boolean | null;
  readonly rconConnected?: boolean;
  readonly online?: number | null;
  /** A política de um wipe que ainda não é plano ("WIPAR AGORA"). */
  readonly bpPolicy?: BpPolicy;
  readonly fullWipe?: boolean;
  readonly now?: number;
}

/** Lê o disco e responde o que este wipe faria. */
export async function buildWipePreview(deps: WipePreviewDeps): Promise<WipePreview> {
  const now = deps.now ?? Date.now();
  const plan = deps.schedule.nextPlan(deps.serverId, now);
  const bpPolicy = deps.bpPolicy ?? plan?.bpPolicy ?? 'keep';
  const exec = deps.exec;
  const fullWipe = deps.fullWipe ?? exec.pluginData.enabled;

  const saveFolder = saveFolderPath(deps.installDir, deps.identity);
  const files = await classifySaveFolder(saveFolder, bpPolicy);

  const pluginData = fullWipe
    ? await listPluginData({
        installDir: deps.installDir,
        identity: deps.identity,
        selected: exec.pluginData.patterns,
        bpPolicy,
      })
    : { files: [], missing: [] };

  const backup = await checkBackupSpace(saveFolder, deps.backupsDir);

  const blockers: WipeNotice[] = [];
  const warnings: WipeNotice[] = [];

  // ---- os impedimentos --------------------------------------
  //
  // ####  O ESPAÇO É O PRIMEIRO, E É POR ISSO QUE ELE É AQUI  ####
  //
  // Esta função roda com o servidor AINDA NO AR. Descobrir que o
  // disco está cheio no passo `backup` significaria descobrir com
  // o servidor já parado — o pior desfecho, porque a operação não
  // pode ser abandonada nem concluída.
  if (exec.backup.enabled && !backup.ok && backup.reason !== null) {
    blockers.push({ code: 'NO_DISK_SPACE', message: backup.reason });
  }

  if (!files.exists) {
    warnings.push({
      code: 'NO_SAVE_FOLDER',
      message:
        `A pasta ${saveFolder} não existe: este servidor nunca subiu, ou a SERVER_IDENTITY ` +
        'mudou. Não há o que apagar, e o wipe vai só trocar o mundo configurado.',
    });
  }

  // ---- os avisos --------------------------------------------
  const nextMap = deps.mapPool.next(deps.serverId, plan?.kind === 'forced');

  if (nextMap === null) {
    warnings.push({
      code: 'EMPTY_MAP_POOL',
      message:
        'A fila de mapas está vazia. Isso NÃO trava o wipe: o agente sorteia uma seed, registra ' +
        'que sorteou e segue. Só significa que ninguém escolheu o mundo que vem.',
    });
  }

  if (!exec.backup.enabled) {
    warnings.push({
      code: 'BACKUP_DISABLED',
      message:
        'O backup está desligado para este servidor. O wipe roda, e não há volta: nenhum arquivo ' +
        'apagado poderá ser restaurado.',
    });
  }

  if (bpPolicy !== 'keep') {
    warnings.push({
      code: 'BLUEPRINTS_WIPED',
      message:
        bpPolicy === 'wipe'
          ? 'Este wipe apaga os blueprints: todo mundo recomeça sem saber nada.'
          : 'Este wipe apaga os blueprints de todos e devolve a quem tem direito depois. A ' +
            'devolução acontece no login de cada jogador.',
    });
  }

  if (fullWipe && exec.pluginData.patterns.length === 0) {
    warnings.push({
      code: 'FULL_WIPE_WITHOUT_LIST',
      message:
        'O full wipe está ligado, mas nenhum arquivo de plugin foi marcado — então ele não vai ' +
        'levar nada além do que a política já leva. Escolha os arquivos na sub-aba Configuração.',
    });
  }

  if (pluginData.missing.length > 0) {
    warnings.push({
      code: 'PLUGIN_DATA_MISSING',
      message:
        `${String(pluginData.missing.length)} item(ns) marcado(s) não existe(m) mais em disco: ` +
        `${pluginData.missing.join(', ')}. A escolha continua salva — apagar num arquivo que não ` +
        'está lá é sucesso, e não erro.',
    });
  }

  if (deps.rconConnected === false && (deps.running ?? false)) {
    warnings.push({
      code: 'RCON_DOWN',
      message:
        'O processo está no ar mas o RCON não responde. Sem RCON o agente não consegue avisar no ' +
        'chat nem encerrar salvando — o passo `parar` vai precisar de force, e o que se perde é ' +
        'tudo desde o último save automático.',
    });
  }

  return {
    now,
    plan,
    nextForcedAt: nextForcedWipe(now),
    bpPolicy,
    fullWipe,
    nextMap,
    server: {
      id: deps.serverId,
      identity: deps.identity,
      level: deps.current.level,
      seed: deps.current.seed,
      worldSize: deps.current.worldSize,
      saveFolder,
      running: deps.running ?? null,
      rconConnected: deps.rconConnected ?? false,
      online: deps.online ?? null,
    },
    files,
    pluginData,
    backup: { ...backup, dir: deps.backupsDir, enabled: exec.backup.enabled },
    blockers,
    warnings,
  };
}
