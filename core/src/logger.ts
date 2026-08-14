// ============================================================
//  logger.ts  -  pino, configurado uma vez.
//
//  Log em INGLÊS (código e mensagens de log são em inglês neste
//  projeto; comentários e documentação, em português).
// ============================================================

import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/**
 * Campos que NUNCA podem aparecer no log, em nenhum nível.
 *
 * O redact do pino é uma rede de segurança, não a defesa
 * principal: o código evita passar segredo para o logger, e isto
 * aqui pega o dia em que alguém logar um objeto inteiro por
 * preguiça (`log.debug({ config })`).
 */
const REDACTED_PATHS = [
  'password',
  'rconPassword',
  'apiToken',
  'token',
  'authorization',
  '*.password',
  '*.apiToken',
  'req.headers.authorization',
  'headers.authorization',
];

/**
 * O nome do campo que diz DE QUAL SERVIDOR a linha fala.
 *
 * Uma constante, e não texto solto em cada `child()`: é por este
 * campo que se filtra o log de um servidor no meio do de outros
 * quatro, e um `server` num lugar e `serverId` noutro tornaria o
 * filtro incompleto sem ninguém perceber.
 */
export const SERVER_LOG_FIELD = 'serverId';

/**
 * O pedaço da configuração de que o logger precisa. E nada além.
 *
 * `AgentConfig` satisfaz isto por estrutura. Pedir só o `log`
 * permite que os scripts de `core\scripts\` montem um logger sem
 * carregar a configuração inteira — antes eles espalhavam um
 * `AgentConfig` achatado só para chegar aqui.
 */
export interface LoggerConfig {
  readonly log: {
    readonly level: string;
    readonly pretty: boolean;
  };
}

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.log.level,
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
    base: {
      service: 'rustagent-core',
    },
  };

  if (config.log.pretty) {
    // pino-pretty é dependência de DESENVOLVIMENTO. Em produção
    // LOG_PRETTY fica 0 e este ramo nem é tocado, então a
    // ausência do pacote não derruba o serviço.
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,service',
        },
      },
    });
  }

  return pino(options);
}

/**
 * O logger DE UM SERVIDOR.
 *
 * ####  POR QUE ISTO EXISTE  ####
 *
 * Com mais de um servidor na mesma máquina, o log vira a soma de
 * N fluxos idênticos: cinco linhas "vip state pushed to the
 * plugin" seguidas não dizem se são cinco servidores em dia ou um
 * servidor em laço.
 *
 * Cada `ServerContext` recebe um destes e o repassa a TUDO que
 * monta — RCON, GameService, os quatro syncs, os avisos, o
 * reconcile de admin. Nenhum desses módulos precisou aprender o
 * que é um servidor para que suas linhas passassem a dizer de qual
 * delas se trata.
 *
 * O `child` do pino não copia nada: ele guarda os campos e os
 * escreve na serialização. Um por servidor não custa medida.
 */
export function createServerLogger(parent: Logger, serverId: string): Logger {
  return parent.child({ [SERVER_LOG_FIELD]: serverId });
}
