// ============================================================
//  stat-events.ts  -  a ponte item -> ponto: quem ESCUTA o
//  `#OZSTAT#` que o plugin grita, e quem CONFIRMA que gravou.
//
//  ####  ATÉ 05/09/2026 O PONTO SIMPLESMENTE NÃO CHEGAVA  ####
//
//  O `OrigemZItems` já convertia: ele registra a conversão numa
//  fila em disco, destrói o item e emite `#OZSTAT#{…}` no console.
//  Nenhuma linha de TypeScript reconhecia esse marcador. O item
//  sumia do inventário do jogador e o número não mexia — que é o
//  pior desfecho possível, porque o item JÁ FOI DESTRUÍDO e não
//  volta.
//
//  Este arquivo é o outro lado dessa conversa. Ele faz três
//  coisas, e as três existem por um motivo medido:
//
//    1. ESCUTA o `#OZSTAT#` (o "agora": o recibo no chat tem de
//       ser na hora);
//    2. CONFIRMA com `origemz.item.ack` — e só DEPOIS de gravar.
//       Enquanto não confirma, o plugin segura a conversão na
//       fila dele, em disco;
//    3. VARRE `origemz.item.pending` na reconexão e de tempos em
//       tempos — é este caminho que cobre a queda no instante da
//       conversão, quando o push se perdeu no ar.
//
//  Ver Docs\Ranking\20-PLANO-E-CONTRATOS.md §7 e §8.2, e
//  Docs\CustomItem\03-ACAO-PONTOS-DE-RANKING.md §8.
//
//  ------------------------------------------------------------
//  ####  A IDEMPOTÊNCIA NÃO É ZELO: É O DESENHO  ####
//
//  O MESMO evento chega duas vezes de propósito. O push dá o
//  "agora" e é como UDP — perdeu o frame, perdeu o ponto. A fila
//  dá o "garantido", e ela reenvia tudo o que ainda não foi
//  confirmado a cada conversão nova.
//
//  Quem desempata é o `eventId`, gerado pelo PLUGIN. O
//  `applyEvent` do repositório resolve isso num `INSERT OR
//  IGNORE`, e "já vi este" é o caso NORMAL deste arquivo — nunca
//  um erro, nunca uma linha de log de alarme.
//
//  ------------------------------------------------------------
//  ####  E HÁ UM LAÇO A EVITAR, JÁ VIVIDO NESTE PROJETO  ####
//
//  MEDIDO em `core/src/index.ts:309-319`: o `onConsoleLine` recebe
//  TODA linha do servidor, centenas por minuto. Um comando de RCON
//  mandado de dentro dele imprime no console, a linha volta pelo
//  mesmo caminho e dispara de novo — o console do jogo virou um
//  paredão de `loadout.sync` repetido no dia em que isso aconteceu.
//
//  Daí o `handleLine` daqui aplicar o evento (escrita em SQLite,
//  que não fala com o jogo) e ARMAR UM RELÓGIO para o `ack`. Nenhum
//  comando sai da pilha do gancho. O mesmo desenho do
//  `custom-items-sync.ts` e do `ui-sync.ts`.
//
//  ------------------------------------------------------------
//  ####  E O CHAT PASSA POR ESTE MESMO CANO  ####
//
//  O `onConsoleLine` recebe o chat dos jogadores junto com o
//  resto. Sem defesa, digitar `#OZSTAT#{…}` no chat seria pedir
//  pontos para si mesmo — num ranking em que o primeiro lugar
//  ganha prêmio real.
//
//  São duas peneiras, nesta ordem: a âncora (`PLUGIN_LINE`), que é
//  barata e recusa a enxurrada, e o SEGREDO (`#authentic`), que é a
//  defesa de verdade — sorteado a cada subida do agente, empurrado
//  ao plugin no `origemz.item.clear` e carimbado por ele em toda
//  linha. É o mesmo desenho do `#authenticate` do `ui-sync`.
//
//  O que a peneira recusa não se perde: sem `ack`, o plugin segura
//  a conversão e o `origemz.item.pending` a traz — por um canal que
//  não é forjável, porque é a resposta ao NOSSO comando.
// ============================================================

import { z } from 'zod';

import type { RankingsRepository, StatEventInput } from '../db/rankings-repository.js';
import { firstJsonLine } from '../game/plugin-contract.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { disconnectedRcon } from '../ops/service.js';
import { toError } from '../util.js';

/**
 * O marcador do evento, colado no JSON.
 *
 * ####  ELE É FEIO DE PROPÓSITO  ####
 *
 * Como o `#OZPEVT#` do `OrigemZPlayer` e o `#OZAREQ#` do
 * `OrigemZItems`: `#OZSTAT#` não aparece em log de servidor, de
 * plugin nem de chat. Um prefixo bonito seria ambíguo com o que
 * outro plugin imprime — e a ambiguidade, aqui, viraria ponto
 * concedido a partir de uma linha de chat.
 *
 * A constante do outro lado está em `Plugins/OrigemZItems.cs:209`.
 */
export const EVENT_MARKER = '#OZSTAT#';

/**
 * A linha veio do PLUGIN, e não da boca de um jogador?
 *
 * ####  ESTA É UMA DEFESA, E NÃO UMA ARRUMAÇÃO  ####
 *
 * O `onConsoleLine` recebe TODA linha do servidor — e o chat está
 * entre elas (`servers/context.ts:105-124`). Sem a âncora, um
 * jogador que digitasse
 *
 *     #OZSTAT#{"contract":1,"kind":"points","steamId":"<o dele>",…}
 *
 * no chat concederia pontos a si mesmo. O frame nativo de chat do
 * Rust escapa as aspas do texto e o `JSON.parse` já recusaria isso
 * hoje, mas basta um plugin de chat de terceiros que imprima a
 * mensagem CRUA com `Puts` para o escape sumir — e servidores de
 * Rust vivem cheios deles.
 *
 * O que a âncora exige é que o marcador esteja no COMEÇO da linha,
 * atrás no máximo do carimbo que o Oxide põe (`[OrigemZItems] `).
 * Chat repassado ao console vem sempre com algo antes — o nick de
 * quem falou, no mínimo —, e é isso que ela recusa.
 *
 * ####  E ERRAR PARA O LADO ESTRITO AQUI NÃO CUSTA PONTO  ####
 *
 * Uma linha legítima que a âncora recusasse não some: o plugin
 * segura a conversão na fila dele até o `ack`, e a varredura do
 * `origemz.item.pending` a recolhe. O preço de um falso negativo é
 * atraso; o de um falso positivo seria pontuação forjada.
 *
 * ####  E ELA NÃO É A DEFESA PRINCIPAL  ####
 *
 * Um plugin de chat de terceiros que imprima a mensagem CRUA com
 * `Puts` produz `[AlgumPlugin] #OZSTAT#{…}` — e o carimbo é
 * justamente o que esta âncora permite. Quem fecha isso é o
 * SEGREDO (ver `#authentic`), no mesmo molde do `#authenticate` do
 * `ui-sync`. A âncora fica porque é a peneira barata: ela recusa a
 * enxurrada em um teste de regex, antes de qualquer `JSON.parse`.
 */
const PLUGIN_LINE = /^(?:\[[^\]\r\n]{1,60}\]\s*){0,2}#OZSTAT#/;

/** `origemz.item.ack <id> [<id> …]` — o plugin esquece a conversão. */
export const ACK_COMMAND = 'origemz.item.ack';

/** `origemz.item.pending` — o que ficou na fila do plugin. */
export const PENDING_COMMAND = 'origemz.item.pending';

/**
 * O tamanho de página que pedimos, igual ao padrão do plugin.
 *
 * Um evento serializado pesa ~200 bytes, e ~250 já enchem o frame
 * de 50 KB do WebRCON. 100 dá ~20 KB — folga de 3x — e o plugin
 * recusa a página inteira se ainda assim não couber.
 */
export const PENDING_PAGE_LIMIT = 100;

/**
 * O que o plugin responde quando a PÁGINA não coube no frame.
 *
 * Ele recusa a página inteira em vez de cortá-la: resposta
 * truncada chega aqui como JSON inválido, e uma fila pela metade
 * *parece* ter funcionado — e o agente CONFIRMA o que recebe, então
 * o que ficasse de fora seria esquecido dos dois lados.
 *
 * O mesmo código e o mesmo desenho do `origemz.bp.export`
 * (`wipe/blueprints.ts`).
 */
export const PENDING_TOO_LARGE = 'PAYLOAD_TOO_LARGE';

/** `origemz.item.pending <offset> <limit>`. */
export function buildPendingCommand(offset: number, limit: number): string {
  return `${PENDING_COMMAND} ${String(offset)} ${String(limit)}`;
}

/**
 * A versão do contrato que este agente entende.
 *
 * O agente RECUSA o que não entende, e recusar aqui é recusar
 * DIREITO: o evento fica na fila do plugin, e um agente mais novo
 * o aplica depois. Confirmar o que não foi aplicado é que perderia
 * o ponto para sempre.
 */
export const STAT_EVENT_CONTRACT = 1;

/**
 * Junta em um `ack` só a rajada de eventos.
 *
 * O `FlushQueue` do plugin reenvia a fila INTEIRA a cada conversão
 * nova — três pendentes viram três linhas no mesmo instante. Sem o
 * debounce seriam três comandos de RCON; com ele, um.
 *
 * O mesmo número do `ui-sync` e do `custom-items-sync`, pela mesma
 * razão.
 */
const ACK_DEBOUNCE_MS = 250;

/**
 * De quanto em quanto tempo perguntar pela fila do plugin.
 *
 * ####  ELE NÃO É O CAMINHO PRINCIPAL, E POR ISSO É LENTO  ####
 *
 * O push cobre o caso normal e a reconexão cobre a queda. Esta
 * varredura é a terceira rede: ela pega o `ack` que se perdeu no
 * ar com o RCON de pé — um caso raro que, sem ela, deixaria a
 * conversão presa na fila até o próximo restart.
 *
 * Cinco minutos porque um comando por servidor a cada cinco
 * minutos é ruído nenhum, e o atraso máximo é de um `ack`, não de
 * um ponto: quem já chegou pelo push está gravado desde então.
 */
const SWEEP_MS = 5 * 60_000;

/**
 * Quantos caracteres um `origemz.item.ack` pode ter.
 *
 * O frame do WebRCON aguenta ~50 KB (ver `types/ui-transport.ts`),
 * e 4.000 dá uma centena de ids com folga larga. Passando disso o
 * comando é QUEBRADO em vários, e nunca cortado: um id que ficasse
 * de fora deixaria a conversão presa na fila do plugin, reenviada
 * a cada conversão nova.
 */
const MAX_ACK_COMMAND_CHARS = 4_000;

/**
 * O teto do `at`, em segundos.
 *
 * ####  ELE EXISTE PARA PEGAR MILISSEGUNDO DISFARÇADO  ####
 *
 * `at` é o relógio do SERVIDOR DE JOGO em SEGUNDOS (§7.2), e é
 * gravado como chegou — a auditoria compara essa coluna com o log
 * do jogo. Um emissor que mandasse milissegundos passaria num
 * `int().positive()` e gravaria um fato datado no ano 57.000, sem
 * nada quebrar e sem ninguém ver.
 *
 * 4.102.444.800 é 2100-01-01. Qualquer coisa acima disso é unidade
 * errada, e não data.
 */
const AT_SECONDS_CEILING = 4_102_444_800;

/**
 * O `steamId`, como o resto do projeto o valida.
 *
 * STRING, nunca número: um SteamID64 tem 17 dígitos e passa de
 * 2^53. E o formato é conferido porque esta é a chave que entra em
 * `player_stats` — lixo aqui vira uma linha de ranking que nunca
 * casa com jogador nenhum.
 */
const steamIdSchema = z.string().regex(/^\d{17}$/, 'steamId precisa ser um SteamID64 de 17 dígitos');

/**
 * A métrica, no MESMO formato que o cadastro do item exige.
 *
 * O regex é copiado de `http/routes/custom-items.ts` de propósito:
 * os dois lados descrevem a mesma coisa, e um mais frouxo que o
 * outro deixaria passar no jogo o que o painel recusou.
 */
const metricSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/, 'A métrica é minúscula, no formato "familia.nome".');

/**
 * A procedência: `item:trofeu-bleik`, `dungeon`, `admin`.
 *
 * ####  FECHADO NA FORMA, ABERTO NO CONTEÚDO  ####
 *
 * O §2.4 pede um conjunto fechado no zod da borda, e a FORMA é o
 * que dá para fechar sem perder ponto: a lista de fontes cresce
 * (cada item custom novo é uma), e recusar um `source` que ninguém
 * previu descartaria uma conquista já paga pelo jogador — o item
 * foi destruído antes de o evento sair.
 */
const sourceSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9._-]*(:[a-zA-Z0-9._-]+)?$/, 'A procedência é `familia` ou `familia:id`.');

const commonFields = {
  contract: z.literal(STAT_EVENT_CONTRACT),
  eventId: z.string().min(1).max(120),
  steamId: steamIdSchema,
  /** Só para o log e o anúncio; NUNCA é chave. */
  name: z.string().max(120).optional(),
  metric: metricSchema,
  source: sourceSchema.optional(),
  at: z.number().int().min(0).max(AT_SECONDS_CEILING),
};

/** O troféu que virou ponto. `amount` já vem multiplicado. */
export const statPointsEventSchema = z.object({
  ...commonFields,
  kind: z.literal('points'),
  amount: z.number().int().min(1),
});

/**
 * O fato com testemunho: o tiro mais longo, e o que vier depois.
 *
 * Ainda não há emissor deste `kind` — o `OrigemZItems` só emite
 * `points`. Ele é aceito desde já porque o canal é o mesmo e a
 * frente de coleta manda recorde por aqui; deixar o schema para
 * depois faria o primeiro recorde chegar e ser descartado por
 * "não bate com o contrato".
 */
export const statRecordEventSchema = z.object({
  ...commonFields,
  kind: z.literal('record'),
  /** REAL, e não inteiro: distância é medida, e 412,73 é a informação. */
  value: z.number().finite(),
  /**
   * `ok` ou `suspect`; ausente vale `ok`.
   *
   * ####  `void` NÃO ENTRA POR AQUI  ####
   *
   * Anular um recorde é decisão de ADMIN, tomada no painel depois
   * de alguém contestar — e uma linha de console que pudesse anular
   * recorde tiraria essa decisão de quem deve tomá-la. O plugin
   * marca a SUSPEITA (é ele que tem o `ratio` do §7.2 na mão); o
   * veredito é de gente.
   */
  status: z.enum(['ok', 'suspect']).default('ok'),
  /** O testemunho — arma, vítima, grid. É para LER, não para filtrar. */
  detail: z.unknown().optional(),
});

export const statEventSchema = z.discriminatedUnion('kind', [
  statPointsEventSchema,
  statRecordEventSchema,
]);

export type StatPointsEvent = z.infer<typeof statPointsEventSchema>;
export type StatRecordEvent = z.infer<typeof statRecordEventSchema>;
export type StatEvent = z.infer<typeof statEventSchema>;

/**
 * A resposta do `origemz.item.pending`.
 *
 * ####  A LISTA É `unknown[]` DE PROPÓSITO  ####
 *
 * Validar item a item é o que impede que UM evento fora do
 * contrato descarte a fila inteira. O envelope precisa bater; o
 * conteúdo é conferido um por um, e o que não passar fica na fila
 * do plugin com uma linha no log.
 */
export const pendingResponseSchema = z.object({
  ok: z.literal(true),
  /**
   * O TOTAL da fila do plugin, e NÃO o tamanho desta página.
   *
   * É o fim do laço. Uma página menor que o `limit` não quer dizer
   * fim de lista — o plugin devolve menos quando a fila acaba, e
   * também quando o teto de bytes aperta.
   */
  count: z.number().int().min(0),
  /**
   * A janela que o plugin de fato aplicou.
   *
   * ####  OPCIONAIS PORQUE O PLUGIN PODE SER MAIS VELHO  ####
   *
   * Um `OrigemZItems` anterior à paginação devolve a fila inteira,
   * sem estes dois campos, e ignora os argumentos. Exigi-los faria
   * o agente concluir "a resposta não bate com o contrato" e
   * abandonar a única cópia dos pontos já convertidos — durante um
   * deploy pela metade, que é justamente quando isso acontece. Sem
   * eles, o laço avança pelo tamanho da página e termina na
   * primeira, que é o comportamento correto para aquele plugin.
   */
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().optional(),
  pending: z.array(z.unknown()),
});

/**
 * A recusa do plugin, para distinguir `PAYLOAD_TOO_LARGE` do resto.
 *
 * Ela é conferida ANTES do envelope de sucesso: as duas formas são
 * `ok`-discriminadas, e só esta tem tratamento próprio (encolher a
 * janela). Qualquer outro erro segue sendo "não bate com o
 * contrato" — o plugin recusou, e insistir com o mesmo pedido não
 * mudaria nada.
 */
const pendingErrorSchema = z.object({ ok: z.literal(false), error: z.string().min(1) });

export interface StatEventServers {
  ids(): readonly string[];
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

export interface StatEventsDeps {
  readonly repository: RankingsRepository;
  readonly servers: StatEventServers;
  readonly logger: Logger;
  /**
   * O segredo que o plugin carimba em toda linha `#OZSTAT#`.
   *
   * É o MESMO valor que o `CustomItemsSync` empurra no
   * `origemz.item.clear` — os dois recebem a dep do `index.ts`, de
   * uma variável só.
   *
   * Ausente = NENHUMA linha de console é aceita. É o mesmo
   * fail-closed do `ui-sync` (`secret === undefined` desliga a
   * compra), e aqui ele não perde ponto: o plugin segura a
   * conversão na fila em disco até o `ack`, e a varredura do
   * `origemz.item.pending` a recolhe por um canal que não é
   * forjável — a resposta do NOSSO comando.
   */
  readonly secret?: string;
  /** Só os testes mexem: o intervalo da varredura de pendentes. */
  readonly sweepMs?: number;
  /** Só os testes mexem: o debounce do `ack`. */
  readonly ackMs?: number;
}

/** O que uma varredura de `origemz.item.pending` produziu. */
export interface PendingSweepResult {
  readonly serverId: string;
  /** Quantos o plugin tinha na fila. */
  readonly found: number;
  /** Quantos entraram AGORA (os repetidos não contam). */
  readonly applied: number;
  /** Quantos já estavam gravados — o caso normal, não um erro. */
  readonly duplicated: number;
  /** Quantos foram recusados e CONTINUAM na fila do plugin. */
  readonly refused: number;
  /** `null` = a varredura aconteceu. Preenchido = por que não. */
  readonly skipped: string | null;
}

/** O desfecho de uma linha de console. */
export type StatEventOutcome =
  /** Não era nossa. É o caso de 99,9% das linhas. */
  | 'ignored'
  /** Marcada, mas não é JSON — as pontas divergiram. */
  | 'malformed'
  /** Válida como texto, recusada pelo contrato. Fica na fila. */
  | 'refused'
  /** Gravada agora. */
  | 'applied'
  /** Já estava gravada. O caso NORMAL da via dupla. */
  | 'duplicated'
  /** O banco recusou. Fica na fila, e a próxima rodada tenta. */
  | 'failed';

/** O desfecho, com o id de quem já pode ser confirmado. */
interface AppliedPayload {
  readonly outcome: StatEventOutcome;
  /**
   * `null` = não há o que confirmar.
   *
   * ####  E "NÃO HÁ" TEM DOIS MOTIVOS  ####
   *
   * O primeiro é o óbvio: nada foi gravado. O segundo é o
   * `kind: "record"` — ele vem do `OrigemZAgent`, que NÃO tem fila
   * de conversões em disco: o recorde mora no buffer do lote, e
   * quem o descarta é o `origemz.stats.ack`. Mandar
   * `origemz.item.ack` com esse id seria falar com o plugin errado
   * — um comando de RCON por recorde para um `OrigemZItems` que
   * nunca ouviu falar daquele id.
   */
  readonly eventId: string | null;
}

/**
 * O consumidor do `#OZSTAT#`.
 *
 * Um por agente, servindo todos os servidores: o que é por
 * servidor é a fila de `ack` e o relógio dela.
 */
export class StatEventsConsumer {
  readonly #deps: StatEventsDeps;

  /**
   * Os ids esperando confirmação, por servidor.
   *
   * ####  UM `Set`, E NÃO UMA LISTA  ####
   *
   * O mesmo `eventId` chega pelo push e pela fila de pendentes, e
   * confirmá-lo duas vezes no mesmo comando seria só desperdício —
   * mas confirmá-lo duas vezes em comandos diferentes é NORMAL, e
   * o plugin aguenta: o `CommandAck` dele varre a fila procurando
   * o id e não reclama de não achar.
   */
  readonly #ackQueue = new Map<string, Set<string>>();

  /** Os relógios do `ack`. Ver `ACK_DEBOUNCE_MS`. */
  readonly #ackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Quem já está confirmando, para dois relógios não se atropelarem. */
  readonly #draining = new Set<string>();

  /** Quem já está varrendo a fila do plugin. */
  readonly #sweeping = new Set<string>();

  /**
   * As métricas desconhecidas de que já reclamamos.
   *
   * Ver `#warnUnknownMetric`: o aviso vale uma vez por métrica, e
   * não uma por evento — cem troféus virariam cem linhas iguais e
   * ensinariam a ignorar o log.
   */
  readonly #warnedMetrics = new Set<string>();

  /** O relógio da varredura periódica. `null` = parado. */
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: StatEventsDeps) {
    this.#deps = deps;
  }

  // ==========================================================
  //  O CAMINHO DO PUSH
  // ==========================================================

  /**
   * Uma linha do console daquele servidor. NUNCA lança.
   *
   * ####  ELA RECUSA EM UMA COMPARAÇÃO DE STRING  ####
   *
   * Este método é chamado para TODA linha do console — centenas
   * por minuto num servidor cheio. Tudo o que não é nosso sai daqui
   * na primeira comparação, e nada mais acontece.
   *
   * ####  E NENHUM COMANDO SAI DAQUI  ####
   *
   * Aplicar é escrita em SQLite. O `ack` é RCON, e ele sai pelo
   * relógio — ver o cabeçalho e `index.ts:309-319`.
   */
  handleLine(serverId: string, line: string): StatEventOutcome {
    if (!line.includes(EVENT_MARKER)) {
      return 'ignored';
    }

    // A segunda peneira só roda no punhado de linhas que trazem o
    // marcador. Ver `PLUGIN_LINE`: é ela que separa o plugin da
    // boca de um jogador.
    if (!PLUGIN_LINE.test(line)) {
      this.#deps.logger.warn(
        { serverId, line: line.slice(0, 200) },
        'linha com #OZSTAT# fora do começo; ela não veio do plugin e foi ignorada',
      );

      return 'ignored';
    }

    try {
      const at = line.indexOf(EVENT_MARKER);
      const raw = line.slice(at + EVENT_MARKER.length).trim();

      let payload: unknown;

      try {
        payload = JSON.parse(raw);
      } catch {
        // Linha marcada que não é JSON. Não dá para confirmar o que
        // não tem id, então ela fica na fila do plugin — e o log é a
        // única forma de alguém descobrir que as pontas divergiram.
        this.#deps.logger.warn(
          { serverId, line: raw.slice(0, 200) },
          'linha #OZSTAT# que não é JSON; o evento continua na fila do plugin',
        );

        return 'malformed';
      }

      // ####  O SEGREDO VEM ANTES DO CONTRATO  ####
      //
      // Antes porque uma linha forjada não merece nem o `warn` de
      // "fora do contrato": ela não é nossa, e tratá-la como evento
      // defeituoso encheria o log com o que um jogador digitou.
      if (!this.#authentic(serverId, payload)) {
        return 'ignored';
      }

      const result = this.#applyPayload(serverId, payload, 'push');

      // ####  O `ack` SAI DEPOIS DA GRAVAÇÃO, E FORA DAQUI  ####
      //
      // Depois porque o `applyEvent` é uma transação: quando ele
      // volta, o COMMIT já aconteceu. Confirmar antes faria o
      // plugin esquecer uma conversão que o banco ainda podia
      // recusar.
      //
      // E fora daqui porque isto é o gancho de console: o
      // `#enqueueAck` só guarda o id e arma um relógio.
      if (result.eventId !== null) {
        this.#enqueueAck(serverId, result.eventId);
      }

      return result.outcome;
    } catch (error) {
      // ####  ESTE `catch` É O CONTRATO, NÃO ZELO  ####
      //
      // `servers/context.ts:51-65` é explícito: quem se inscreve no
      // `onConsoleLine` NÃO PODE LANÇAR. Uma exceção aqui subiria
      // pelo ouvinte do RCON e levaria junto o processamento de
      // console do servidor inteiro — o chat, o buffer da tela e os
      // pedidos dos outros plugins.
      this.#deps.logger.error(
        { serverId, err: toError(error) },
        'o consumo de um evento de ranking lançou',
      );

      return 'failed';
    }
  }

  /**
   * A linha traz o segredo desta subida do agente?
   *
   * ####  ISTO É O QUE SEPARA O PLUGIN DA BOCA DE UM JOGADOR  ####
   *
   * A âncora do `PLUGIN_LINE` recusa o chat NATIVO do Rust, mas um
   * plugin de chat de terceiros que imprima a mensagem crua com
   * `Puts` produz uma linha carimbada — e o carimbo é permitido.
   * Num ranking cujo primeiro lugar ganha prêmio real, "digitar o
   * payload no chat" não pode ser um caminho.
   *
   * O molde é o `#authenticate` do `ui-sync` (`game/ui-sync.ts`), e
   * a cópia é deliberada: o segredo é sorteado a cada subida do
   * agente, empurrado ao plugin no `origemz.item.clear` e conferido
   * num lugar só.
   *
   * ####  E A RECUSA É MUDA DE PROPÓSITO  ####
   *
   * Um `warn` por linha daria a quem forja o poder de encher o log
   * do servidor digitando no chat. O `debug` registra para quem for
   * investigar, e o desfecho é benigno: sem `ack`, o plugin segura
   * a conversão e a varredura do `origemz.item.pending` a traz — o
   * preço de um falso negativo aqui é atraso, nunca ponto perdido.
   */
  #authentic(serverId: string, payload: unknown): boolean {
    const secret = this.#deps.secret;
    const carried = readString(payload, 'secret');

    if (secret !== undefined && secret !== '' && carried === secret) {
      return true;
    }

    this.#deps.logger.debug(
      {
        serverId,
        eventId: readString(payload, 'eventId'),
        // O que veio NÃO vai para o log: se for o segredo certo de
        // uma subida anterior, ele acabaria no arquivo de log. O que
        // interessa é a distinção entre "não mandou" e "mandou
        // outro".
        carried: carried === undefined ? 'ausente' : 'diferente',
        configured: secret !== undefined && secret !== '',
      },
      'linha #OZSTAT# sem o segredo desta subida; ignorada (a fila do plugin a reoferece)',
    );

    return false;
  }

  /**
   * Valida e aplica um payload já parseado.
   *
   * O caminho do push e o da fila passam os dois por aqui: a
   * diferença entre eles é o `via`, que é justamente "por qual dos
   * dois caminhos ele chegou PRIMEIRO".
   */
  #applyPayload(serverId: string, payload: unknown, via: 'push' | 'flush'): AppliedPayload {
    const parsed = statEventSchema.safeParse(payload);

    if (!parsed.success) {
      // ####  POR QUE ISTO NÃO VIRA UM `ack`  ####
      //
      // Um `contract` diferente de 1 é um agente velho demais para
      // o evento, e não um evento inválido: confirmar aqui faria o
      // plugin esquecer uma conversão que a próxima versão saberia
      // aplicar. O evento fica na fila, o log diz o que houve, e o
      // teto de 5.000 do plugin é o limite dessa paciência.
      const contract = readNumber(payload, 'contract');

      this.#deps.logger.warn(
        {
          serverId,
          contract,
          eventId: readString(payload, 'eventId'),
          issue: parsed.error.issues[0]?.message,
        },
        contract !== null && contract !== STAT_EVENT_CONTRACT
          ? 'evento de ranking em outro contrato; ele fica na fila do plugin até um agente que o ' +
              'entenda'
          : 'evento de ranking fora do contrato; ele fica na fila do plugin',
      );

      return { outcome: 'refused', eventId: null };
    }

    const event = parsed.data;

    this.#warnUnknownMetric(serverId, event.metric);

    // ####  SÓ O PONTO PRECISA DE `ack`  ####
    //
    // O `points` vem do `OrigemZItems`, que segura a conversão numa
    // fila EM DISCO até alguém confirmar — o item já foi destruído,
    // e sem o `ack` ele a reenviaria para sempre.
    //
    // O `record` vem do `OrigemZAgent`, e lá não há fila nenhuma: o
    // recorde mora no buffer do lote, e quem o descarta é o
    // `origemz.stats.ack`. Confirmar aqui mandaria um
    // `origemz.item.ack` com um id que o `OrigemZItems` nunca viu —
    // um comando de RCON por recorde, para o plugin errado.
    const confirmable = event.kind === 'points' ? event.eventId : null;

    try {
      const applied =
        event.kind === 'points'
          ? this.#applyPoints(serverId, event, via)
          : this.#applyRecord(serverId, event);

      if (!applied) {
        // ####  "JÁ VI ESTE" É O CASO NORMAL  ####
        //
        // O mesmo evento chega pelo push E pela fila, de propósito
        // (§8.2). Um log de erro aqui alarmaria no funcionamento
        // certo — e `debug` é onde se olha quando alguém contesta
        // um ponto.
        //
        // E o `ack` sai IGUAL: o plugin ainda tem a conversão na
        // fila dele, e sem a confirmação ele a reenviaria para
        // sempre.
        this.#deps.logger.debug(
          { serverId, eventId: event.eventId, metric: event.metric, via },
          'evento de ranking já estava gravado; nada a somar',
        );

        return { outcome: 'duplicated', eventId: confirmable };
      }

      this.#deps.logger.info(
        {
          serverId,
          eventId: event.eventId,
          steamId: event.steamId,
          metric: event.metric,
          amount: event.kind === 'points' ? event.amount : event.value,
          source: event.source,
          via,
        },
        'evento de ranking aplicado',
      );

      return { outcome: 'applied', eventId: confirmable };
    } catch (error) {
      // Servidor que ainda não existe na tabela (a FK de
      // `stat_events.server_id`), banco travado, disco cheio. Sem
      // `ack`: o plugin segura e a próxima varredura tenta de novo.
      this.#deps.logger.error(
        { serverId, eventId: event.eventId, err: toError(error) },
        'não consegui gravar um evento de ranking; ele continua na fila do plugin',
      );

      return { outcome: 'failed', eventId: null };
    }
  }

  /** O contador. É o `applyEvent` do repositório, e nada mais. */
  #applyPoints(serverId: string, event: StatPointsEvent, via: 'push' | 'flush'): boolean {
    const input: StatEventInput = {
      eventId: event.eventId,
      serverId,
      steamId: event.steamId,
      name: event.name ?? null,
      metric: event.metric,
      amount: event.amount,
      source: event.source ?? null,
      at: event.at,
      via,
    };

    return this.#deps.repository.applyEvent(input).applied;
  }

  /**
   * O recorde.
   *
   * ####  POR QUE UM RECORDE DE PUSH VIRA UM "LOTE" DE UM  ####
   *
   * `stat_events` não serve para ele: a tabela tem `amount INTEGER
   * NOT NULL` e o que entra ali SOMA em `player_stats` — e recorde
   * não soma, ele substitui o melhor. Quem sabe inserir em
   * `player_records` comparando com o melhor anterior é o
   * `applyBatch`, e a idempotência dele é o `batchId`.
   *
   * Então o `eventId` do push vira o `batchId`, com prefixo: um
   * recorde que chegue pelos dois caminhos é aplicado uma vez só, e
   * o `seq: 0` marca, para quem olhar a tabela, que aquela linha não
   * veio de um lote de verdade.
   */
  #applyRecord(serverId: string, event: StatRecordEvent): boolean {
    const result = this.#deps.repository.applyBatch({
      serverId,
      batchId: `event:${event.eventId}`,
      seq: 0,
      players: [],
      records: [
        {
          steamId: event.steamId,
          name: event.name ?? null,
          metric: event.metric,
          value: event.value,
          at: event.at,
          status: event.status,
          detail: event.detail,
        },
      ],
    });

    return result.applied;
  }

  /**
   * A métrica que nenhum ranking declara.
   *
   * ####  ACEITAR, E NÃO RECUSAR — E A RAZÃO É O ITEM  ####
   *
   * Recusar perderia o ponto para SEMPRE: quando o evento chega, o
   * item já foi destruído e não volta. E o caso é comum e benigno —
   * o admin cadastra o item custom com `metric: "trophy.bleik"`
   * antes de criar o ranking que exibe essa métrica, e as duas
   * telas são separadas no painel.
   *
   * `player_stats` guarda `(metric TEXT, value INTEGER)` sem amarra
   * com `rankings`: o ponto entra hoje e aparece no dia em que
   * alguém criar o ranking. O aviso existe para o outro caso — a
   * métrica escrita errada, que somaria sem ninguém ver.
   */
  #warnUnknownMetric(serverId: string, metric: string): void {
    if (this.#warnedMetrics.has(metric)) {
      return;
    }

    if (this.#deps.repository.getByMetric(metric) !== null) {
      return;
    }

    this.#warnedMetrics.add(metric);

    this.#deps.logger.warn(
      { serverId, metric },
      'evento de ranking numa métrica que nenhum ranking declara; o ponto foi somado e aparece ' +
        'quando alguém criar o ranking dessa métrica',
    );
  }

  // ==========================================================
  //  O `ack`
  // ==========================================================

  /** Guarda o id e arma o relógio. Nenhum RCON sai daqui. */
  #enqueueAck(serverId: string, eventId: string): void {
    const queue = this.#ackQueue.get(serverId) ?? new Set<string>();

    queue.add(eventId);
    this.#ackQueue.set(serverId, queue);

    this.#scheduleAck(serverId);
  }

  /** Arma o relógio do `ack`, se já não houver um armado. */
  #scheduleAck(serverId: string): void {
    if (this.#ackTimers.has(serverId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.#ackTimers.delete(serverId);

      void this.drainAcks(serverId).catch((error: unknown) => {
        // Não deveria acontecer: `drainAcks` traduz falha em log. O
        // `catch` existe porque isto roda dentro de um relógio, onde
        // uma Promise rejeitada não teria quem a pegasse.
        this.#deps.logger.error(
          { serverId, err: toError(error) },
          'a confirmação dos eventos de ranking lançou',
        );
      });
    }, this.#deps.ackMs ?? ACK_DEBOUNCE_MS);

    // Como todo relógio deste projeto: uma confirmação pendente não
    // pode segurar o processo vivo no desligamento.
    timer.unref();
    this.#ackTimers.set(serverId, timer);
  }

  /**
   * Manda o `origemz.item.ack` do que está esperando. NUNCA lança.
   *
   * ####  O QUE FALHA VOLTA PARA A FILA  ####
   *
   * Um `ack` que não saiu não é um ponto perdido — o evento já está
   * gravado no banco. Mas ele é uma conversão presa na fila do
   * plugin, reenviada a cada conversão nova até alguém confirmar.
   * Devolver os ids é o que faz a próxima rodada tentar de novo.
   */
  async drainAcks(serverId: string): Promise<number> {
    if (this.#draining.has(serverId)) {
      // Uma rodada em curso não é motivo para esquecer os ids: o
      // relógio novo os leva na próxima batida.
      this.#scheduleAck(serverId);
      return 0;
    }

    const queue = this.#ackQueue.get(serverId);

    if (queue === undefined || queue.size === 0) {
      return 0;
    }

    const rcon = this.#deps.servers.contextOf(serverId)?.rcon ?? disconnectedRcon(serverId);

    if (!rcon.isConnected) {
      // Não é erro: o servidor está parado. Os ids ficam guardados
      // e saem na reconexão — e, se o agente cair antes disso, a
      // fila do plugin os reoferece na varredura.
      return 0;
    }

    const ids = [...queue];

    queue.clear();
    this.#draining.add(serverId);

    let confirmed = 0;

    try {
      for (const batch of chunkByLength(ids, MAX_ACK_COMMAND_CHARS - ACK_COMMAND.length - 1)) {
        await rcon.send(`${ACK_COMMAND} ${batch.join(' ')}`);
        confirmed += batch.length;
      }

      this.#deps.logger.debug({ serverId, confirmed }, 'eventos de ranking confirmados ao plugin');

      return confirmed;
    } catch (error) {
      // Os que não saíram voltam para a fila. Reconfirmar um id que
      // o plugin já esqueceu é barato — o `CommandAck` dele
      // simplesmente não acha nada para remover, e responde `ok`.
      for (const id of ids.slice(confirmed)) {
        queue.add(id);
      }

      this.#deps.logger.warn(
        { serverId, pending: queue.size, err: toError(error) },
        'não consegui confirmar os eventos de ranking; eles voltam para a próxima rodada',
      );

      return confirmed;
    } finally {
      this.#draining.delete(serverId);
    }
  }

  // ==========================================================
  //  A RECUPERAÇÃO: a fila que ficou no plugin
  // ==========================================================

  /**
   * Pergunta ao plugin o que ficou pendente, aplica e confirma.
   *
   * ####  É ESTE CAMINHO QUE IMPEDE A PERDA  ####
   *
   * O push é como UDP. Se o RCON estiver fora no instante da
   * conversão — e é justamente o instante em que o item já foi
   * destruído —, a linha `#OZSTAT#` some no ar e o ponto não existe
   * em lugar nenhum a não ser na fila em disco do plugin.
   *
   * Chamar isto na reconexão é o que fecha essa janela. Ver
   * Docs\Ranking\20 §8.3, linha "Item convertido com o RCON fora".
   *
   * NUNCA lança: o desfecho vai no resultado.
   */
  async sweep(serverId: string, trigger: string): Promise<PendingSweepResult> {
    const empty = { serverId, found: 0, applied: 0, duplicated: 0, refused: 0 };

    if (this.#sweeping.has(serverId)) {
      return { ...empty, skipped: 'já havia uma varredura em curso' };
    }

    const rcon = this.#deps.servers.contextOf(serverId)?.rcon ?? disconnectedRcon(serverId);

    if (!rcon.isConnected) {
      return { ...empty, skipped: 'o RCON está fora do ar' };
    }

    this.#sweeping.add(serverId);

    let applied = 0;
    let duplicated = 0;
    let refused = 0;
    let found = 0;
    /** Quantas vezes a janela teve de encolher. Só para o log. */
    let shrunk = 0;
    const confirm: string[] = [];

    /** `null` = o laço foi até o fim. Preenchido = onde ele parou. */
    let stopped: string | null = null;

    try {
      let offset = 0;
      let limit = PENDING_PAGE_LIMIT;
      /** O total da fila, que só se conhece depois da 1ª página. */
      let total: number | null = null;

      while (total === null || offset < total) {
        const raw = await rcon.send(buildPendingCommand(offset, limit));

        if (raw.trim() === '') {
          // ####  RESPOSTA VAZIA É COMANDO INEXISTENTE  ####
          //
          // MEDIDO neste projeto (`game/players.ts:430-440`): o
          // console do Rust não reclama de um comando que não
          // conhece — ele apenas não responde. Aqui isso quer dizer
          // "o OrigemZItems não está carregado neste servidor", e
          // dizê-lo poupa a caça a um defeito que não existe.
          stopped = 'o OrigemZItems não respondeu; ele está ligado ali?';
          break;
        }

        const payload = firstJsonLine(raw);
        const refusal = pendingErrorSchema.safeParse(payload);

        if (refusal.success && refusal.data.error === PENDING_TOO_LARGE) {
          // ####  A JANELA ENCOLHE, E O OFFSET NÃO ANDA  ####
          //
          // O mesmo laço do snapshot de blueprints
          // (`wipe/blueprints.ts`). Avançar aqui pularia justamente
          // os eventos que não couberam — e eles são conversões cujo
          // item já foi destruído.
          if (limit <= 1) {
            // Um evento sozinho maior que o frame é corrupção, não
            // volume. Parar é melhor que girar para sempre, e o que
            // já entrou nas páginas anteriores continua valendo.
            stopped =
              `o evento na posição ${String(offset)} não cabe sozinho numa resposta do ` +
              `${PENDING_COMMAND}; a varredura parou aí`;
            break;
          }

          limit = Math.max(1, Math.floor(limit / 2));
          shrunk += 1;
          continue;
        }

        const parsed = pendingResponseSchema.safeParse(payload);

        if (!parsed.success) {
          this.#deps.logger.warn(
            { serverId, trigger, response: raw.trim().slice(0, 300) },
            'o OrigemZItems respondeu ao origemz.item.pending fora do contrato',
          );

          stopped = 'a resposta não bate com o contrato';
          break;
        }

        total = parsed.data.count;
        found = parsed.data.count;

        for (const item of parsed.data.pending) {
          const result = this.#applyPayload(serverId, item, 'flush');

          if (result.outcome === 'applied') {
            applied += 1;
          } else if (result.outcome === 'duplicated') {
            duplicated += 1;
          } else {
            // `refused`, `malformed` e `failed` NÃO são confirmados:
            // ver `#applyPayload`. O que o agente não gravou fica na
            // fila do plugin.
            refused += 1;
          }

          if (result.eventId !== null) {
            confirm.push(result.eventId);
          }
        }

        // ####  QUEM AVANÇA É O `limit` DEVOLVIDO  ####
        //
        // E não o pedido (o plugin normaliza para o teto dele), nem
        // o tamanho da página: uma página menor que o `limit` NÃO é
        // fim de lista. Quem diz onde a fila acaba é o `count`.
        //
        // O tamanho da página é o recurso do plugin velho, que não
        // devolve `limit` nenhum — ver o schema.
        const step = parsed.data.limit ?? parsed.data.pending.length;

        if (step <= 0) {
          // Fila vazia num plugin velho: sem esta saída, o laço
          // pediria a mesma página para sempre.
          break;
        }

        offset += step;
      }

      for (const id of confirm) {
        this.#enqueueAck(serverId, id);
      }

      // ####  A CONFIRMAÇÃO SAI AGORA, E NÃO PELO RELÓGIO  ####
      //
      // Aqui não estamos no gancho de console: este caminho já é
      // assíncrono e já tem o RCON na mão. Esperar o debounce
      // deixaria a fila do plugin cheia por mais 250 ms sem motivo —
      // e, pior, o resultado desta função diria "recolhi" antes de o
      // comando ter saído.
      //
      // E ele sai mesmo quando o laço parou no meio: o que já foi
      // gravado precisa ser confirmado, ou o plugin o reenviaria
      // para sempre.
      if (confirm.length > 0) {
        await this.drainAcks(serverId);
      }

      if (found > 0) {
        this.#deps.logger.info(
          { serverId, trigger, found, applied, duplicated, refused, shrunk },
          'fila de pontos do plugin recolhida',
        );
      }

      return { serverId, found, applied, duplicated, refused, skipped: stopped };
    } catch (error) {
      this.#deps.logger.warn(
        { serverId, trigger, err: toError(error) },
        'não consegui ler a fila de pontos do plugin',
      );

      // ####  O QUE JÁ ENTROU CONTINUA VALENDO  ####
      //
      // O RCON pode cair na terceira página, e as duas primeiras já
      // estão gravadas. Devolver zeros aqui faria o relatório mentir
      // — e os `ack` delas ficam no relógio, para o plugin parar de
      // reenviar o que já foi somado.
      for (const id of confirm) {
        this.#enqueueAck(serverId, id);
      }

      return { serverId, found, applied, duplicated, refused, skipped: toError(error).message };
    } finally {
      this.#sweeping.delete(serverId);
    }
  }

  /**
   * O mesmo, em todos os servidores.
   *
   * Um servidor que falha não segura os outros: o motivo dele já vai
   * no `skipped` do resultado.
   */
  async sweepAll(trigger: string): Promise<readonly PendingSweepResult[]> {
    const results: PendingSweepResult[] = [];

    for (const serverId of this.#deps.servers.ids()) {
      results.push(await this.sweep(serverId, trigger));
    }

    return results;
  }

  // ==========================================================
  //  O RELÓGIO
  // ==========================================================

  /** A varredura periódica. Ver `SWEEP_MS`. */
  start(): void {
    if (this.#sweepTimer !== null) {
      return;
    }

    const timer = setInterval(() => {
      void this.sweepAll('relógio').catch((error: unknown) => {
        this.#deps.logger.error({ err: toError(error) }, 'a varredura da fila de pontos lançou');
      });
    }, this.#deps.sweepMs ?? SWEEP_MS);

    timer.unref();
    this.#sweepTimer = timer;
  }

  /**
   * Para os relógios. Só o desligamento chama.
   *
   * O que estava esperando confirmação NÃO se perde: ele já está no
   * banco, e a fila do plugin o reoferece na próxima subida do
   * agente. É exatamente para isso que ela grava em disco.
   */
  stop(): void {
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }

    for (const timer of this.#ackTimers.values()) {
      clearTimeout(timer);
    }

    this.#ackTimers.clear();
  }
}

// ------------------------------------------------------------
//  Auxiliares
// ------------------------------------------------------------

/**
 * Quebra a lista em pedaços que caibam num comando.
 *
 * Um id sozinho maior que o teto ainda sai, sozinho: cortá-lo
 * produziria um `ack` de um id que não existe, e a conversão
 * ficaria presa na fila para sempre. Melhor um comando grande
 * demais, que o plugin recusa com barulho, do que uma confirmação
 * silenciosamente errada.
 */
export function chunkByLength(ids: readonly string[], maxChars: number): readonly string[][] {
  const batches: string[][] = [];

  let current: string[] = [];
  let length = 0;

  for (const id of ids) {
    // `+ 1` pelo espaço que separa este id do anterior.
    const cost = current.length === 0 ? id.length : id.length + 1;

    if (current.length > 0 && length + cost > maxChars) {
      batches.push(current);
      current = [];
      length = 0;
    }

    length += current.length === 0 ? id.length : id.length + 1;
    current.push(id);
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/** Um campo de texto de um payload que ainda não foi validado. */
function readString(payload: unknown, field: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[field];

  return typeof value === 'string' ? value : undefined;
}

/** Idem, para número. `null` = não é número (ou nem existe). */
function readNumber(payload: unknown, field: string): number | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const value = (payload as Record<string, unknown>)[field];

  return typeof value === 'number' ? value : null;
}
