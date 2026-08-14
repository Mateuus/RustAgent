// ============================================================
//  ports.ts  -  as QUATRO portas de cada servidor de Rust.
//
//  Um servidor dedicado não abre uma porta, abre quatro:
//
//      server.port      UDP   o jogo
//      server.queryport UDP   a consulta da Steam (lista, A2S)
//      rcon.port        TCP   o WebRCON — por onde o agente fala
//      app.port         TCP   o companion (Rust+), padrão 28082
//
//  Enquanto havia UM servidor na máquina isso era paisagem: os
//  padrões da Facepunch nunca colidem entre si. Com dois, passa a
//  ser a primeira coisa que quebra — e quebra MAL.
//
//  ------------------------------------------------------------
//  ####  O SINTOMA DE UMA PORTA REPETIDA NÃO É UM ERRO  ####
//
//  O segundo RustDedicated que tenta escutar numa porta ocupada
//  não recusa a subir. Ele carrega o mundo inteiro (minutos), grita
//  a falha no meio de dez mil linhas de log e SEGUE rodando — sem
//  aparecer na lista da Steam, ou sem aceitar RCON, dependendo de
//  qual das quatro foi.
//
//  Quem está olhando vê "o servidor subiu" e um servidor vazio.
//  Por isso a checagem acontece ANTES do start, e por isso ela
//  fala o nome dos dois servidores e o número da porta: o custo de
//  descobrir isso depois é uma madrugada.
//
//  ------------------------------------------------------------
//  ####  PROTOCOLO IMPORTA  ####
//
//  TCP 28016 e UDP 28016 são portas DIFERENTES para o sistema
//  operacional; as duas podem estar abertas ao mesmo tempo, por
//  processos diferentes, sem conflito nenhum.
//
//  Então a colisão aqui é sempre (número, protocolo). Tratar só o
//  número acusaria conflito onde não há — e um alarme falso na
//  primeira semana é a maneira mais rápida de alguém desligar a
//  checagem inteira.
// ============================================================

import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';

/** Como a porta é aberta. Ver o bloco PROTOCOLO IMPORTA acima. */
export type PortProtocol = 'tcp' | 'udp';

/** Os quatro campos de porta que um servidor tem. */
export type PortField = 'gamePort' | 'queryPort' | 'rconPort' | 'appPort';

// ------------------------------------------------------------
//  O bloco 0 é, deliberadamente, o servidor de hoje.
//
//  28015/28016/28017/28082 são os padrões da Facepunch e são os
//  valores que o `Configs\server.ini` deste ambiente já tem. Fazer
//  o bloco 0 ser qualquer outra coisa significaria que o primeiro
//  servidor migrado mudaria de porta — e mudar de porta é mudar o
//  endereço que os jogadores têm salvo.
// ------------------------------------------------------------
export const FIRST_GAME_PORT = 28015;
export const FIRST_RCON_PORT = 28016;
export const FIRST_QUERY_PORT = 28017;
export const FIRST_APP_PORT = 28082;

/**
 * O espaçamento entre blocos.
 *
 * 100 é folgado de propósito. O aperto seria 68 (a distância entre
 * a porta do jogo e a do companion), e um bloco apertado não deixa
 * espaço para a Facepunch acrescentar uma quinta porta — o que já
 * aconteceu uma vez, quando o Rust+ nasceu.
 */
export const PORT_BLOCK_STRIDE = 100;

/**
 * O último bloco que cabe em 16 bits.
 *
 * `28082 + 374 * 100 = 65482`; o bloco 375 estouraria os 65535 na
 * porta do companion. Não é um limite prático (374 servidores de
 * Rust numa máquina só é ficção) — é a garantia de que nenhuma
 * sugestão daqui devolve um número que o sistema não aceita.
 */
export const MAX_PORT_BLOCK = 374;

/** As quatro portas de um bloco, já calculadas. */
export interface PortBlock {
  /** O N do bloco. 0 = o servidor de hoje. */
  readonly index: number;
  readonly gamePort: number;
  readonly rconPort: number;
  readonly queryPort: number;
  readonly appPort: number;
}

/**
 * O mínimo que este módulo precisa saber sobre um servidor.
 *
 * Declarado aqui, e não importado de `config.ts`, para o módulo de
 * portas não depender do módulo que carrega o `.env`: um teste de
 * porta não deveria arrastar o dotenv junto. `ServerConfig`
 * satisfaz esta interface por estrutura.
 */
export interface ServerPortAssignment {
  readonly id: string;
  readonly gamePort: number;
  readonly rconPort: number;
  readonly queryPort: number;
  readonly appPort: number;
}

/**
 * A tabela que manda em tudo aqui: campo, protocolo e o nome que
 * aparece na mensagem de erro.
 *
 * A ORDEM é significativa — ela é a ordem em que os conflitos são
 * relatados, e mensagem de erro estável é mensagem que dá para
 * procurar no log.
 */
export const PORT_FIELDS: readonly {
  readonly field: PortField;
  readonly protocol: PortProtocol;
  /** Como a porta é chamada em português, para a mensagem. */
  readonly label: string;
  /** A chave equivalente em `Configs\<id>.ini`. */
  readonly iniKey: string;
}[] = [
  { field: 'gamePort', protocol: 'udp', label: 'porta do jogo', iniKey: 'SERVER_PORT' },
  { field: 'queryPort', protocol: 'udp', label: 'porta de query', iniKey: 'SERVER_QUERYPORT' },
  { field: 'rconPort', protocol: 'tcp', label: 'porta do RCON', iniKey: 'RCON_PORT' },
  { field: 'appPort', protocol: 'tcp', label: 'porta do companion', iniKey: 'SERVER_APPPORT' },
];

/**
 * Erro de porta. Separado de `ConfigError` porque o momento é
 * outro: este nasce na hora de SUBIR um servidor, com o operador
 * olhando o painel, e não na leitura do `.env`.
 */
export class PortConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortConflictError';
  }
}

/** `tcp:28016` — a identidade de uma porta de verdade. */
function portKey(protocol: PortProtocol, port: number): string {
  return `${protocol}:${String(port)}`;
}

/** `28016/TCP`, do jeito que se escreve numa mensagem. */
function describePort(protocol: PortProtocol, port: number): string {
  return `${String(port)}/${protocol.toUpperCase()}`;
}

/**
 * As quatro portas do bloco N.
 *
 * @throws {RangeError} fora de `0..MAX_PORT_BLOCK`.
 */
export function portBlock(index: number): PortBlock {
  if (!Number.isInteger(index) || index < 0 || index > MAX_PORT_BLOCK) {
    throw new RangeError(
      `Bloco de portas inválido: ${String(index)}. ` +
        `Precisa ser um inteiro entre 0 e ${String(MAX_PORT_BLOCK)}.`,
    );
  }

  const offset = index * PORT_BLOCK_STRIDE;

  return {
    index,
    gamePort: FIRST_GAME_PORT + offset,
    rconPort: FIRST_RCON_PORT + offset,
    queryPort: FIRST_QUERY_PORT + offset,
    appPort: FIRST_APP_PORT + offset,
  };
}

/**
 * De qual bloco esta porta de jogo é?
 *
 * `null` quando o número não cai no início de nenhum bloco — que é
 * o caso de todo servidor configurado na mão antes desta régua
 * existir. Não é erro: é a informação de que aquele servidor não
 * pertence à grade, e por isso `suggestPortBlock` trata as portas
 * dele uma a uma em vez de riscar um bloco inteiro.
 */
export function blockIndexForGamePort(gamePort: number): number | null {
  const offset = gamePort - FIRST_GAME_PORT;

  if (offset < 0 || offset % PORT_BLOCK_STRIDE !== 0) {
    return null;
  }

  const index = offset / PORT_BLOCK_STRIDE;

  return index > MAX_PORT_BLOCK ? null : index;
}

/**
 * O próximo bloco livre.
 *
 * Aceita, misturados, índices de bloco (`0`, `1`, …) e servidores
 * já configurados. Servidor entra pelas QUATRO portas dele, e não
 * pelo bloco: quem configurou `28100` na mão não está em bloco
 * nenhum, e mesmo assim a sugestão precisa desviar dele.
 *
 * Devolve sempre o MENOR bloco livre, e não o próximo depois do
 * maior usado: apagar um servidor devolve o bloco dele para o
 * começo da fila, em vez de deixar um buraco permanente.
 *
 * @throws {RangeError} quando não sobrou bloco nenhum.
 */
export function suggestPortBlock(
  usedBlocks: Iterable<number | ServerPortAssignment>,
): PortBlock {
  const takenIndexes = new Set<number>();
  const takenPorts = new Set<string>();

  const takeBlock = (block: PortBlock): void => {
    takenIndexes.add(block.index);

    for (const { field, protocol } of PORT_FIELDS) {
      takenPorts.add(portKey(protocol, block[field]));
    }
  };

  for (const used of usedBlocks) {
    if (typeof used === 'number') {
      takeBlock(portBlock(used));
      continue;
    }

    for (const { field, protocol } of PORT_FIELDS) {
      takenPorts.add(portKey(protocol, used[field]));
    }
  }

  for (let index = 0; index <= MAX_PORT_BLOCK; index += 1) {
    if (takenIndexes.has(index)) {
      continue;
    }

    const candidate = portBlock(index);

    const collides = PORT_FIELDS.some(({ field, protocol }) =>
      takenPorts.has(portKey(protocol, candidate[field])),
    );

    if (!collides) {
      return candidate;
    }
  }

  throw new RangeError(
    `Não há bloco de portas livre: os ${String(MAX_PORT_BLOCK + 1)} blocos ` +
      'da grade já estão ocupados.',
  );
}

/** Quem está segurando uma porta disputada. */
export interface PortConflictHolder {
  readonly serverId: string;
  readonly field: PortField;
  /** `porta do jogo`, `porta do RCON`… */
  readonly label: string;
}

/** Uma porta que dois (ou mais) donos reivindicam. */
export interface PortConflict {
  readonly port: number;
  readonly protocol: PortProtocol;
  readonly holders: readonly PortConflictHolder[];
  /** Pronta para ir para o log ou para a tela, em português. */
  readonly message: string;
}

/**
 * Procura colisão entre as portas dos servidores dados.
 *
 * DEVOLVE os conflitos em vez de lançar: quem chama decide se
 * aquilo derruba o boot (a leitura da configuração) ou vira um
 * aviso na tela (a tela de cadastro de servidor, que precisa
 * mostrar o problema enquanto a pessoa ainda está digitando).
 *
 * Lista vazia = está tudo certo.
 *
 * A checagem é por (número, protocolo) — ver o cabeçalho. E ela
 * pega também o servidor que colide COM ELE MESMO: `SERVER_PORT`
 * igual a `SERVER_QUERYPORT` é um erro de digitação comum, as duas
 * são UDP, e o Rust sobe sem aparecer na lista da Steam.
 *
 * Servidor desligado não é filtrado aqui de propósito: quem chama
 * passa exatamente o conjunto sobre o qual quer a resposta.
 */
export function validateNoConflicts(
  servers: Iterable<ServerPortAssignment>,
): readonly PortConflict[] {
  const claims = new Map<
    string,
    { readonly port: number; readonly protocol: PortProtocol; readonly holders: PortConflictHolder[] }
  >();

  for (const server of servers) {
    for (const { field, protocol, label } of PORT_FIELDS) {
      const port = server[field];
      const key = portKey(protocol, port);

      let claim = claims.get(key);

      if (claim === undefined) {
        claim = { port, protocol, holders: [] };
        claims.set(key, claim);
      }

      claim.holders.push({ serverId: server.id, field, label });
    }
  }

  const conflicts: PortConflict[] = [];

  for (const claim of claims.values()) {
    if (claim.holders.length < 2) {
      continue;
    }

    const who = claim.holders
      .map((holder) => `${holder.serverId} (${holder.label})`)
      .join(' e ');

    conflicts.push({
      port: claim.port,
      protocol: claim.protocol,
      holders: claim.holders,
      message:
        `A porta ${describePort(claim.protocol, claim.port)} está pedida por ${who}. ` +
        'Dois processos não escutam na mesma porta: um dos dois sobe sem essa porta ' +
        'funcionar, e sem erro visível.',
    });
  }

  return conflicts;
}

/** Opções comuns às checagens que encostam no sistema operacional. */
export interface PortProbeOptions {
  /**
   * Em qual endereço testar.
   *
   * `0.0.0.0` de propósito: é onde o RustDedicated escuta de
   * verdade, e é a checagem mais rigorosa — uma porta livre no
   * curinga está livre em qualquer interface. Testar só o
   * `127.0.0.1` deixaria passar a porta que outro processo já
   * tomou na placa de rede.
   */
  readonly host?: string;
}

const DEFAULT_PROBE_HOST = '0.0.0.0';

/** A sonda TCP: abre um servidor de mentira e vê se o SO deixa. */
function isTcpPortFree(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const probe = createServer();
    let settled = false;

    const finish = (free: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;

      // `close` num servidor que nunca escutou chama o callback com
      // ERR_SERVER_NOT_RUNNING. Não interessa: o que se queria saber
      // já se sabe, e o callback vem de qualquer jeito.
      probe.close(() => {
        resolvePromise(free);
      });
    };

    // Os dois listeners continuam presos depois de `finish` de
    // propósito: um 'error' que chegue atrasado cairia como exceção
    // não tratada se ninguém estivesse ouvindo.
    probe.on('error', () => {
      finish(false);
    });
    probe.on('listening', () => {
      finish(true);
    });

    // `exclusive` desliga o compartilhamento entre workers do
    // cluster. Sem ele, a resposta seria "livre" para uma porta que
    // outro processo do MESMO agente já tem.
    probe.listen({ port, host, exclusive: true });
  });
}

/** A sonda UDP. Mesma ideia, com um socket em vez de um servidor. */
function isUdpPortFree(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    // `reuseAddr: false` é o padrão e está escrito porque é o ponto:
    // com SO_REUSEADDR o bind teria SUCESSO em cima de quem já está
    // lá, e a sonda responderia "livre" para uma porta ocupada.
    const probe = createSocket({ type: 'udp4', reuseAddr: false });
    let settled = false;

    const finish = (free: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;

      try {
        probe.close(() => {
          resolvePromise(free);
        });
      } catch {
        // Socket que nunca chegou a ligar: `close` lança
        // ERR_SOCKET_DGRAM_NOT_RUNNING em vez de chamar o callback.
        resolvePromise(free);
      }
    };

    probe.on('error', () => {
      finish(false);
    });
    probe.on('listening', () => {
      finish(true);
    });

    probe.bind({ port, address: host, exclusive: true });
  });
}

/**
 * A porta está mesmo livre NESTA máquina?
 *
 * `validateNoConflicts` só sabe o que está escrito na
 * configuração. Esta função pergunta ao sistema operacional — que
 * é o único que sabe do servidor que alguém subiu na mão, do
 * antigo que não morreu direito, e do programa que nada tem a ver
 * com Rust e mora naquela porta desde sempre.
 *
 * Ela ABRE e FECHA a porta para descobrir. Há uma corrida
 * inevitável entre a resposta e o start (alguém pode tomar a porta
 * nesse intervalo), e é por isso que ela vale como diagnóstico
 * antecipado, e não como reserva.
 */
export async function isPortFree(
  port: number,
  protocol: PortProtocol,
  options: PortProbeOptions = {},
): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(
      `Porta inválida: ${String(port)}. Precisa ser um inteiro entre 1 e 65535.`,
    );
  }

  const host = options.host ?? DEFAULT_PROBE_HOST;

  return protocol === 'tcp' ? isTcpPortFree(port, host) : isUdpPortFree(port, host);
}

/**
 * As quatro portas deste servidor estão prontas para uso?
 *
 * Junta as duas checagens — a configuração (o servidor colide com
 * ele mesmo?) e o sistema operacional (alguém já está na porta?) —
 * e lança com o texto pronto para aparecer na tela.
 *
 * É o que o start deve chamar ANTES de disparar o
 * `StartServer.bat`. Sem isso, o custo de uma porta ocupada é o
 * mundo inteiro carregando para depois nada funcionar.
 *
 * @throws {PortConflictError}
 */
export async function assertServerPortsAvailable(
  server: ServerPortAssignment,
  options: PortProbeOptions = {},
): Promise<void> {
  const conflicts = validateNoConflicts([server]);

  if (conflicts.length > 0) {
    throw new PortConflictError(
      `O servidor "${server.id}" tem portas repetidas na própria configuração:\n` +
        conflicts.map((conflict) => `  - ${conflict.message}`).join('\n'),
    );
  }

  const checks = await Promise.all(
    PORT_FIELDS.map(async (entry) => ({
      entry,
      free: await isPortFree(server[entry.field], entry.protocol, options),
    })),
  );

  const busy = checks.filter((check) => !check.free);

  if (busy.length === 0) {
    return;
  }

  const lines = busy.map(
    ({ entry }) =>
      `  - ${entry.label} ${describePort(entry.protocol, server[entry.field])} ` +
      `(${entry.iniKey})`,
  );

  throw new PortConflictError(
    `O servidor "${server.id}" não pode subir: já há algo escutando nestas portas:\n` +
      `${lines.join('\n')}\n` +
      'Veja quem é com:  netstat -ano | findstr <porta>\n' +
      `Se for um servidor antigo que não morreu, derrube-o; se for outro programa, ` +
      `mude o bloco de portas deste servidor em Configs\\${server.id}.ini.`,
  );
}
