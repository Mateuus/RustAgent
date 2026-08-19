// ============================================================
//  next-wipe.ts  -  QUAL é o próximo wipe, e QUAL mundo é o dele.
//
//  ####  UMA DECISÃO SÓ, PARA OS TRÊS QUE PERGUNTAM  ####
//
//  Três lugares fazem a mesma pergunta e precisam da mesma
//  resposta, no mesmo segundo:
//
//    1. o chat, em `{wipe.faltam}` / `{wipe.quando}` / `{wipe.mapa}`
//       (messages/providers/wipe.ts);
//    2. o passo `avisar` de uma execução (wipe/announce.ts, que
//       fala pelo mesmo provedor);
//    3. a página CALENDÁRIO do menu do jogo e o
//       `GET /wipe/upcoming/me` (game/ui-calendar-screen.ts).
//
//  Antes deste arquivo o item 3 tinha uma segunda conta — parecida,
//  e não igual. O resultado media-se em campo: às 14:00 de quarta,
//  com wipe quinta às 10:00, o chat anunciava "WIPE em 20 horas" e
//  a tela dizia "faltam 7 dias e 20 horas". Duas respostas para
//  "quando é o próximo wipe" é pior do que nenhuma: o jogador
//  acredita na que viu por último.
//
//  Este módulo é a resposta, e só ela. Ele NÃO escreve frase
//  nenhuma — quem transforma isto em texto é
//  messages/providers/wipe.ts, e é por isso que não há aqui um
//  `import` dele: o texto depende da decisão, a decisão não
//  depende do texto.
//
//  ------------------------------------------------------------
//  ####  A EXECUÇÃO EM CURSO VEM ANTES DA AGENDA  ####
//
//    1. um `wipe_run` `running` neste servidor  ->  é ELE
//    2. senão, o primeiro plano PENDENTE à frente
//    3. senão, não há wipe à vista
//
//  O passo 1 não é preciosismo, e são dois casos concretos:
//
//    · o "WIPAR AGORA" com hora marcada (`POST /wipe/runs` com
//      `at`) nem plano tem — sem o passo 1, o aviso de 15 minutos
//      sairia dizendo "WIPE em sem wipe agendado";
//
//    · nas horas que antecedem a hora marcada o wipe JÁ ESTÁ
//      executando: o relógio dispara com antecedência igual ao
//      maior offset de aviso (o padrão começa em 1440 min), e nessa
//      janela o plano está `running` — que o `nextPlan` do
//      repositório ignora de propósito, porque ele responde "o que
//      executar em seguida" e não "o que contar ao jogador".
// ============================================================

import type { WipeRunRecord, WipeWorld } from '../db/wipe-runs-repository.js';
import type { WipeScheduleReader } from '../db/wipe-schedule-repository.js';
import type { BpPolicy, MapPoolEntry, WipePlan, WipePlanKind } from '../types/wipe.js';
import { usableForWipe } from './map-pool.js';

// ------------------------------------------------------------
//  §1  DE ONDE OS FATOS VÊM
// ------------------------------------------------------------

/** As execuções em curso. O recorte mínimo de `WipeRunsRepository`. */
export interface WipeRunsReader {
  running(): readonly WipeRunRecord[];
}

/** A fila de mapas, só de leitura. O recorte de `MapPoolRepository`. */
export interface WipeMapPoolReader {
  next(serverId: string, forced?: boolean): MapPoolEntry | null;
  get(serverId: string, id: number): MapPoolEntry | null;
}

export interface NextWipeDeps {
  readonly schedule: WipeScheduleReader;
  readonly runs: WipeRunsReader;
  readonly mapPool: WipeMapPoolReader;
}

// ------------------------------------------------------------
//  §2  O QUE A DECISÃO DEVOLVE
// ------------------------------------------------------------

/**
 * De onde sai o mundo que entra depois do próximo wipe.
 *
 * ####  POR QUE UMA UNIÃO, E NÃO UMA FRASE  ####
 *
 * O chat precisa da FRASE (`procedural 4000`); a tela precisa da
 * frase E da imagem, e a imagem só existe na entrada da fila. Se
 * este módulo devolvesse texto, a tela teria de procurar a entrada
 * de novo — e é exatamente essa segunda busca que fazia a tela
 * anunciar um mundo que não ia subir.
 */
export type NextWipeMap =
  /**
   * `mapSource: 'keep'` — o mesmo mapa de agora: MESMA seed, mesmo
   * tamanho, mesmo `levelUrl`. O que zera é o save, e não o mundo.
   */
  | { readonly source: 'keep' }
  /** Uma entrada da fila: a escolhida a dedo, ou a primeira pronta. */
  | { readonly source: 'entry'; readonly entry: MapPoolEntry }
  /** O mundo JÁ GRAVADO numa execução que passou do `configurar`. */
  | { readonly source: 'world'; readonly world: WipeWorld }
  /** Ninguém escolheu: o agente sorteia na hora. */
  | { readonly source: 'undecided' };

/** O mundo ainda não decidido, como constante, para não repetir o literal. */
export const UNDECIDED_MAP: NextWipeMap = { source: 'undecided' };

/**
 * O próximo wipe deste servidor, já decidido.
 *
 * `null` não existe aqui: quem não tem wipe à vista recebe `null`
 * de `nextWipe`, e não um objeto meio vazio.
 */
export interface NextWipe {
  /** Quando o mundo zera, em epoch ms UTC. */
  readonly wipeAt: number;
  readonly kind: WipePlanKind;
  readonly bpPolicy: BpPolicy;
  readonly map: NextWipeMap;
  /** A zona IANA em que a data dele é escrita. */
  readonly timeZone: string;
  /**
   * O plano da agenda que é este wipe.
   *
   * `null` quando ele é uma execução sem plano — o "WIPAR AGORA"
   * com hora marcada. Quem lista a agenda usa este id para não
   * mostrar o mesmo wipe duas vezes.
   */
  readonly planId: number | null;
  /** A execução dele já começou (os avisos já estão saindo). */
  readonly running: boolean;
}

// ------------------------------------------------------------
//  §3  A DECISÃO
// ------------------------------------------------------------

/**
 * Qual wipe este servidor está esperando, agora.
 *
 * A ordem — execução em curso, depois agenda — está no cabeçalho.
 * `null` = não há wipe à vista.
 */
export function nextWipe(serverId: string, deps: NextWipeDeps, now: number): NextWipe | null {
  const timeZone = zoneOf(deps, serverId);
  const run = deps.runs.running().find((candidate) => candidate.serverId === serverId);

  if (run !== undefined) {
    return {
      wipeAt: run.wipeAt,
      kind: run.kind,
      bpPolicy: run.bpPolicy,
      // Depois do passo `configurar` o mundo novo já está gravado, e
      // ele é a resposta mais certa que existe: a fila já foi
      // consumida, e olhar para a fila agora mostraria o mundo do
      // wipe SEGUINTE.
      map: run.mapAfter === null ? mapOfRun(deps, run) : { source: 'world', world: run.mapAfter },
      timeZone,
      planId: run.planId,
      running: true,
    };
  }

  const plan = nextPendingPlan(deps.schedule.listPlans(serverId, { from: now }));

  if (plan === null) {
    return null;
  }

  return {
    wipeAt: plan.scheduledAt,
    kind: plan.kind,
    bpPolicy: plan.bpPolicy,
    map: mapOfPlan(deps, plan),
    timeZone,
    planId: plan.id,
    running: plan.status === 'running',
  };
}

/**
 * O próximo wipe que ainda vai acontecer.
 *
 * `planned` E `running`, exatamente como o `isPending` da aba
 * Geral (panel/src/components/wipe/labels.ts): é essa igualdade que
 * faz a frase do chat e a contagem da tela mostrarem o mesmo
 * número.
 *
 * ####  `absorbed` NÃO É O PRÓXIMO WIPE  ####
 *
 * E ele pode muito bem ser o mais PRÓXIMO: com a colisão em
 * `absorb`, o wipe de cadência de quarta é cancelado pelo forçado
 * de quinta e continua na tabela, na frente dele. Anunciá-lo seria
 * prometer data, contagem e política de blueprint de um wipe que
 * não vai acontecer. `done`, `skipped` e `failed` ficam de fora
 * pela razão óbvia — eles explicam um dia sem wipe, e não são
 * anunciados.
 */
export function nextPendingPlan(plans: readonly WipePlan[]): WipePlan | null {
  return plans.find((plan) => plan.status === 'planned' || plan.status === 'running') ?? null;
}

/**
 * O mundo que a execução EM CURSO vai pôr no ar, antes de
 * `configurar` gravá-lo.
 *
 * ####  A JANELA DOS AVISOS É QUASE TODA AQUI  ####
 *
 * A execução começa com a antecedência do maior aviso (o padrão
 * começa em 1440 minutos) e só decide o mundo no `configurar`,
 * minutos antes de subir. Nesse dia inteiro `mapAfter` é `null` —
 * e é exatamente quando o chat e a tela do jogo estão anunciando.
 * Perguntar à fila aqui faria um plano `keep` anunciar por 24 h a
 * cabeça de uma fila que ele nem vai tocar.
 *
 * Sem plano — o "WIPAR AGORA" com hora marcada — não há o que
 * respeitar, e a resposta é a fila.
 */
export function mapOfRun(deps: NextWipeDeps, run: WipeRunRecord): NextWipeMap {
  const plan = run.planId === null ? null : deps.schedule.getPlan(run.serverId, run.planId);

  return plan === null
    ? mapOfPool(deps, run.serverId, run.kind === 'forced')
    : mapOfPlan(deps, plan);
}

/**
 * O mundo que ESTE plano põe no ar.
 *
 * As quatro origens do `mapSource`, e não "a cabeça da fila
 * sempre": um plano `keep` não consome a fila, e um `fixed` aponta
 * para uma entrada que pode estar em qualquer posição.
 *
 * ####  ESTA FUNÇÃO É A ÚNICA DECISÃO QUE EXISTE  ####
 *
 * Quem anuncia (o chat, o passo `avisar`, a tela CALENDÁRIO) e
 * quem executa (o passo `configurar`, em wipe/run.ts) chamam
 * ESTA. O executor consome o que ela escolheu — nunca escolhe de
 * novo. Uma segunda escolha, por mais parecida que fosse, é como
 * o agente passou a prometer um mundo na tela e a subir outro.
 */
export function mapOfPlan(deps: Pick<NextWipeDeps, 'mapPool'>, plan: WipePlan): NextWipeMap {
  const forced = plan.kind === 'forced';

  if (plan.mapSource === 'keep') {
    return { source: 'keep' };
  }

  if (plan.mapSource === 'fixed' && plan.mapPoolId !== null) {
    const chosen = deps.mapPool.get(plan.serverId, plan.mapPoolId);

    // ####  A ENTRADA APONTADA PODE NÃO SERVIR MAIS  ####
    //
    // Ela some da fila, é consumida por um wipe anterior, fica
    // presa em `generating`, ou é um `.map` custom sem a marca de
    // compatibilidade num wipe FORÇADO — e este último é o que
    // deixa o servidor sem subir na madrugada. Em qualquer um dos
    // casos o plano cai para a fila, e a fila vazia sorteia: um
    // ponteiro velho não pode ser motivo para o servidor não zerar.
    if (chosen !== null && usableForWipe(chosen, forced)) {
      return { source: 'entry', entry: chosen };
    }
  }

  return mapOfPool(deps, plan.serverId, forced);
}

/**
 * A cabeça da fila pronta.
 *
 * `forced` importa: num wipe forçado o `next` PULA o mapa custom
 * sem marca de compatibilidade — o arquivo `.map` de ontem não
 * sobe na versão de amanhã, e prometê-lo ao VIP seria vender a
 * prévia de um mundo que não vai entrar.
 */
export function mapOfPool(
  deps: Pick<NextWipeDeps, 'mapPool'>,
  serverId: string,
  forced: boolean,
): NextWipeMap {
  const entry = deps.mapPool.next(serverId, forced);

  return entry === null ? UNDECIDED_MAP : { source: 'entry', entry };
}

/**
 * O fuso da agenda deste servidor.
 *
 * Um servidor que não existe mais, ou um banco que ainda não tem a
 * linha, não pode derrubar uma frase de chat nem uma tela: a
 * leitura falha para o UTC, e o pior que acontece é a hora sair no
 * fuso errado numa frase — e não uma mensagem a menos.
 */
export function zoneOf(deps: Pick<NextWipeDeps, 'schedule'>, serverId: string): string {
  try {
    return deps.schedule.getSettings(serverId).cadence.timeZone;
  } catch {
    return 'UTC';
  }
}
