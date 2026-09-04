// ============================================================
//  commands.ts  -  o botão que o admin aperta NO SITE acontece
//  nesta máquina.
//
//  ####  QUEM PUXA É O AGENTE  ####
//
//  O site não chama o agente, e não vai chamar: o `agents.base_url`
//  de lá é fixado no PRIMEIRO beacon e nunca mais atualizado, ele é
//  HTTP puro montado do IP do socket, e esta máquina fica atrás do
//  NAT de uma conexão residencial. Um push falharia SEMPRE, e o
//  sintoma seria "o botão Reiniciar não faz nada" — sem nada dizendo
//  por quê. O pull de 10 s custa 6 req/min e não tem nenhuma dessas
//  três condições.
//
//  ####  AT-MOST-ONCE, E ISSO CUSTA CADA LINHA DAQUI  ####
//
//  A fila é do SITE: a linha sai dela no próprio `claim`, com um
//  `leaseToken` carimbado. Deste lado, três coisas guardam o
//  desenho:
//
//    1. o id vai para o DISCO antes de a operação começar
//       (`pm2 restart` apaga memória, e a operação que fica sem
//       resposta é justamente a que derrubou o agente junto);
//    2. o agente NUNCA re-executa por conta própria — comando
//       puxado é comando consumido, e quem tenta de novo é o admin,
//       gerando um `CMD-…` novo;
//    3. não existe fila local: operação já rodando vira `refused` +
//       `AGENT_BUSY`, porque a fila que ninguém vê é a que
//       ressuscita ordens de que o admin já desistiu.
//
//  ####  DOIS RELÓGIOS DECIDEM O PRAZO, E O MENOR VENCE  ####
//
//  O beacon já convive com ±120 s de diferença entre esta máquina e
//  o site, e o retrato descarta um `at` fora de ±10 min marcando
//  `agentClockSkewed`: skew de minutos é MEDIDO, não hipótese. Por
//  isso o prazo é o menor entre o `expiresAt` absoluto, o `ttlMs`
//  relativo e um teto local de 60 s — e o caso que o teto mata é o
//  pior de todos: o admin clica Reiniciar, nada acontece, ele
//  resolve de outro jeito, e quarenta minutos depois o comando
//  velho reinicia um servidor cheio.
//
//  ####  NADA AQUI LANÇA  ####
//
//  Roda num relógio. Um `throw` para a fila em silêncio.
//
//  Ver Docs\22-COMANDOS-E-CONFIG-DO-SITE.md §2.2, §2.3, §3 e §4.
// ============================================================

import type { SiteCommandsRepository, SiteCommandState } from '../db/site-commands-repository.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import { toError } from '../util.js';
import type { ClaimedCommandBody, CommandAck, SiteClient } from './client.js';

/**
 * A allowlist. TRÊS, e este agente conhece OITO.
 *
 * ####  OS CINCO QUE FALTAM NÃO SÃO ESQUECIMENTO  ####
 *
 * `server-install` e `server-update` baixam 6 GB e reescrevem a
 * pasta; `oxide-install` reescreve arquivos com o servidor parado;
 * `server-auto-update` é agendamento local, não ordem pontual; e
 * `wipe-run` APAGA O MUNDO. Os cinco continuam disparáveis — só que
 * pelo painel local, por quem está olhando para a máquina.
 *
 * `wipe-run` não viria nem que alguém quisesse: a pré-condição em
 * `ops/service.ts` recusa qualquer chamada que não venha de
 * `POST /wipe/runs`, que exige o `identity` DIGITADO e uma
 * `Idempotency-Key` — duas coisas que uma rota remota não tem como
 * exigir. E RCON cru também não atravessa este canal: "execute este
 * texto no meu servidor" é execução remota arbitrária com outro
 * nome.
 *
 * Quem for acrescentar um kind aqui: o `kinds` do retrato periódico
 * (`site/status.ts`) manda os OITO para o site desenhar o menu, e
 * ele nunca autorizou nada. Esta lista é a autorização.
 */
export const SITE_COMMAND_KINDS = ['server-start', 'server-stop', 'server-restart'] as const;

export type SiteCommandKind = (typeof SITE_COMMAND_KINDS)[number];

/** O formato do id é do SITE. Mesmo molde do `DLV-` das entregas. */
export const COMMAND_ID_PATTERN = /^CMD-[0-9a-f]{12}$/;

/**
 * A cadência.
 *
 * É o teto do critério de aceite — "de enfileirado a executando em
 * ≤10 s". Mais rápido gasta cota por nada; mais devagar faz o admin
 * clicar duas vezes.
 */
export const DEFAULT_COMMAND_POLL_MS = 10_000;

/**
 * Quantos comandos a rodada pede.
 *
 * ####  UM, PORQUE UM É O QUE CABE EXECUTAR  ####
 *
 * O contrato aceita até 10, e pedir mais parece de graça — não é:
 * enquanto o primeiro roda, todo excedente vira `refused` +
 * `AGENT_BUSY`, que é uma recusa que o ADMIN tem de desfazer
 * clicando de novo. Deixado na fila do site, o mesmo comando é
 * entregue na volta seguinte, dez segundos depois, e executa.
 *
 * O agente ainda trata o lote maior: o site pode mandar o que
 * quiser, e o excedente é recusado com `AGENT_BUSY` — o que é
 * verdade, e não um palpite.
 */
export const COMMAND_CLAIM_LIMIT = 1;

/**
 * O teto LOCAL, por cima do `expiresAt` do site.
 *
 * "Não executo o que puxei há mais de 60 s" — mesmo que o prazo do
 * site ainda permita. Ver o cabeçalho.
 */
export const COMMAND_LOCAL_TTL_MS = 60_000;

/** O lote do ACK. Dez, e não os cinquenta das entregas. */
export const COMMAND_ACK_LIMIT = 10;

/**
 * De quanto em quanto tempo a MESMA linha de erro volta ao log.
 *
 * Enquanto a rota não existir do outro lado, o 404 chega a cada 10
 * s, por servidor. Sem este freio o log vira uma coluna só de uma
 * linha repetida — e é nele que se procura outra coisa.
 */
export const LOG_REPEAT_MS = 10 * 60_000;

/**
 * O VOCABULÁRIO FECHADO do `reason`. Dez valores, e nenhum a mais.
 *
 * Um valor fora dele é 400 do lado do site, e um 400 num ACK deixa a
 * linha pendurada — o admin fica olhando "executando" para um
 * comando que já morreu.
 */
export const COMMAND_REASONS = new Set([
  'OPERATION_NOT_ALLOWED',
  'SERVER_RUNNING',
  'SERVER_NOT_RUNNING',
  'RCON_UNAVAILABLE',
  'RCON_TIMEOUT',
  'NOT_INSTALLED',
  'SERVER_DISABLED',
  'COMMAND_EXPIRED',
  'AGENT_BUSY',
  'UNKNOWN_KIND',
]);

/**
 * A última peneira, imediatamente antes do fio.
 *
 * ####  ELA EXISTE PARA O `reason` QUE VEIO DO BANCO  ####
 *
 * Os `reason` montados aqui já saem do vocabulário — a tabela de
 * tradução garante isso. O que não passa por ela é o reenvio: o
 * `reason` de uma linha gravada por uma versão anterior deste
 * arquivo, ou por uma edição no `.db`, viaja como está. Um valor
 * fora do vocabulário é 400 PARA O LOTE, e o lote inteiro fica sem
 * ser aplicado — o desfecho de um comando some por causa do
 * carimbo de outro.
 *
 * `refused` é o único status que EXIGE `reason`. Sem um válido, ele
 * vira `failed` — que aceita a ausência, e diz menos em vez de dizer
 * errado.
 */
export function sanitizeAck(ack: CommandAck): CommandAck {
  if (ack.reason === undefined || COMMAND_REASONS.has(ack.reason)) {
    return ack;
  }

  const { reason: _reason, ...rest } = ack;

  return { ...rest, status: 'failed' };
}

/**
 * O código interno do agente NÃO é o `reason` do contrato.
 *
 * ####  ESTA TABELA É O PONTO ÚNICO DA TRADUÇÃO  ####
 *
 * Dois dos códigos daqui têm nome diferente do contrato para a mesma
 * coisa — `SERVER_ALREADY_RUNNING` é `SERVER_RUNNING` lá, e
 * `SERVER_NOT_INSTALLED` é `NOT_INSTALLED` —, e um `catch` que
 * repasse `err.code` cru manda para o site um valor fora do
 * vocabulário fechado. É a armadilha mais provável deste trabalho, e
 * ela é MEDIDA: os dois códigos existem, com esses nomes, em
 * `ops/service.ts:271` e `servers/supervisor.ts:469`.
 */
const REASON_OF: Readonly<Record<string, string>> = {
  OPERATION_NOT_ALLOWED: 'OPERATION_NOT_ALLOWED',
  // O nome muda AQUI, e só aqui.
  SERVER_ALREADY_RUNNING: 'SERVER_RUNNING',
  SERVER_RUNNING: 'SERVER_RUNNING',
  SERVER_NOT_RUNNING: 'SERVER_NOT_RUNNING',
  RCON_UNAVAILABLE: 'RCON_UNAVAILABLE',
  RCON_TIMEOUT: 'RCON_TIMEOUT',
  // E aqui.
  SERVER_NOT_INSTALLED: 'NOT_INSTALLED',
  NOT_INSTALLED: 'NOT_INSTALLED',
  // A trava por recurso do `ops/service.ts` é a autoridade sobre
  // "um de cada vez": este canal só a respeita e diz por quê.
  OPERATION_IN_PROGRESS: 'AGENT_BUSY',
};

/**
 * O `reason` do contrato para um erro daqui.
 *
 * `null` = não está no mapa, e aí o ACK vai `failed` SEM `reason` —
 * nunca um `reason` inventado.
 */
export function reasonOf(error: unknown): string | null {
  const code =
    error instanceof ApiError
      ? error.code
      : typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : '';

  return REASON_OF[code] ?? null;
}

/**
 * O instante em que este comando deixa de valer, no relógio LOCAL.
 *
 * O menor dos três: o `expiresAt` absoluto do site, o `ttlMs`
 * relativo, e o teto local. Confiar só no `expiresAt` faz um relógio
 * atrasado executar comando vencido; confiar só no `ttlMs` faz uma
 * resposta que demorou na rede valer mais do que devia.
 *
 * ####  OS DOIS RELATIVOS CONTAM DO `pulledAt`, E NÃO DE AGORA  ####
 *
 * Se contassem de agora, andariam junto com o relógio: a cada
 * checagem o prazo se renovaria, e o teto local — que existe para
 * dizer "não executo o que puxei há mais de 60 s" — nunca cortaria
 * nada. O instante de referência é o da RESPOSTA do claim, que é
 * quando o comando passou a ser nosso.
 *
 * Prazo ausente ou ilegível não vira "para sempre": sobra o teto
 * local, que é o piso de segurança deste laço.
 */
export function deadlineOf(
  command: { readonly expiresAt?: string; readonly ttlMs?: number },
  pulledAt: number,
): number {
  const now = pulledAt;
  const candidates = [now + COMMAND_LOCAL_TTL_MS];
  const absolute = command.expiresAt === undefined ? NaN : Date.parse(command.expiresAt);

  if (Number.isFinite(absolute)) {
    candidates.push(absolute);
  }

  if (typeof command.ttlMs === 'number' && Number.isFinite(command.ttlMs)) {
    candidates.push(now + command.ttlMs);
  }

  return Math.min(...candidates);
}

/** O status do ACK que reconta um desfecho já gravado em disco. */
function ackStatusOf(state: SiteCommandState): CommandAck['status'] {
  if (state === 'executed' || state === 'refused') {
    return state;
  }

  // `indeterminate` cai aqui junto de `failed`, e é o certo: o
  // agente caiu no meio, "executou" seria mentira e não há `reason`
  // no vocabulário para "não sei". `failed` sem `reason` diz o que
  // dá para dizer, e o `operationId` guardado leva ao log da
  // tentativa.
  return 'failed';
}

/** O que o agente precisa saber fazer para executar um comando. */
export interface CommandExecution {
  /** O id da `operation` local. Vai no ACK e liga os dois lados. */
  readonly operationId: string;
  /** Resolve quando a operação termina — de qualquer jeito. */
  readonly done: Promise<{
    readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    readonly message: string | null;
  }>;
}

export interface SiteCommandsOptions {
  readonly client: SiteClient;
  readonly repository: SiteCommandsRepository;
  /** O servidor LOCAL que executa: este canal é o dele. */
  readonly serverId: string;
  /** O agente cuida deste servidor? `false` ⇒ `SERVER_DISABLED`. */
  readonly enabled: () => boolean;
  /** O jogo está em disco? `false` ⇒ `NOT_INSTALLED`. */
  readonly installed: () => boolean;
  /**
   * Dispara a operação — o MESMO caminho do painel local.
   *
   * Ele lança `ApiError` nas pré-condições, e é dele que sai a
   * tradução do §7. Um segundo caminho de execução aqui dentro seria
   * uma operação sem trava, sem log e sem id.
   */
  readonly execute: (kind: SiteCommandKind) => Promise<CommandExecution>;
  readonly logger: Logger;
  readonly pollMs?: number;
  readonly limit?: number;
  readonly now?: () => number;
}

export class SiteCommands {
  readonly #options: SiteCommandsOptions;
  readonly #now: () => number;
  readonly #limit: number;

  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #lastLogged: { message: string; at: number } | null = null;

  constructor(options: SiteCommandsOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
    this.#limit = Math.min(10, Math.max(1, options.limit ?? COMMAND_CLAIM_LIMIT));
  }

  /**
   * Carimba as linhas órfãs e liga o relógio.
   *
   * ####  A VARREDURA DO BOOT NÃO É ENFEITE  ####
   *
   * O registro de operações é de MEMÓRIA: uma operação em curso não
   * sobrevive ao processo. Então toda linha em `claimed` encontrada
   * aqui é um comando cujo fim ninguém sabe — e deixá-la assim seria
   * deixá-la parecida com trabalho por fazer. Ela vira
   * `indeterminate`, que NUNCA re-executa e ACKa `failed`.
   */
  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#settleOrphans();

    this.#timer = setInterval(
      () => {
        void this.poll();
      },
      this.#options.pollMs ?? DEFAULT_COMMAND_POLL_MS,
    );
    // Um relógio de conveniência não pode ser a razão de o agente
    // não conseguir desligar — a mesma disciplina do beacon.
    this.#timer.unref();

    void this.poll();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma rodada: reenvia o que ficou sem confirmação, puxa a fila,
   * executa o que dá e conta o desfecho.
   *
   * Ela DURA o tempo da operação — um `server-restart` inteiro, se
   * for o caso. É de propósito: é o que faz "um comando por vez"
   * acontecer sem uma fila local, que é o que a regra 4 proíbe. As
   * rodadas do relógio que caírem nesse meio tempo não fazem nada.
   *
   * Nunca lança.
   */
  async poll(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      await this.#resend();

      const result = await this.#options.client.claimCommands(this.#limit);

      if (!result.ok) {
        this.#classify(result.status, result.code);

        return;
      }

      // O instante em que estes comandos passaram a ser nossos. É
      // dele que contam o `ttlMs` e o teto local — ver `deadlineOf`.
      const pulledAt = this.#now();
      const commands = result.body.commands ?? [];
      // Um só executa; o resto do lote é recusado com a verdade.
      // Uma recusa NÃO liga esta chave: nada rodou, e o comando
      // seguinte merece a mesma chance que o primeiro teve.
      let busy = false;

      for (const raw of commands) {
        const handled = await this.#handle(raw, pulledAt, busy);

        busy = busy || handled.ran;

        if (handled.ack !== null) {
          await this.#ack([handled.ack]);
        }
      }
    } catch (error) {
      this.#options.logger.error(
        { serverId: this.#options.serverId, err: toError(error) },
        'command round failed',
      );
    } finally {
      this.#running = false;
    }
  }

  /**
   * Um comando, do começo ao fim.
   *
   * `ack: null` = ele não produz ACK nenhum (não dá para responder);
   * qualquer outra coisa é o desfecho FINAL — o `accepted` já saiu
   * de dentro daqui, na hora, porque sem ele o painel do site não
   * distingue "o agente não viu" de "está rodando".
   *
   * `ran` = a operação foi DISPARADA (ou tentada). É o que faz o
   * resto do lote virar `AGENT_BUSY` — e uma recusa não o liga.
   */
  async #handle(
    raw: ClaimedCommandBody,
    pulledAt: number,
    busy: boolean,
  ): Promise<{ readonly ack: CommandAck | null; readonly ran: boolean }> {
    const id = typeof raw.id === 'string' ? raw.id : '';
    const leaseToken = typeof raw.leaseToken === 'string' ? raw.leaseToken : '';

    if (!COMMAND_ID_PATTERN.test(id) || leaseToken === '') {
      // Sem id legível não há a quem responder; sem `leaseToken` o
      // ACK volta em `unknown` e não muda nada do outro lado. Nos
      // dois casos o que resta é o log.
      this.#options.logger.error(
        { serverId: this.#options.serverId, raw },
        'the site sent a command we cannot answer',
      );

      return { ack: null, ran: false };
    }

    // ---- (a) já conhecemos este id? ----
    //
    // O ACK sai com o leaseToken NOVO, e não com o guardado: quem
    // fecha a linha de HOJE é o token desta reivindicação.
    const known = this.#options.repository.get(id);

    if (known !== null) {
      const status = ackStatusOf(known.state === 'claimed' ? 'indeterminate' : known.state);

      if (known.state === 'claimed') {
        // Reencontrar um `claimed` significa que o agente caiu entre
        // a reivindicação e o desfecho. A operação PODE ter rodado.
        this.#options.repository.finish(id, 'indeterminate', {}, this.#now());
      }

      return {
        ack: {
          id,
          leaseToken,
          status,
          ...(known.reason === null ? {} : { reason: known.reason }),
          ...(known.operationId === null ? {} : { operationId: known.operationId }),
          at: this.#at(),
        },
        ran: false,
      };
    }

    // ---- (b) o kind está na allowlist? ----
    const kind = raw.kind as SiteCommandKind | undefined;

    if (kind === undefined || !SITE_COMMAND_KINDS.includes(kind)) {
      // NUNCA em silêncio: o comando ignorado fica pendurado até
      // expirar, e o admin vê "enfileirado" por dois minutos e
      // depois "expirado", sem causa. Com o ACK ele vê na hora que
      // este agente não conhece aquele kind — que é o sintoma de
      // site novo contra agente velho.
      return { ack: this.#refuse(id, leaseToken, 'UNKNOWN_KIND'), ran: false };
    }

    // ---- (c) o prazo ----
    if (deadlineOf(raw, pulledAt) <= this.#now()) {
      return { ack: this.#refuse(id, leaseToken, 'COMMAND_EXPIRED'), ran: false };
    }

    // ---- (d) o agente cuida deste servidor? ----
    if (!this.#options.enabled()) {
      return { ack: this.#refuse(id, leaseToken, 'SERVER_DISABLED'), ran: false };
    }

    // O jogo fora do disco daria `OPERATION_NOT_ALLOWED` lá dentro
    // (sem instalação, o único kind permitido é `server-install`), e
    // esse nome não diz nada a quem está do outro lado. A pergunta é
    // ao MESMO estado, e a resposta é a que o admin precisa ler.
    if (!this.#options.installed()) {
      return { ack: this.#refuse(id, leaseToken, 'NOT_INSTALLED'), ran: false };
    }

    // ---- (e) já tem um rodando? ----
    if (busy) {
      return { ack: this.#refuse(id, leaseToken, 'AGENT_BUSY'), ran: false };
    }

    // ---- (f) o DISCO, antes de qualquer coisa acontecer ----
    const claimed = this.#options.repository.claim(
      {
        id,
        serverId: this.#options.serverId,
        kind,
        params: JSON.stringify(raw.params ?? {}),
        leaseToken,
      },
      this.#now(),
    );

    if (!claimed) {
      // Alguém gravou entre o `get` e o `claim`. Não é erro: é a
      // chave primária fazendo o trabalho dela — e ela é o que
      // impede o segundo restart.
      return { ack: null, ran: false };
    }

    // ---- (g) o `accepted`, na hora ----
    await this.#ack([{ id, leaseToken, status: 'accepted', at: this.#at() }]);

    // ####  O PRAZO DE NOVO, DEPOIS DA IDA À REDE  ####
    //
    // O ACK acima custa até o timeout do canal — cinco segundos, e
    // o dobro disso quando a resposta demora e a conexão cai. Um
    // comando que chegou com três segundos de prazo NÃO pode
    // executar depois dessa espera: entre o `claim` e o RCON há
    // backoff real, e é por isso que os dois relógios do contrato
    // não bastam sem o teto local.
    //
    // A linha já existe, então a recusa é GRAVADA: uma linha que
    // ficasse em `claimed` sem nunca ter executado se pareceria,
    // para sempre, com uma queda no meio.
    if (deadlineOf(raw, pulledAt) <= this.#now()) {
      this.#options.repository.finish(id, 'refused', { reason: 'COMMAND_EXPIRED' }, this.#now());

      return {
        ack: { id, leaseToken, status: 'refused', reason: 'COMMAND_EXPIRED', at: this.#at() },
        ran: false,
      };
    }

    // ---- (h) a operação ----
    //
    // A partir daqui `ran` é verdade mesmo que o disparo seja
    // recusado lá dentro: a vez desta rodada foi desta linha.
    return { ack: await this.#run(id, leaseToken, kind), ran: true };
  }

  /** Dispara, espera e conta. */
  async #run(id: string, leaseToken: string, kind: SiteCommandKind): Promise<CommandAck> {
    let execution: CommandExecution;

    try {
      // ####  `params.force` É TRATADO COMO AUSENTE  ####
      //
      // Ele existe aqui dentro (`ops/service.ts:286-297`) e MATA o
      // processo, perdendo tudo desde o último save automático.
      // Enquanto o contrato não disser o que vai dentro de `params`,
      // um `RCON_UNAVAILABLE` vira recusa — e quem quiser matar o
      // processo faz isso no painel local, olhando para a máquina.
      execution = await this.#options.execute(kind);
    } catch (error) {
      const reason = reasonOf(error);

      this.#options.repository.finish(
        id,
        reason === null ? 'failed' : 'refused',
        { reason },
        this.#now(),
      );
      this.#options.logger.warn(
        { serverId: this.#options.serverId, commandId: id, kind, reason, err: toError(error) },
        'the site command was refused before it started',
      );

      return {
        id,
        leaseToken,
        // Pré-condição não é falha de execução: nada aconteceu, e o
        // painel do site precisa poder dizer POR QUE não aconteceu.
        ...(reason === null
          ? { status: 'failed' as const }
          : { status: 'refused' as const, reason }),
        at: this.#at(),
      };
    }

    this.#options.repository.attachOperation(id, execution.operationId, this.#now());

    const outcome = await execution.done;
    const state: SiteCommandState = outcome.status === 'succeeded' ? 'executed' : 'failed';

    this.#options.repository.finish(
      id,
      state,
      { operationId: execution.operationId },
      this.#now(),
    );
    this.#options.logger.info(
      {
        serverId: this.#options.serverId,
        commandId: id,
        kind,
        operationId: execution.operationId,
        status: outcome.status,
      },
      'the site command finished',
    );

    return {
      id,
      leaseToken,
      status: state === 'executed' ? 'executed' : 'failed',
      // ####  SEM `reason` AQUI, E É DE PROPÓSITO  ####
      //
      // O que sobra de uma operação que falhou é a FRASE em
      // português, não o código: o `.catch` do `ops/service.ts`
      // guarda `err.message`. Traduzir frase em código seria
      // adivinhar, e um `reason` fora do vocabulário fechado é 400
      // no ACK. Quem quiser a causa segue o `operationId` até o log
      // da operação, que tem tudo.
      operationId: execution.operationId,
      at: this.#at(),
    };
  }

  /** Uma recusa que não chegou a virar linha em disco. */
  #refuse(id: string, leaseToken: string, reason: string): CommandAck {
    this.#options.logger.warn(
      { serverId: this.#options.serverId, commandId: id, reason },
      'the site command was refused',
    );

    // Ela NÃO grava: nada foi executado, e repetir a mesma recusa
    // numa reentrega é inofensivo. Gravar criaria linha para um
    // comando que este agente nunca tocou.
    return { id, leaseToken, status: 'refused', reason, at: this.#at() };
  }

  /**
   * Os desfechos que o site não confirmou, no começo da rodada.
   *
   * Um ACK perdido custa uma volta de 10 s; uma linha esquecida
   * deixa o admin olhando "executando" para um servidor que já
   * voltou.
   */
  async #resend(): Promise<void> {
    const pending = this.#options.repository.listUnacked(
      this.#options.serverId,
      COMMAND_ACK_LIMIT,
    );

    if (pending.length === 0) {
      return;
    }

    await this.#ack(
      pending.map((row) => ({
        id: row.id,
        leaseToken: row.leaseToken,
        status: ackStatusOf(row.state),
        ...(row.reason === null ? {} : { reason: row.reason }),
        ...(row.operationId === null ? {} : { operationId: row.operationId }),
        at: this.#at(),
      })),
    );
  }

  /**
   * O lote.
   *
   * O `accepted` NÃO marca a linha como confirmada: o que fecha uma
   * linha é o desfecho, e é ele que o `#resend` reenvia.
   */
  async #ack(acks: readonly CommandAck[]): Promise<void> {
    if (acks.length === 0) {
      return;
    }

    const clean = acks.map((ack) => sanitizeAck(ack));

    for (const [at, ack] of clean.entries()) {
      if (ack.reason !== acks[at]?.reason) {
        this.#options.logger.error(
          { serverId: this.#options.serverId, commandId: ack.id, reason: acks[at]?.reason },
          'a command ack carried a reason outside the closed vocabulary; sending it as failed',
        );
      }
    }

    const result = await this.#options.client.ackCommands(clean);

    if (!result.ok) {
      // Nenhum destes apaga linha local: enquanto o ACK não passa, a
      // linha continua aberta e volta no lote seguinte.
      this.#log(
        'warn',
        { serverId: this.#options.serverId, status: result.status, code: result.code },
        'the site refused a command ack batch',
      );

      return;
    }

    const now = this.#now();
    const unknown = new Set(result.body.unknown ?? []);

    for (const ack of acks) {
      if (ack.status === 'accepted') {
        continue;
      }

      if (unknown.has(ack.id)) {
        // `unknown` é token velho, id que o site não conhece ou
        // linha já fechada. Insistir com o MESMO token daria o mesmo
        // `unknown` para sempre, e o laço travaria na primeira linha
        // da fila de reenvio. A linha fica no banco — ela é o
        // comprovante —, só sai do caminho.
        this.#log(
          'warn',
          { serverId: this.#options.serverId, commandId: ack.id },
          'the site did not recognize a command ack',
        );
      }

      this.#options.repository.markAcked(ack.id, now);
    }
  }

  /** As linhas em `claimed` que sobraram de uma queda. */
  #settleOrphans(): void {
    const orphans = this.#options.repository.listClaimed(this.#options.serverId);

    for (const row of orphans) {
      this.#options.repository.finish(row.id, 'indeterminate', {}, this.#now());
      this.#options.logger.warn(
        {
          serverId: this.#options.serverId,
          commandId: row.id,
          kind: row.kind,
          operationId: row.operationId,
        },
        'a site command was left unfinished by a restart; it will never run again',
      );
    }
  }

  /**
   * A tradução dos erros do `claim`, e ela é curta de propósito.
   *
   * Comando é tarefa, não dinheiro: aqui não há compra para fechar
   * nem item para devolver. Todo 4xx com código desconhecido é
   * "indisponível", e não "recusado" — recuar, nunca fechar —, e a
   * volta seguinte tenta de novo dez segundos depois.
   */
  #classify(status: number | null, code: string | null): void {
    const serverId = this.#options.serverId;

    if (status === 404 && code === null) {
      // O Lote do outro lado ainda não subiu. Não é pareamento
      // quebrado, e não acorda ninguém.
      this.#log(
        'warn',
        { serverId, status },
        'the site does not answer POST /api/agent/commands/claim yet',
      );

      return;
    }

    this.#log('warn', { serverId, status, code }, 'could not read the command queue');
  }

  /** O relógio do agente, para o carimbo do ACK. Diagnóstico. */
  #at(): string {
    return new Date(this.#now()).toISOString();
  }

  /** Registra, com freio para a linha REPETIDA. Ver `LOG_REPEAT_MS`. */
  #log(level: 'warn' | 'error', fields: Record<string, unknown>, message: string): void {
    const now = this.#now();
    const last = this.#lastLogged;

    if (last !== null && last.message === message && now - last.at < LOG_REPEAT_MS) {
      return;
    }

    this.#lastLogged = { message, at: now };
    this.#options.logger[level](fields, message);
  }
}
