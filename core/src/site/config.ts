// ============================================================
//  config.ts  -  o que o servidor DEVERIA ser, na opinião do site.
//
//  ####  CONFIG É ESTADO, COMANDO É TAREFA  ####
//
//  Um comando é uma ordem que ENVELHECE: "reinicie agora" perde o
//  sentido em dois minutos, e por isso ele tem prazo, lease e um
//  teto local. Config é uma descrição do mundo: "este servidor tem
//  200 slots" continua verdade amanhã. Dar TTL a ela criaria um
//  servidor que volta sozinho para uma config antiga porque o ACK se
//  perdeu.
//
//  Por isso o que manda aqui é a `version`: um inteiro que só
//  cresce, por servidor. Igual à última aplicada ⇒ nada a fazer, e o
//  laço termina ali.
//
//  ####  E ELA NÃO É REAPLICADA EM LAÇO  ####
//
//  A versão aplicada é gravada mesmo quando a gravação FALHA. O
//  contrário — tentar de novo a cada 30 s — reescreveria o `.ini` de
//  meio em meio minuto, para sempre, por um campo que nunca vai
//  entrar. Quem conserta é o admin, no site, gerando uma versão
//  nova.
//
//  ####  A ARMADILHA MEDIDA: `updateSettings` IGNORA O QUE NÃO SABE
//
//  Ele percorre o patch e faz `if (key === undefined) continue`
//  (`servers/supervisor.ts:591`): campo desconhecido não gera erro,
//  ele DESAPARECE. Um `desired` com um campo que este agente não
//  sabe gravar voltaria `applied: true`, `errors: []`, e o site
//  concluiria que a config está valendo. Por isso a régua é aqui, na
//  fronteira, ANTES da chamada — e o que sobrou vai em `errors[]`.
//
//  ####  `requiresRestart` É MEDIDO, NUNCA ESCRITO À MÃO  ####
//
//  Ele é o retorno do `updateSettings`, e SEIS dos sete campos desta
//  config estão em `RESTART_KEYS`. Ou seja: quase toda gravação
//  vinda do site volta com a lista não-vazia, e isso é INFORMAÇÃO,
//  não falha — é o que faz o painel do site dizer "gravado, vale no
//  próximo start" em vez de "salvo", com o admin concluindo que não
//  funcionou porque o mapa não mudou.
//
//  ####  NADA AQUI LANÇA  ####
//
//  Roda num relógio. Um `throw` para a convergência em silêncio.
//
//  Ver Docs\22-COMANDOS-E-CONFIG-DO-SITE.md §2.4, §2.5 e §3 regra 10.
// ============================================================

import { z } from 'zod';

import type { MetaRepository } from '../db/meta-repository.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import {
  FORBIDDEN_RCON_PASSWORD_CHARS,
  iniText,
  NEW_SERVER_ID_PATTERN,
} from '../servers/create-server.js';
import {
  MAP_LEVELS,
  MAX_SEED,
  MAX_WORLD_SIZE,
  MIN_WORLD_SIZE,
} from '../servers/map-levels.js';
import { toError } from '../util.js';
import type { ConfigFieldError, SiteClient } from './client.js';

/**
 * A cadência.
 *
 * Config é estado: ninguém está esperando na frente da tela, e a
 * volta que não mudou nada custa um 304 sem corpo. 30 s é o mesmo
 * relógio do retrato, e de propósito — os dois laços somados cabem
 * no teto do canal.
 */
export const DEFAULT_CONFIG_INTERVAL_MS = 30_000;
export const MIN_CONFIG_INTERVAL_MS = 10_000;
export const MAX_CONFIG_INTERVAL_MS = 300_000;

/** De quanto em quanto tempo a MESMA linha de erro volta ao log. */
export const LOG_REPEAT_MS = 10 * 60_000;

/** As chaves na tabela `meta`. Prefixo por assunto, como as outras. */
export const CONFIG_VERSION_KEY = 'site.config.version';
export const CONFIG_ETAG_KEY = 'site.config.etag';
export const CONFIG_ACK_KEY = 'site.config.ack';

/** Uma das quatro portas. A régua é a mesma do `patchSchema`. */
const port = (): z.ZodType => z.number().int().min(1).max(65_535);

/**
 * Os campos que este agente grava, e a régua de cada um.
 *
 * ####  ELA REPETE A DO `PATCH /servers/:id`, E ISSO É DE PROPÓSITO
 *
 * As faixas são as mesmas de `map-levels.ts` e do `patchSchema` —
 * mesma fonte, mesmos limites. O que não pode existir é um caminho
 * de escrita SEM régua: o `.ini` é lido no boot do jogo, e um
 * `worldSize` de 40000 vindo do site derrubaria o servidor no
 * próximo start, longe de quem gravou.
 *
 * Campo AUSENTE = "o site não opina sobre ele". Não é `null` e não é
 * "apague": um `desired` que venha só com `hostname` muda `hostname`
 * e mais nada.
 *
 * ####  A LISTA É A TELA DE CONFIGURAÇÃO INTEIRA  ####
 *
 * Ela nasceu com sete campos e hoje tem os mesmos que o painel local
 * edita — decisão do dono em 04/09/2026. Quem acrescentar um campo
 * ao `patchSchema` de `routes/servers.ts` acrescenta aqui também: as
 * duas listas descrevem a MESMA tela, e a que ficar para trás vira
 * um campo que só existe para quem está na máquina.
 */
const FIELD_SCHEMAS = {
  // ---- Geral ----
  name: iniText('name', 80),
  hostname: iniText('hostname', 120),
  // Vazio é legítimo nos três: é como se tira o valor do servidor.
  description: z.union([iniText('description', 500), z.literal('')]),
  url: z.union([iniText('url', 300), z.literal('')]),
  headerImage: z.union([iniText('headerImage', 300), z.literal('')]),

  // ---- Mundo ----
  map: z.enum(MAP_LEVELS),
  worldSize: z.number().int().min(MIN_WORLD_SIZE).max(MAX_WORLD_SIZE),
  seed: z.number().int().min(0).max(MAX_SEED),
  // Vazio = volta ao mundo procedural, gerado a partir da seed.
  levelUrl: z.union([z.string().trim().min(1).max(500), z.literal('')]),
  maxPlayers: z.number().int().min(1).max(1_000),
  saveInterval: z.number().int().min(30).max(86_400),
  /**
   * ####  TROCAR A IDENTITY É MUNDO NOVO  ####
   *
   * Ela é a pasta dos saves: o próximo start carrega um mundo vazio,
   * e o antigo continua em disco sem ninguém dentro. Não é `wipe-run`
   * — nada é apagado —, mas o jogador não distingue os dois.
   *
   * Ela atravessa este canal por decisão do dono em 04/09/2026. O
   * lado do site é que precisa perguntar duas vezes antes de gravar.
   */
  identity: z
    .string()
    .trim()
    .regex(
      NEW_SERVER_ID_PATTERN,
      'identity segue a mesma regra do id: minúsculas, dígitos e hífen',
    ),

  // ---- Rede ----
  //
  // O conflito com OUTRO servidor deste agente é recusado lá dentro
  // (`#assertPortsFree`), e o código dele — `PORT_BLOCK_TAKEN` — sobe
  // inteiro para o `errors[]` do ACK.
  gamePort: port(),
  queryPort: port(),
  appPort: port(),
  rconPort: port(),

  // ---- RCON ----
  //
  // ####  ELA É SEGREDO, E VALE NO PRÓXIMO START  ####
  //
  // Com `RCON_WEB=1`, quem tem esta senha executa qualquer comando
  // neste servidor. Ela atravessa o canal por decisão do dono em
  // 04/09/2026 — e o canal é TLS até a borda do site, mas o valor
  // fica gravado lá. Rotacioná-la pelo painel local invalida a do
  // site sem avisá-lo: o site só descobre na volta seguinte, porque
  // este agente nunca devolve o valor gravado.
  rconPassword: z
    .string()
    .min(8)
    .max(200)
    .refine((value) => !FORBIDDEN_RCON_PASSWORD_CHARS.test(value)),

  // ---- SteamCMD ----
  steamAppId: z.string().regex(/^\d{1,10}$/),
  steamLogin: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  steamBranch: z.union([z.string().max(64), z.literal('')]),

  // ---- O agente ----
  consoleWindow: z.boolean(),
} as const;

/**
 * `enabled` não é campo do `.ini` como os outros.
 *
 * Ele não passa pelo `updateSettings`: quem o escreve é
 * `supervisor.enable()`/`disable()`, que também monta ou desmonta o
 * RCON e o contexto daquele servidor. Mandá-lo no mesmo patch faria
 * o `updateSettings` ignorá-lo em silêncio (`KEY_OF` não o tem), e o
 * site receberia `applied: true` por uma gravação que não aconteceu.
 *
 * ####  DESLIGAR PELO SITE TEM VOLTA  ####
 *
 * O laço de config nasce do PAREAMENTO, não do `enabled`: um servidor
 * desligado continua puxando config, e por isso o site consegue
 * religá-lo. O que ele não consegue é religar o que perdeu o
 * pareamento — ver `BLOCKED_FIELDS`.
 */
const ENABLED_FIELD = 'enabled';

/**
 * `autoUpdate` também não é campo do `.ini`, e procurá-lo lá é
 * perder o dia.
 *
 * Ele não existe em `RESTART_KEYS`, não existe em `KEY_OF` e o
 * `updateSettings` não o conhece — e o `updateSettings` IGNORA EM
 * SILÊNCIO o que não conhece (`supervisor.ts:591`). Mandá-lo no
 * patch devolveria `applied: true`, `errors: []`, e o site
 * concluiria que a atualização automática está desligada enquanto
 * ela continua ligada. É a armadilha do cabeçalho deste arquivo,
 * inteira.
 *
 * ####  QUEM APLICA É O VIGIA DA STEAM  ####
 *
 * `SteamUpdateWatcher.setAutoUpdate(serverId, valor)`, que grava a
 * opinião na tabela `meta` e vale já na rodada seguinte — sem
 * reiniciar o agente. Isso importa: o `requiresRestart` do contrato
 * é do JOGO, e enfiar "reinicie o agente" nele quebraria o
 * significado da lista para todo mundo.
 *
 * ####  TRÊS ESTADOS, E O SITE PRECISA DOS TRÊS  ####
 *
 *   campo ausente  o site não gerencia → o agente segue o padrão
 *                  da máquina (`STEAM_AUTO_UPDATE`)
 *   `false`        gerenciado e DESLIGADO
 *   `true`         gerenciado e ligado
 *
 * Colapsar os dois primeiros é o defeito caro: uma gravação de
 * `hostname` sairia carregando um `autoUpdate: false` que ninguém
 * escolheu, e o servidor pararia de se atualizar. O sintoma não
 * aparece na hora — ele aparece semanas depois, quando a Facepunch
 * publica e o servidor passa a recusar todo mundo.
 *
 * Por isso, aqui, só `boolean` passa: `'false'` é `INVALID_VALUE`,
 * e nunca `Boolean('false')`, que é `true`.
 */
const AUTO_UPDATE_FIELD = 'autoUpdate';

/**
 * O que este canal NÃO grava, e nunca vai gravar.
 *
 * ####  DEIXAR O SITE REESCREVER O PRÓPRIO PAREAMENTO É SEM VOLTA
 *
 * `siteServerId` e `siteToken` são o que faz o agente falar com o
 * site. Um valor errado gravado por este canal derruba o canal que o
 * gravou: não há segunda chance remota, e o conserto é presencial, no
 * painel local. Por isso eles têm código PRÓPRIO, e não
 * `UNKNOWN_FIELD` — o site precisa distinguir "não conheço" (agente
 * velho, campo novo) de "conheço e recuso por desenho".
 */
const BLOCKED_FIELDS: ReadonlySet<string> = new Set(['siteServerId', 'siteToken']);

export const CONFIG_FIELDS = [
  ...Object.keys(FIELD_SCHEMAS),
  ENABLED_FIELD,
  AUTO_UPDATE_FIELD,
] as readonly string[];

/**
 * Os códigos de `errors[].code`.
 *
 * O contrato não fecha um vocabulário para eles (ao contrário do
 * `reason` do comando, que é fechado): o site só os exibe. São três
 * aqui, mais o código cru do `ApiError` quando a GRAVAÇÃO é que
 * falhou — aí o nome que interessa é o do erro real (`PORT_IN_USE`,
 * `PORT_BLOCK_TAKEN`, `SERVER_NOT_INSTALLED`), e não um genérico.
 */
export const CONFIG_ERROR_CODES = {
  /** O agente não conhece este campo. Ver a armadilha no cabeçalho. */
  unknownField: 'UNKNOWN_FIELD',
  /** O campo existe e o valor não passa na régua. */
  invalidValue: 'INVALID_VALUE',
  /** O agente conhece o campo e recusa gravá-lo POR ESTA VIA. */
  notRemotelyWritable: 'FIELD_NOT_REMOTELY_WRITABLE',
} as const;

/** O que a régua separou. */
export interface ConfigPlan {
  readonly patch: Record<string, string | number | boolean>;
  /** `null` = o site não opinou sobre `enabled`. */
  readonly enabled: boolean | null;
  /** `null` = o site NÃO GERENCIA a atualização automática. */
  readonly autoUpdate: boolean | null;
  readonly errors: readonly ConfigFieldError[];
}

/**
 * Separa o que dá para gravar do que não dá.
 *
 * Nada aqui escreve: quem escreve é o `updateSettings` (e o
 * `enable`/`disable`), num lugar só. Isto é a régua que eles não têm.
 */
export function planOfDesired(desired: Record<string, unknown>): ConfigPlan {
  const patch: Record<string, string | number | boolean> = {};
  const errors: ConfigFieldError[] = [];
  let enabled: boolean | null = null;
  let autoUpdate: boolean | null = null;

  for (const [field, value] of Object.entries(desired)) {
    if (BLOCKED_FIELDS.has(field)) {
      errors.push({ field, code: CONFIG_ERROR_CODES.notRemotelyWritable });
      continue;
    }

    if (field === ENABLED_FIELD) {
      if (typeof value === 'boolean') {
        enabled = value;
      } else {
        errors.push({ field, code: CONFIG_ERROR_CODES.invalidValue });
      }

      continue;
    }

    if (field === AUTO_UPDATE_FIELD) {
      // Só `boolean`. Ver o comentário do campo: coagir `'false'`
      // aqui LIGARIA a atualização que o site pediu para desligar.
      if (typeof value === 'boolean') {
        autoUpdate = value;
      } else {
        errors.push({ field, code: CONFIG_ERROR_CODES.invalidValue });
      }

      continue;
    }

    const schema = FIELD_SCHEMAS[field as keyof typeof FIELD_SCHEMAS] as z.ZodType | undefined;

    if (schema === undefined) {
      errors.push({ field, code: CONFIG_ERROR_CODES.unknownField });
      continue;
    }

    const parsed = schema.safeParse(value);

    if (!parsed.success) {
      errors.push({ field, code: CONFIG_ERROR_CODES.invalidValue });
      continue;
    }

    patch[field] = parsed.data as string | number | boolean;
  }

  return { patch, enabled, autoUpdate, errors };
}

/** O ACK, do jeito que ele é guardado até o site confirmar. */
interface PendingAck {
  readonly version: number;
  readonly applied: boolean;
  readonly requiresRestart: readonly string[];
  readonly errors: readonly ConfigFieldError[];
}

export interface SiteConfigOptions {
  readonly client: SiteClient;
  readonly meta: MetaRepository;
  /** O servidor LOCAL. O do site é o `X-Server-Id` do cliente. */
  readonly serverId: string;
  /**
   * Grava no `.ini` e devolve o que só vale no próximo start.
   *
   * É o MESMO `supervisor.updateSettings` que o `PATCH
   * /api/servers/:id` usa. Uma segunda maneira de escrever o `.ini`
   * é a última coisa que este trabalho pode criar.
   *
   * @throws {ApiError} quando a gravação inteira não acontece.
   */
  readonly apply: (patch: Record<string, string | number | boolean>) => readonly string[];
  /**
   * Liga ou desliga o cuidado do agente sobre este servidor.
   *
   * É o MESMO `supervisor.enable()`/`disable()` do `PATCH
   * /api/servers/:id`, e ele faz mais do que escrever uma linha:
   * monta ou desmonta o contexto e o RCON daquele servidor. Por isso
   * ele não cabe no `apply` — ver `ENABLED_FIELD`.
   *
   * @throws {ApiError} 409 quando o jogo não está em disco.
   */
  readonly setEnabled?: (value: boolean) => Promise<void>;
  /**
   * Liga ou desliga a atualização automática DESTE servidor.
   *
   * É o `SteamUpdateWatcher.setAutoUpdate`, e ele grava a opinião na
   * tabela `meta` — vale na rodada seguinte do vigia, sem reiniciar o
   * agente. Ver `AUTO_UPDATE_FIELD`.
   *
   * Ausente = este agente não tem por onde aplicar, e o campo volta
   * em `errors[]` como `FIELD_NOT_REMOTELY_WRITABLE`. Aceitá-lo em
   * silêncio seria dizer `applied: true` por uma escrita que não
   * aconteceu.
   */
  readonly setAutoUpdate?: (value: boolean) => void;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export interface SiteConfigHealth {
  /** A última versão que o agente TENTOU aplicar. */
  readonly appliedVersion: number | null;
  readonly lastPullAt: number | null;
  readonly lastError: string | null;
  /** `true` = há ACK esperando o site. */
  readonly ackPending: boolean;
}

export class SiteConfig {
  readonly #options: SiteConfigOptions;
  readonly #now: () => number;
  readonly #intervalMs: number;

  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #lastPullAt: number | null = null;
  #lastError: string | null = null;
  #lastLogged: { message: string; at: number } | null = null;

  constructor(options: SiteConfigOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
    this.#intervalMs = Math.min(
      MAX_CONFIG_INTERVAL_MS,
      Math.max(MIN_CONFIG_INTERVAL_MS, options.intervalMs ?? DEFAULT_CONFIG_INTERVAL_MS),
    );
  }

  get health(): SiteConfigHealth {
    return {
      appliedVersion: this.#appliedVersion(),
      lastPullAt: this.#lastPullAt,
      lastError: this.#lastError,
      ackPending: this.#pendingAck() !== null,
    };
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.pull();
    }, this.#intervalMs);
    this.#timer.unref();

    void this.pull();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma volta. NUNCA lança e NUNCA rejeita.
   *
   * A ordem — pegar, comparar, aplicar, GRAVAR A VERSÃO, ACKar — é o
   * que impede os dois defeitos deste laço: reaplicar o que já vale,
   * e reaplicar em laço o que falhou.
   */
  async pull(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      const etag = this.#options.meta.read(this.#key(CONFIG_ETAG_KEY));
      const result = await this.#options.client.serverConfig(etag);

      if (!result.ok) {
        this.#lastError = result.reason;
        this.#classify(result.status, result.code);

        return;
      }

      this.#lastPullAt = this.#now();
      this.#lastError = null;

      // O 304 é o desfecho NORMAL: nada mudou desde a última volta.
      // O que pode ter sobrado é um ACK que não passou.
      if (result.body.notModified) {
        await this.#flushAck();

        return;
      }

      const { version, desired } = result.body;

      if (version === null && desired === null) {
        // ####  ISTO É O NORMAL, E NÃO UM DEFEITO  ####
        //
        // É o que o dev responde para um servidor pareado que
        // ninguém configurou ainda: `version: 0, desired: null`.
        // Logar warn a cada 30 s, por servidor, faria o log de um
        // canal SAUDÁVEL parecer quebrado — e é nele que se procura
        // outra coisa.
        return;
      }

      if (version === null || desired === null) {
        // Um dos dois, e não os dois: aí sim é resposta que não dá
        // para ler. Sem `version` não dá para dizer o que este ACK
        // fecha, e sem `desired` não há o que aplicar. Recuar é o
        // certo: a volta seguinte tenta de novo.
        this.#log(
          'warn',
          { serverId: this.#options.serverId },
          'the site sent a server config we cannot read',
        );

        return;
      }

      const applied = this.#appliedVersion();

      if (applied !== null && version <= applied) {
        // Nada a fazer. O `ETag` novo (se houver) entra assim mesmo:
        // ele é o que faz a volta seguinte custar um 304.
        this.#rememberEtag(result.etag ?? null);
        await this.#flushAck();

        return;
      }

      await this.#converge(version, desired, result.etag ?? null);
      await this.#flushAck();
    } catch (error) {
      // Não deveria acontecer — o cliente não lança —, mas o relógio
      // não pode morrer por causa de uma surpresa.
      this.#lastError = toError(error).message;
      this.#log('error', { err: toError(error) }, 'config round failed');
    } finally {
      this.#running = false;
    }
  }

  /**
   * Aplica UMA versão e deixa o ACK pronto, em disco.
   *
   * ####  A VERSÃO É GRAVADA JUNTO COM O ACK, E ANTES DELE  ####
   *
   * Numa transação só: uma queda entre as duas escritas deixaria o
   * agente ou reaplicando o que já gravou, ou devendo um ACK que
   * ninguém sabe que existe.
   */
  async #converge(
    version: number,
    desired: Record<string, unknown>,
    etag: string | null,
  ): Promise<void> {
    const { patch, enabled, autoUpdate, errors } = planOfDesired(desired);
    const fields = Object.keys(patch);

    // ####  `applied` É "ALGUMA COISA ENTROU", NÃO "DEU TUDO CERTO"
    //
    // Ele é `true` com campo em `errors[]` — a gravação parcial
    // aconteceu, e o site precisa saber disso —, e é `true` também
    // quando não havia nada a fazer. O que o deixa `false` é uma
    // rodada que pediu escrita e não escreveu nada.
    let wrote = false;
    let requiresRestart: readonly string[] = [];
    const failures = [...errors];

    if (fields.length > 0) {
      try {
        requiresRestart = this.#options.apply(patch);
        wrote = true;
      } catch (error) {
        // A gravação inteira não aconteceu: nenhum dos campos
        // entrou, e cada um deles precisa aparecer em `errors[]`
        // para o site não mostrar meia verdade.
        const code = error instanceof ApiError ? error.code : 'WRITE_FAILED';

        for (const field of fields) {
          failures.push({ field, code });
        }

        this.#log(
          'error',
          { serverId: this.#options.serverId, version, fields, err: toError(error) },
          'could not write the desired server config',
        );
      }
    }

    // A atualização automática ANTES do `enabled` e DEPOIS do
    // patch: ela não toca no `.ini` e não depende de nada que o
    // patch escreva, mas um servidor que suba na mesma rodada já
    // sobe com a opinião do site valendo.
    if (autoUpdate !== null) {
      const setAutoUpdate = this.#options.setAutoUpdate;

      if (setAutoUpdate === undefined) {
        failures.push({
          field: AUTO_UPDATE_FIELD,
          code: CONFIG_ERROR_CODES.notRemotelyWritable,
        });
      } else {
        try {
          setAutoUpdate(autoUpdate);
          wrote = true;
        } catch (error) {
          failures.push({
            field: AUTO_UPDATE_FIELD,
            code: error instanceof ApiError ? error.code : 'WRITE_FAILED',
          });

          this.#log(
            'error',
            { serverId: this.#options.serverId, version, autoUpdate, err: toError(error) },
            'could not apply the desired auto-update flag',
          );
        }
      }
    }

    // O `enabled` DEPOIS do resto: ligar um servidor cujas portas
    // acabaram de mudar é subir com a config nova, e não com a que
    // ele tinha quando a rodada começou.
    if (enabled !== null) {
      const setEnabled = this.#options.setEnabled;

      if (setEnabled === undefined) {
        // Sem o caminho montado, gravar seria mentir: `updateSettings`
        // ignoraria o campo e o site veria `applied: true`.
        failures.push({ field: ENABLED_FIELD, code: CONFIG_ERROR_CODES.notRemotelyWritable });
      } else {
        try {
          await setEnabled(enabled);
          wrote = true;
        } catch (error) {
          // O caso comum é o 409 de jogo não instalado: ligar um
          // servidor sem o jogo em disco criaria um contexto que
          // reconecta para sempre. O código do `ApiError` sobe
          // inteiro — é ele que diz ao admin o que fazer.
          failures.push({
            field: ENABLED_FIELD,
            code: error instanceof ApiError ? error.code : 'WRITE_FAILED',
          });

          this.#log(
            'error',
            { serverId: this.#options.serverId, version, enabled, err: toError(error) },
            'could not apply the desired enabled flag',
          );
        }
      }
    }

    // Rodada que não pediu escrita nenhuma e não achou erro nenhum
    // também está aplicada: não havia o que fazer, e o site precisa
    // ver a versão fechada em vez de tentá-la para sempre.
    const applied =
      wrote ||
      (errors.length === 0 && fields.length === 0 && enabled === null && autoUpdate === null);
    const ack: PendingAck = { version, applied, requiresRestart, errors: failures };

    this.#options.meta.writeMany(
      {
        [this.#key(CONFIG_VERSION_KEY)]: String(version),
        [this.#key(CONFIG_ACK_KEY)]: JSON.stringify(ack),
        // O `ETag` entra junto: guardá-lo antes de aplicar faria um
        // 304 esconder trabalho por fazer.
        ...(etag === null ? {} : { [this.#key(CONFIG_ETAG_KEY)]: etag }),
      },
      this.#now(),
    );

    if (applied && (fields.length > 0 || enabled !== null || autoUpdate !== null)) {
      this.#options.logger.info(
        {
          serverId: this.#options.serverId,
          version,
          fields,
          enabled,
          autoUpdate,
          requiresRestart,
          errors: failures.length,
        },
        'the desired server config from the site was written',
      );
    }
  }

  /** Manda o ACK guardado, se houver. Só o sucesso o apaga. */
  async #flushAck(): Promise<void> {
    const pending = this.#pendingAck();

    if (pending === null) {
      return;
    }

    const result = await this.#options.client.ackServerConfig({
      // SEMPRE a versão que veio no GET, nunca a "atual".
      version: pending.version,
      applied: pending.applied,
      requiresRestart: pending.requiresRestart,
      errors: pending.errors,
    });

    if (!result.ok) {
      this.#log(
        'warn',
        { serverId: this.#options.serverId, status: result.status, code: result.code },
        'the site refused the server config ack',
      );

      return;
    }

    this.#options.meta.clear(this.#key(CONFIG_ACK_KEY));
  }

  #rememberEtag(etag: string | null): void {
    if (etag === null || etag === this.#options.meta.read(this.#key(CONFIG_ETAG_KEY))) {
      return;
    }

    this.#options.meta.write(this.#key(CONFIG_ETAG_KEY), etag, this.#now());
  }

  #appliedVersion(): number | null {
    const raw = this.#options.meta.read(this.#key(CONFIG_VERSION_KEY));

    if (raw === null || !/^-?\d+$/.test(raw)) {
      return null;
    }

    const parsed = Number(raw);

    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  #pendingAck(): PendingAck | null {
    const raw = this.#options.meta.read(this.#key(CONFIG_ACK_KEY));

    if (raw === null) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as PendingAck;

      return typeof parsed.version === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Uma chave por servidor: a config é DAQUELE pareamento. */
  #key(prefix: string): string {
    return `${prefix}.${this.#options.serverId}`;
  }

  /**
   * A tradução, curta como a do retrato.
   *
   * Config não é dinheiro e não é tarefa com prazo: todo 4xx com
   * código desconhecido é "indisponível", e a volta seguinte tenta
   * de novo. Recuar, nunca fechar.
   */
  #classify(status: number | null, code: string | null): void {
    const serverId = this.#options.serverId;

    if (status === 404 && code === null) {
      this.#log(
        'warn',
        { serverId, status },
        'the site does not answer GET /api/agent/server/config yet',
      );

      return;
    }

    this.#log('warn', { serverId, status, code }, 'could not read the desired server config');
  }

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
