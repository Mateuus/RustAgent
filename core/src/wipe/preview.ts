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
import { KEEP_CUSTOM_IN_FORCED_REASON, pinnedRejection } from './map-pool.js';
import {
  currentWorldReader,
  mapOfPlan,
  mapOfPool,
  nextPendingPlan,
  type WipeRunsReader,
} from './next-wipe.js';
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
  /**
   * O wipe que esta prévia descreve: a execução em curso, se
   * houver uma, e senão o próximo marcado. `null` = nenhum dos
   * dois. Ver `planOfPreview`.
   */
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
  /**
   * A entrada da fila que ESTE wipe vai consumir.
   *
   * `null` nos dois mundos que não saem da fila, e o aviso que
   * acompanha diz qual é: `MAP_KEPT`, o plano que manda manter o
   * mapa de agora, e `EMPTY_MAP_POOL`, a seed que o agente sorteia
   * porque nada na fila serve.
   */
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
    /**
     * O `server.levelurl` de agora. Vazio = mundo procedural.
     *
     * Ele não está aqui para ser mostrado: é o que decide se um
     * wipe FORÇADO pode MANTER o mundo de hoje. Ver
     * `keepBlockedInForced`, em wipe/map-pool.ts.
     *
     * OBRIGATÓRIO, e pela mesma razão que o `NextWipeDeps.world`
     * deixou de ser opcional: omiti-lo não dá erro nenhum, dá "o
     * mundo é procedural" — e um ponto de decisão que responde
     * diferente dos outros três não se anuncia, é descoberto na
     * madrugada. `null` diz "procedural" por escrito.
     */
    readonly levelUrl: string | null;
  };
  readonly schedule: WipeScheduleReader;
  /**
   * As execuções em curso.
   *
   * ####  SEM ELAS, A PRÉVIA PERDE O WIPE DE HOJE  ####
   *
   * O relógio marca o plano `running` ao criar a execução, com a
   * antecedência do maior offset de aviso — 1440 minutos, no
   * padrão. Nas 24 h que antecedem TODO wipe agendado é ESTE o
   * plano em curso, e é ele que a prévia tem de descrever, como o
   * chat, a tela do jogo e o executor descrevem.
   *
   * Ausente = a prévia cai só na agenda, e o pior que acontece é
   * ela voltar a descrever o wipe seguinte durante a execução do
   * de hoje.
   */
  readonly runs?: WipeRunsReader;
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
  const plan = planOfPreview(deps, now);
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
    : { files: [], missing: [], total: 0, truncated: false, notScanned: [] };

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

  // ---- o mundo que entra ------------------------------------
  //
  // ####  A MESMA DECISÃO DO EXECUTOR, E NÃO UMA PARECIDA  ####
  //
  // Quem escolhe o mundo é `mapOfPlan`, de wipe/next-wipe.ts — a
  // mesma função que o passo `configurar` consome, que o chat
  // responde em `{wipe.mapa}` e que a tela CALENDÁRIO desenha.
  // Perguntar aqui "qual é a cabeça da fila?" acertava enquanto o
  // executor perguntava o mesmo; desde que ele passou a respeitar
  // o `mapSource`, ESTA tela — a última que o admin lê antes de
  // apertar o botão que zera o servidor — passou a prometer outra
  // coisa. Medido: plano `keep` prometendo a cabeça da fila que
  // ele não toca, e `fixed` apontando a #2 prometendo a #1.
  //
  // Sem plano — o "WIPAR AGORA" —, a fila é a resposta, como no
  // executor. E ele nunca é FORÇADO: a execução sem plano nasce
  // `manual` (ver routes/wipe-runs.ts), e é o forçado que faz a
  // fila pular o mapa custom sem marca de versão.
  //
  // O mundo de agora entra na decisão por um caminho só: um wipe
  // FORÇADO não MANTÉM um `.map` custom sem a marca de
  // compatibilidade. A leitura é a MESMA do executor
  // (`currentWorldReader`), montada aqui sobre o `.ini` que a rota
  // já leu.
  const world = currentWorldReader({
    servers: { configOf: () => ({ levelUrl: deps.current.levelUrl ?? '' }) },
    mapPool: deps.mapPool,
  });

  const decision =
    plan === null
      ? mapOfPool({ mapPool: deps.mapPool }, deps.serverId, false)
      : mapOfPlan({ mapPool: deps.mapPool, world }, plan);

  // `mapOfPlan` fala no contrato mínimo (`MapPoolEntry`); a tela
  // espera o registro inteiro da fila, com nota e `updatedAt`. É a
  // MESMA linha, relida pelo id — e não uma segunda escolha.
  const nextMap =
    decision.source === 'entry' ? deps.mapPool.get(deps.serverId, decision.entry.id) : null;

  // ---- os avisos --------------------------------------------
  //
  // ####  UM AVISO QUE DESCREVE O QUE NÃO VAI ACONTECER  ####
  //
  // É pior do que aviso nenhum: o admin decide com base nele. Cada
  // um dos três avisos de MUNDO — o mantido, o sorteado e o
  // escolhido a dedo que não serve — sai do caso em que ele é
  // VERDADE, e de nenhum outro.
  if (decision.source === 'keep') {
    warnings.push({
      code: 'MAP_KEPT',
      message:
        'Este wipe NÃO troca o mundo: o plano manda MANTER o mapa de agora — mesma seed, mesmo ' +
        'tamanho, mesmo arquivo. O que zera é o save. A fila de mapas não é tocada, e a próxima ' +
        'entrada dela continua esperando o wipe seguinte.',
    });
  }

  // ####  O `keep` QUE O FORÇADO NÃO ACEITA  ####
  //
  // A agenda já recusa gravar isto (routes/wipe.ts), e esta linha
  // é para os planos que foram gravados antes de a trava existir e
  // para o servidor que virou mapa custom DEPOIS de o plano ser
  // marcado. O wipe acontece do mesmo jeito — o mundo sai da fila
  // —, e é aqui, na última tela antes do botão, que o admin
  // descobre que a ordem dele não vale nesta noite. Ver Docs\16.
  if (plan !== null && plan.mapSource === 'keep' && decision.source !== 'keep') {
    warnings.push({
      code: 'KEEP_REFUSED_IN_FORCED',
      message:
        'Este wipe é FORÇADO e o plano manda MANTER o mundo, mas ele NÃO vai ficar: ' +
        `${KEEP_CUSTOM_IN_FORCED_REASON}. O mundo vem da fila, como em qualquer outro wipe. ` +
        'Para manter mesmo assim, marque o .map de agora como compatível na sub-aba Mapas.',
    });
  }

  if (decision.source === 'undecided') {
    warnings.push({
      code: 'EMPTY_MAP_POOL',
      message:
        'Nenhuma entrada da fila serve para este wipe: ou ela está vazia, ou o que sobrou é mapa ' +
        'custom sem a marca de compatibilidade num wipe forçado. Isso NÃO trava o wipe: o agente ' +
        'sorteia uma seed, registra que sorteou e segue. Só significa que ninguém escolheu o ' +
        'mundo que vem.',
    });
  }

  // ####  O PONTEIRO DO PLANO PODE TER MORRIDO  ####
  //
  // `fixed` aponta uma entrada, e ela some da fila, é consumida
  // por um wipe anterior, fica presa em `generating` ou é um
  // `.map` custom sem a marca de versão num wipe forçado. O wipe
  // acontece do mesmo jeito — cair para a fila é de propósito —,
  // mas quem escolheu a dedo precisa saber ANTES que o mundo dele
  // não é o que vai subir, e por quê. Ver Docs\16 §9.1.
  if (plan !== null && plan.mapSource === 'fixed') {
    const reason = pinnedRejection(
      plan.mapPoolId === null ? null : deps.mapPool.get(deps.serverId, plan.mapPoolId),
      plan.kind === 'forced',
    );

    if (reason !== null) {
      warnings.push({
        code: 'PINNED_MAP_UNUSABLE',
        message:
          plan.mapPoolId === null
            ? 'Este wipe está marcado como "mapa escolhido a dedo" e não aponta entrada nenhuma: ' +
              'o mundo vai sair da fila, como em qualquer outro wipe.'
            : `A entrada #${String(plan.mapPoolId)}, escolhida a dedo neste wipe, não vai subir: ` +
              `${reason}. O mundo sai da fila, e a escolha continua gravada no plano.`,
      });
    }
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

  // ####  A LISTA CORTADA PRECISA SE ANUNCIAR  ####
  //
  // O corte é só da tela — o purge varre o disco inteiro. Mas quem
  // confere a prévia precisa saber que está olhando um pedaço, ou
  // vai concluir que o resto não existe.
  if (pluginData.truncated) {
    warnings.push({
      code: 'PLUGIN_DATA_TRUNCATED',
      message:
        `Existem ${String(pluginData.total)} arquivos de dados de plugin, e a tela mostra os ` +
        `${String(pluginData.files.length)} primeiros (os marcados vêm na frente). O que o wipe ` +
        'apaga NÃO é o que cabe na tela: é tudo o que casa com os padrões marcados.',
    });
  }

  if (pluginData.notScanned.length > 0) {
    warnings.push({
      code: 'PLUGIN_DATA_TOO_DEEP',
      message:
        `A varredura de oxide\\data não desceu ${String(pluginData.notScanned.length)} pasta(s) ` +
        `por serem fundas demais: ${pluginData.notScanned.slice(0, 5).join(', ')}. O que está ` +
        'dentro delas não aparece na lista e o full wipe não vai levar.',
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

/**
 * O plano que ESTA prévia descreve.
 *
 * ####  A EXECUÇÃO EM CURSO VEM ANTES DA AGENDA  ####
 *
 * É a MESMA ordem do `nextWipe` (wipe/next-wipe.ts), e ela não é
 * preciosismo: o relógio marca o plano `running` ao criar a
 * execução, com a antecedência do maior offset de aviso — 1440
 * minutos, no padrão. Perguntar `nextPlan` (que exige `planned` e
 * hora futura) nas 24 h que antecedem TODO wipe agendado devolvia
 * o plano da SEMANA QUE VEM: mundo errado, `bpPolicy` errada — e
 * com ela o `classifySaveFolder` classificando os arquivos pela
 * política de outro wipe — e o aviso MAP_KEPT sumindo da tela que
 * o admin lê antes de apertar o botão.
 *
 * Depois da execução em curso vem o primeiro plano PENDENTE à
 * frente, `planned` ou `running`, pelo mesmo `nextPendingPlan` que
 * o chat e a tela do jogo usam.
 */
function planOfPreview(deps: WipePreviewDeps, now: number): WipePlan | null {
  const run = deps.runs?.running().find((candidate) => candidate.serverId === deps.serverId);

  const running =
    run === undefined || run.planId === null
      ? null
      : deps.schedule.getPlan(deps.serverId, run.planId);

  return running ?? nextPendingPlan(deps.schedule.listPlans(deps.serverId, { from: now }));
}
