// ============================================================
//  recover.ts  -  O WIPE SOBREVIVE AO REINÍCIO DO AGENTE
//
//  O passo `avisar` de wipe/run.ts espera a hora do wipe com a
//  execução VIVA na memória do agente. Um wipe marcado para daqui a
//  duas horas passa duas horas ali dentro. Se o agente sair nesse
//  meio — crash, `pm2 restart`, um arquivo salvo sob `tsx watch` —
//  a execução morre junto, e o `orphan()` do repositório carimba a
//  linha como `failed`.
//
//  Até aqui isso era o fim: a tela oferecia RETOMAR e alguém
//  precisava clicar. Este arquivo é o que faz o agente clicar
//  sozinho ao voltar.
//
//  ------------------------------------------------------------
//  ####  ORFANAR PRIMEIRO, RETOMAR DEPOIS  ####
//
//  A linha vira `failed` ANTES de qualquer tentativa de retomada, e
//  não no lugar dela. São dois fatos diferentes: "esta execução foi
//  interrompida" aconteceu de verdade e fica no histórico; "e o
//  agente a retomou" é o que vem depois. Se a retomada falhar (o
//  servidor sumiu do `.ini`, a trava do recurso está ocupada), o que
//  sobra é exatamente o estado de antes — `failed`, com o botão na
//  tela. Nunca uma linha `running` sem ninguém correndo atrás dela.
//
//  ------------------------------------------------------------
//  ####  ATRASO NÃO CANCELA WIPE  ####
//
//  Este arquivo já nasceu com um teto de 6 h no atraso: passado
//  ele, a execução ficava `failed` e a decisão voltava para quem
//  opera. O argumento era o wipe surpresa — a máquina que passou o
//  fim de semana desligada zerando o mundo ao voltar.
//
//  O dono desfez isso em 08/09/2026, e a regra dele é mais simples
//  do que a que o teto expressava:
//
//      um wipe marcado só deixa de acontecer quando o admin
//      CANCELA ou ADIA. Nada mais.
//
//  E ela é a regra certa: a data do wipe foi anunciada no chat e no
//  site, e um servidor que não wipa porque o agente estava fora na
//  hora é um servidor que mentiu para quem joga. O atraso não muda
//  o que foi combinado — só atrasa.
//
//  O `maxLateMs` continua existindo, e continua testado, porque a
//  capacidade de recusar por atraso é diferente de querer usá-la:
//  quem passar um número volta ao comportamento antigo. O que
//  mudou é o PADRÃO, que agora é "sem teto".
//
//  Sobram duas coisas que ainda seguram uma retomada, e nenhuma
//  delas é uma opinião sobre a hora: o cancelamento do admin (logo
//  abaixo) e o servidor que não desce — sem o jogo parado, o Rust
//  reescreve no `saveinterval` seguinte o que for apagado, e aí o
//  `apagar` recusa (ver wipe/run.ts).
// ============================================================

import type { WipeRunRecord } from '../db/wipe-runs-repository.js';
import type { Logger } from '../logger.js';
import type { WipeRunStep } from '../types/wipe.js';
import { toError } from '../util.js';

/**
 * Quanto atraso cabe numa retomada automática: TODO ele.
 *
 * Não é um descuido nem um valor grande escolhido a esmo — é a
 * regra do dono escrita como número. Atraso não cancela wipe; só o
 * admin cancela. Ver o cabeçalho.
 *
 * Quem quiser o comportamento antigo passa `maxLateMs` na chamada:
 * a recusa por atraso continua implementada e continua testada.
 */
export const DEFAULT_MAX_LATE_MS = Number.POSITIVE_INFINITY;

/**
 * Os passos cujo `done` significa "o servidor já está no chão por
 * causa deste wipe".
 *
 * `parar` é o primeiro: depois dele o processo do jogo não existe
 * mais. `backup` e `apagar` correm com ele parado, e `configurar`
 * grava o mundo novo. Em qualquer um deles, a única saída é seguir
 * até o `subir`.
 */
const PAST_NO_RETURN: readonly WipeRunStep[] = ['parar', 'backup', 'apagar', 'configurar'];

/** O que o recuperador decidiu sobre UMA execução. */
export type WipeRecoveryOutcome =
  /** Estava viva de verdade (a operação existe). Não foi tocada. */
  | 'left-running'
  /** Orfanada e retomada: o wipe vai acontecer. */
  | 'resumed'
  /** Orfanada e deixada assim. A tela oferece retomar. */
  | 'kept-failed'
  /**
   * O admin tinha cancelado. Não retoma, e a linha vira
   * `cancelled` — o desfecho que a máquina de passos não chegou a
   * gravar antes de o agente morrer.
   */
  | 'cancelled';

export interface WipeRecoveryDecision {
  readonly serverId: string;
  readonly runId: number;
  readonly outcome: WipeRecoveryOutcome;
  /** Em português: é isto que vai para o log e para quem operar. */
  readonly reason: string;
}

/** O recorte do `WipeRunsRepository` que o recuperador usa. */
export interface WipeRecoveryRuns {
  running(): readonly WipeRunRecord[];
  orphan(serverId: string, id: number, now?: number): WipeRunRecord;
  update(
    serverId: string,
    id: number,
    patch: {
      readonly status?: 'cancelled';
      readonly finishedAt?: number | null;
      readonly operationId?: string | null;
      readonly message?: string;
    },
    now?: number,
  ): WipeRunRecord;
}

/** O recorte do registro de operações: só saber se aquela existe. */
export interface WipeRecoveryOperations {
  get(id: string): unknown | null;
}

/** O recorte do supervisor: o serviço de operações do servidor. */
export interface WipeRecoveryServers {
  contextOf(id: string): {
    readonly operations: {
      start(input: {
        readonly kind: 'wipe-run';
        readonly wipe: { readonly runId: number; readonly resume: boolean };
      }): Promise<{ readonly id: string }>;
    };
  } | null;
}

export interface WipeRecoveryDeps {
  readonly runs: WipeRecoveryRuns;
  readonly operations: WipeRecoveryOperations;
  readonly servers: WipeRecoveryServers;
  readonly logger?: Logger | undefined;
  /** O teto do atraso. Ausente = `DEFAULT_MAX_LATE_MS`. */
  readonly maxLateMs?: number | undefined;
  /** Injetável para o teste não depender do relógio da máquina. */
  readonly now?: (() => number) | undefined;
}

/**
 * Varre as execuções que ficaram `running` de uma sessão anterior e
 * retoma o que dá para retomar.
 *
 * Roda uma vez, no boot. Nunca lança: uma exceção aqui mataria o
 * resto da subida do agente, e um wipe que não pôde ser retomado
 * continua sendo um wipe com botão na tela.
 */
export async function recoverInterruptedWipes(
  deps: WipeRecoveryDeps,
): Promise<readonly WipeRecoveryDecision[]> {
  const now = deps.now?.() ?? Date.now();
  const maxLateMs = deps.maxLateMs ?? DEFAULT_MAX_LATE_MS;
  const decisions: WipeRecoveryDecision[] = [];

  for (const run of deps.runs.running()) {
    // Uma operação viva quer dizer que ESTE agente ainda está
    // correndo com ela — o boot não é o dono dela.
    if (run.operationId !== null && deps.operations.get(run.operationId) !== null) {
      decisions.push({
        serverId: run.serverId,
        runId: run.id,
        outcome: 'left-running',
        reason: 'a operação desta execução ainda está viva neste agente.',
      });

      continue;
    }

    // Ver o cabeçalho: o carimbo do que aconteceu vem antes da
    // tentativa de consertar.
    deps.runs.orphan(run.serverId, run.id, now);

    const decision = await resumeOne(deps, run, now, maxLateMs);

    decisions.push(decision);

    deps.logger?.warn(
      { server: run.serverId, run: run.id },
      `execução de wipe interrompida por um reinício do agente; ${decision.reason}` +
        // Só a que ficou `failed` tem botão. A cancelada terminou, e
        // a retomada não tem desfecho a oferecer.
        (decision.outcome === 'kept-failed' ? ' A tela oferece retomar.' : ''),
    );
  }

  return decisions;
}

// ------------------------------------------------------------
//  Interno
// ------------------------------------------------------------

async function resumeOne(
  deps: WipeRecoveryDeps,
  run: WipeRunRecord,
  now: number,
  maxLateMs: number,
): Promise<WipeRecoveryDecision> {
  const base = { serverId: run.serverId, runId: run.id } as const;

  // ####  A PRIMEIRA PERGUNTA É SE O ADMIN MANDOU PARAR  ####
  //
  // Ela vem antes de tudo — antes do servidor estar montado, antes
  // do teto, e antes até do ponto sem volta. Um wipe cancelado com
  // o mundo já apagado continua cancelado: terminar de subir um
  // mundo novo é exatamente o que o admin mandou não fazer, e o
  // servidor volta ao ar pelo botão de iniciar, que não apaga nada.
  //
  // O carimbo é da rota de cancelar (migração 056). Sem ele, esta
  // linha `running` seria indistinguível de uma execução que só foi
  // interrompida — e a retomada terminaria o wipe.
  if (run.cancelRequestedAt !== null) {
    deps.runs.update(run.serverId, run.id, {
      status: 'cancelled',
      finishedAt: now,
      operationId: null,
      message:
        'Cancelada pelo admin. O agente reiniciou antes de a execução terminar de sair, e não ' +
        'a retomou — o que já tinha sido feito NÃO foi desfeito, então confira o estado do ' +
        'servidor antes de disparar outro wipe.',
    }, now);

    return {
      ...base,
      outcome: 'cancelled',
      reason: 'o admin tinha cancelado esta execução, e por isso ela NÃO foi retomada.',
    };
  }

  const context = deps.servers.contextOf(run.serverId);

  if (context === null) {
    return {
      ...base,
      outcome: 'kept-failed',
      reason:
        `o agente não está cuidando do servidor "${run.serverId}" (SERVER_ENABLED, ou o jogo ` +
        'ainda não está instalado), e por isso não dá para retomar sozinho.',
    };
  }

  const pastNoReturn = isPastNoReturn(run);
  const lateMs = now - run.wipeAt;

  if (!pastNoReturn && lateMs > maxLateMs) {
    return {
      ...base,
      outcome: 'kept-failed',
      reason:
        `a hora do wipe passou há ${formatDuration(lateMs)} e nada foi apagado ainda — atraso ` +
        `demais para zerar o mundo sozinho (o teto é ${formatDuration(maxLateMs)}).`,
    };
  }

  try {
    const operation = await context.operations.start({
      kind: 'wipe-run',
      wipe: { runId: run.id, resume: true },
    });

    return {
      ...base,
      outcome: 'resumed',
      reason: pastNoReturn
        ? `o servidor já estava parado por causa dela — retomada na operação ${operation.id} ` +
          'para terminar de subir o mundo novo.'
        : `retomada sozinha na operação ${operation.id}, do primeiro passo que não terminou.`,
    };
  } catch (error) {
    return {
      ...base,
      outcome: 'kept-failed',
      reason: `a retomada automática não começou: ${toError(error).message}`,
    };
  }
}

/** Algum passo que derruba o servidor já terminou? Ver o cabeçalho. */
function isPastNoReturn(run: WipeRunRecord): boolean {
  return run.steps.some((step) => step.status === 'done' && PAST_NO_RETURN.includes(step.step));
}

/** Duração em português, para a frase do log. */
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);

  if (minutes < 60) {
    return `${String(Math.max(minutes, 1))} min`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}
