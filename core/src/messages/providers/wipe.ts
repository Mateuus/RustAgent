// ============================================================
//  providers/wipe.ts  -  `{wipe.faltam}`, `{wipe.quando}`,
//  `{wipe.mapa}` e `{wipe.bp}`.
//
//  Este é o lado "leitura" da ponte do Docs/16 §11. O módulo de
//  mensagens NÃO pode saber o que é um wipe, e o módulo de wipe
//  NÃO pode reimplementar envio de chat: o que liga os dois são
//  duas interfaces pequenas — o `Broadcaster` (transporte, em
//  game/broadcast.ts) e este provedor (leitura). Nada em
//  `messages/` importa este arquivo; quem o registra no
//  `VariableRegistry` é o index.ts, na subida.
//
//  ------------------------------------------------------------
//  ####  UMA VERDADE SÓ SOBRE "QUANDO É O PRÓXIMO WIPE"  ####
//
//  A mesma conta serve os dois caminhos que o Docs/16 §11 põe lado
//  a lado: o aviso automático do passo `avisar` (wipe/announce.ts)
//  e a mensagem editorial que o admin escreveu com `{wipe.faltam}`
//  dentro. Os dois passam por AQUI, e é o que garante o aceite da
//  frente — a frase do chat mostra o mesmo número que a aba Geral.
//
//  Por isso `currentWipeFacts` olha primeiro para a EXECUÇÃO em
//  curso e só depois para a agenda:
//
//    1. um `wipe_run` `running` neste servidor  ->  é ELE
//    2. senão, o primeiro plano pendente à frente
//    3. senão, "sem wipe agendado"
//
//  O passo 1 não é preciosismo. Enquanto o wipe executa, o plano
//  dele está `running` e o `nextPlan` do repositório o ignora de
//  propósito (ele responde "o que executar em seguida", não "o que
//  contar ao jogador"). E o "WIPAR AGORA" com hora marcada nem
//  plano tem: sem o passo 1, o aviso de 15 minutos sairia dizendo
//  "WIPE em sem wipe agendado".
//
//  ------------------------------------------------------------
//  ####  NUNCA VAZIO  ####
//
//  Servidor sem agenda devolve a FRASE "sem wipe agendado", e não
//  string vazia (Docs/16 §13, e a regra 3 da Frente F). Vazio é a
//  única resposta que nunca ajuda ninguém: some do meio da frase e
//  o admin descobre semanas depois, ou nunca.
//
//  Já um nome que não é nosso — `{wipe.faltan}` — devolve `null`,
//  e o registro o deixa LITERAL no chat. Feio de propósito: o
//  admin vê e conserta em dez segundos.
//
//  ------------------------------------------------------------
//  ####  A SEED NÃO ENTRA EM `{wipe.mapa}`  ####
//
//  Mostrar a seed é diferente de mostrar a imagem (Docs/16 §9.3):
//  com a seed o jogador abre o RustMaps e estuda cada monumento
//  dias antes do wipe. `{wipe.mapa}` diz a FORMA do mundo —
//  `procedural 4000` —, que é o exemplo da tabela do Docs/16 §10.
//  Quem quiser vender o acesso à seed tem a régua de VIP da tela
//  do jogo, e não uma variável que vai para o chat de todo mundo.
// ============================================================

import type { WipeRunRecord, WipeWorld } from '../../db/wipe-runs-repository.js';
import type { WipeScheduleReader } from '../../db/wipe-schedule-repository.js';
import type { BpPolicy, MapPoolEntry, WipePlan, WipePlanKind } from '../../types/wipe.js';
import { localDateInZone, weekdayInZone, zoneOffsetMinutes } from '../../wipe/schedule.js';
import type { VariableRegistry } from '../variables.js';

// ------------------------------------------------------------
//  §1  AS PALAVRAS
// ------------------------------------------------------------

/** O prefixo da família. `{wipe.faltam}` é `wipe` + `faltam`. */
export const WIPE_VARIABLE_NAMESPACE = 'wipe';

/** Os quatro nomes, para a tela listar e para o teste conferir. */
export const WIPE_VARIABLES = ['faltam', 'quando', 'mapa', 'bp'] as const;

/**
 * A resposta de um servidor sem wipe à vista.
 *
 * É uma frase, e não vazio: ver o cabeçalho.
 */
export const NO_WIPE_SCHEDULED = 'sem wipe agendado';

/** A fila vazia não trava wipe nenhum — o agente sorteia. */
export const MAP_DRAWN_ON_THE_SPOT = 'sorteado na hora';

/** Os dias da semana como o jogador brasileiro os lê. */
const WEEKDAY_NAMES = [
  'domingo',
  'segunda',
  'terça',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
] as const;

/** O que cada política de blueprint diz ao jogador, em uma palavra. */
const BP_POLICY_WORDS: Readonly<Record<BpPolicy, string>> = {
  keep: 'mantidos',
  wipe: 'zerados',
  wipe_except_vip: 'mantidos só para quem tem VIP',
};

// ------------------------------------------------------------
//  §2  OS FATOS DE UM WIPE
// ------------------------------------------------------------

/**
 * Tudo o que as quatro variáveis precisam saber, já resolvido.
 *
 * Um tipo pequeno de propósito: ele é o que separa "ler o banco"
 * de "escrever a frase", e é o que permite o teste conferir cada
 * formato sem montar repositório nenhum.
 */
export interface WipeFacts {
  /** Quando o mundo zera, em epoch ms UTC. */
  readonly wipeAt: number;
  readonly kind: WipePlanKind;
  readonly bpPolicy: BpPolicy;
  /**
   * O mundo que entra, em uma frase. `null` = ainda não decidido,
   * e aí a variável diz que o agente sorteia na hora.
   */
  readonly map: string | null;
  /** A zona IANA em que `{wipe.quando}` é escrito. */
  readonly timeZone: string;
}

// ------------------------------------------------------------
//  §3  OS FORMATOS  (funções puras — é o que o teste cobre)
// ------------------------------------------------------------

/**
 * Quanto falta, por extenso: `6 dias e 4 horas`.
 *
 * ####  A CONTA ARREDONDA PARA O MINUTO MAIS PRÓXIMO  ####
 *
 * E não é detalhe de gosto. O aviso de uma hora sai de um `await`
 * que acorda alguns milissegundos DEPOIS da hora exata: com
 * truncamento, "faltam 60 minutos" viraria "59 minutos" numa fala
 * cujo motivo de existir é dizer *uma hora*. Arredondar devolve o
 * número que o admin configurou, e nas contagens longas dá o mesmo
 * resultado que a aba Geral — que corta em dias e horas.
 */
export function formatWipeCountdown(remainingMs: number): string {
  if (remainingMs <= 0) {
    return 'agora';
  }

  const totalMinutes = Math.round(remainingMs / 60_000);

  if (totalMinutes === 0) {
    return 'menos de um minuto';
  }

  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return join(plural(days, 'dia', 'dias'), hours > 0 ? plural(hours, 'hora', 'horas') : null);
  }

  if (hours > 0) {
    return join(
      plural(hours, 'hora', 'horas'),
      minutes > 0 ? plural(minutes, 'minuto', 'minutos') : null,
    );
  }

  return plural(minutes, 'minuto', 'minutos');
}

/**
 * A data por extenso, NO FUSO DO SERVIDOR: `quinta, 03/09 às 16:00`.
 *
 * O fuso vem da configuração da agenda, e não do relógio do host:
 * um agente rodando numa VPS em UTC anunciaria "às 19:00" um wipe
 * que o jogador brasileiro vê marcado para as 16:00, e os dois
 * estariam certos — que é o pior tipo de divergência.
 *
 * O ano fica de fora de propósito. Um wipe é uma coisa de dias, e
 * `03/09/2026` no meio de uma frase de chat é ruído.
 */
export function formatWipeMoment(epochMs: number, timeZone: string): string {
  const date = localDateInZone(epochMs, timeZone);
  const weekday = WEEKDAY_NAMES[weekdayInZone(epochMs, timeZone)] ?? '';

  // O instante deslocado para o fuso e lido como se fosse UTC: é a
  // mesma volta que o `zonedTimeToUtc` do wipe/schedule.ts dá, e
  // ela existe para não escrever uma segunda matemática de fuso
  // neste projeto (Docs/17, Frente E, regra 5).
  const local = new Date(epochMs + zoneOffsetMinutes(epochMs, timeZone) * 60_000);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return (
    `${weekday}, ${pad(date.day)}/${pad(date.month)} às ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  );
}

/** O que o wipe faz com o que o jogador aprendeu, em uma palavra. */
export function describeBpPolicy(policy: BpPolicy): string {
  return BP_POLICY_WORDS[policy];
}

/**
 * O mundo que entra, em uma frase curta.
 *
 * `null` quando não há mundo escolhido — a fila vazia é normal, e
 * quem lê decide o que dizer no lugar.
 */
export function describeMapEntry(entry: Pick<MapPoolEntry, 'kind' | 'level' | 'worldSize'>): string {
  if (entry.kind === 'custom') {
    return entry.level === null || entry.level === '' ? 'mapa custom' : `mapa ${entry.level}`;
  }

  return describeProcedural(entry.level, entry.worldSize);
}

/** O mesmo, para o mundo já gravado numa execução (`map_after`). */
export function describeMapWorld(world: WipeWorld): string {
  const url = world.levelUrl ?? null;

  if (url !== null && url !== '') {
    return 'mapa custom';
  }

  return describeProcedural(world.level, world.worldSize);
}

function describeProcedural(level: string | null, worldSize: number | null): string {
  const name = level === null || level === '' || level === 'Procedural Map' ? 'procedural' : level;

  return worldSize === null || worldSize <= 0 ? name : `${name} ${String(worldSize)}`;
}

// ------------------------------------------------------------
//  §4  A RESOLUÇÃO
// ------------------------------------------------------------

/**
 * Um nome da família `wipe` vira texto.
 *
 * `rest` é o que vem depois do ponto, já em minúsculas (quem
 * separa é o `VariableRegistry`). `null` = "não é meu", e o
 * registro deixa o marcador literal no chat.
 *
 * `facts === null` NÃO devolve `null`: `{wipe.faltam}` num
 * servidor sem agenda é uma pergunta que o provedor entende e não
 * tem resposta agora, e a resposta certa para isso é uma frase.
 */
export function resolveWipeVariable(
  rest: string,
  facts: WipeFacts | null,
  now: number,
): string | null {
  switch (rest) {
    case 'faltam':
      return facts === null ? NO_WIPE_SCHEDULED : formatWipeCountdown(facts.wipeAt - now);

    case 'quando':
      return facts === null ? NO_WIPE_SCHEDULED : formatWipeMoment(facts.wipeAt, facts.timeZone);

    case 'mapa':
      return facts === null ? NO_WIPE_SCHEDULED : (facts.map ?? MAP_DRAWN_ON_THE_SPOT);

    case 'bp':
      return facts === null ? NO_WIPE_SCHEDULED : describeBpPolicy(facts.bpPolicy);

    default:
      // `{wipe.faltan}` sai assim mesmo. Ver o cabeçalho.
      return null;
  }
}

// ------------------------------------------------------------
//  §5  DE ONDE OS FATOS VÊM
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

export interface WipeVariablesDeps {
  readonly schedule: WipeScheduleReader;
  readonly runs: WipeRunsReader;
  readonly mapPool: WipeMapPoolReader;
}

/**
 * Qual wipe as variáveis estão descrevendo, agora, neste servidor.
 *
 * A ordem — execução em curso, depois agenda — está explicada no
 * cabeçalho. `null` = não há wipe à vista.
 */
export function currentWipeFacts(
  serverId: string,
  deps: WipeVariablesDeps,
  now: number,
): WipeFacts | null {
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
      map:
        run.mapAfter === null
          ? mapOfPool(deps, serverId, run.kind === 'forced')
          : describeMapWorld(run.mapAfter),
      timeZone,
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
  };
}

/**
 * O próximo wipe que ainda vai acontecer.
 *
 * `planned` E `running`, exatamente como o `isPending` da aba
 * Geral (panel/src/components/wipe/labels.ts): é essa igualdade que
 * faz a frase do chat e a contagem da tela mostrarem o mesmo
 * número. Os outros estados — `done`, `skipped`, `failed`,
 * `absorbed` — estão na tabela para explicar um dia sem wipe, e não
 * para serem anunciados.
 */
function nextPendingPlan(plans: readonly WipePlan[]): WipePlan | null {
  return plans.find((plan) => plan.status === 'planned' || plan.status === 'running') ?? null;
}

function mapOfPlan(deps: WipeVariablesDeps, plan: WipePlan): string | null {
  if (plan.mapSource === 'keep') {
    return 'o mesmo mapa de agora';
  }

  if (plan.mapSource === 'fixed' && plan.mapPoolId !== null) {
    const chosen = deps.mapPool.get(plan.serverId, plan.mapPoolId);

    return chosen === null ? null : describeMapEntry(chosen);
  }

  return mapOfPool(deps, plan.serverId, plan.kind === 'forced');
}

function mapOfPool(deps: WipeVariablesDeps, serverId: string, forced: boolean): string | null {
  const entry = deps.mapPool.next(serverId, forced);

  return entry === null ? null : describeMapEntry(entry);
}

/**
 * O fuso da agenda deste servidor.
 *
 * Um servidor que não existe mais, ou um banco que ainda não tem a
 * linha, não pode derrubar uma frase de chat: a leitura falha para
 * o UTC, e o pior que acontece é a hora sair no fuso errado numa
 * frase — e não uma mensagem a menos.
 */
function zoneOf(deps: WipeVariablesDeps, serverId: string): string {
  try {
    return deps.schedule.getSettings(serverId).cadence.timeZone;
  } catch {
    return 'UTC';
  }
}

// ------------------------------------------------------------
//  §6  O REGISTRO
// ------------------------------------------------------------

/**
 * Liga `{wipe.*}` ao registro de variáveis.
 *
 * Chamada do index.ts, nunca de dentro de `messages/` — o módulo
 * de mensagens continua sem saber o que é um wipe.
 *
 * ####  A FAMÍLIA E OS QUATRO NOMES, OS DOIS  ####
 *
 * A FAMÍLIA é o que faz `{wipe.tipo}` caber amanhã sem tocar em
 * `messages/variables.ts`. Os NOMES EXATOS existem por um motivo
 * de tela: o editor de mensagens lista o que o registro conhece
 * (`GET /api/messages`), e um `{wipe.…}` genérico não é clicável
 * nem ensina que a variável se chama `faltam`. O admin precisa
 * descobrir a variável no lugar em que ele escreve a frase.
 *
 * O nome exato ganha do namespace na hora de resolver, e os dois
 * chamam o MESMO resolvedor: não há como um responder uma coisa e
 * o outro responder outra.
 *
 * O relógio é injetável porque o teste precisa de um instante fixo:
 * "faltam 6 dias e 4 horas" só é conferível contra um `now`
 * conhecido.
 */
export function registerWipeVariables(
  registry: VariableRegistry,
  deps: WipeVariablesDeps,
  now: () => number = Date.now,
): void {
  const resolve = (rest: string, serverId: string): string | null => {
    const instant = now();

    // O `facts` só é lido quando o nome É nosso: um `{wipe.faltan}`
    // no meio de uma mensagem não pode custar duas consultas ao
    // banco a cada trinta segundos.
    if (!(WIPE_VARIABLES as readonly string[]).includes(rest)) {
      return null;
    }

    return resolveWipeVariable(rest, currentWipeFacts(serverId, deps, instant), instant);
  };

  registry.setNamespace(WIPE_VARIABLE_NAMESPACE, (rest, context) =>
    resolve(rest, context.serverId),
  );

  for (const name of WIPE_VARIABLES) {
    registry.set(`${WIPE_VARIABLE_NAMESPACE}.${name}`, (context) =>
      resolve(name, context.serverId),
    );
  }
}

// ------------------------------------------------------------
//  Miudezas
// ------------------------------------------------------------

function plural(value: number, one: string, many: string): string {
  return `${String(value)} ${value === 1 ? one : many}`;
}

function join(head: string, tail: string | null): string {
  return tail === null ? head : `${head} e ${tail}`;
}
