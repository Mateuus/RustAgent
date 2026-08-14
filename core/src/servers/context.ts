// ============================================================
//  context.ts  -  o que um servidor LIGADO tem.
//
//  Ligado NÃO quer dizer no ar: ligado é o agente CUIDAR daquele
//  servidor — manter a conexão WebRCON de pé e aceitar as
//  operações dele. Subir o jogo é `server-start`.
//
//  Tudo o que vive por servidor mora aqui dentro, e não em
//  variável de módulo: é o que permite ligar o `pvp2` sem tocar
//  no `pve`, e desligar um sem deixar relógio batendo.
//
//  ####  O QUE ELE NÃO TEM  ####
//
//  Na Fase 1 são duas peças: o cliente RCON e o serviço de
//  operações. O projeto anterior montava quinze serviços aqui
//  (loja, VIP, avisos, propagandas…), cada um com o relógio dele
//  — e cada relógio é uma coisa que continua batendo se o
//  `stop()` esquecer dela.
// ============================================================

import type { AgentPaths, ServerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { OperationLock, OperationStore } from '../ops/operations.js';
import { OperationsService } from '../ops/service.js';
import { RconClient } from '../rcon/client.js';
import { ConsoleBuffer } from './console-buffer.js';

export interface ServerContextDeps {
  readonly paths: AgentPaths;
  readonly store: OperationStore;
  readonly lock: OperationLock;
  readonly logger: Logger;
  readonly startTimeoutMs: number;
  /**
   * Chamado toda vez que o RCON deste servidor conecta.
   *
   * ####  É O GANCHO DA RECONCILIAÇÃO  ####
   *
   * A lista de banidos do agente e o `bans.cfg` do servidor podem
   * divergir enquanto eles não se falam — alguém banindo à mão no
   * console, um ban de rede aplicado com o servidor parado. O
   * momento de fechar essa diferença é exatamente este: quando o
   * agente volta a alcançar o servidor.
   *
   * Cobre os três momentos do briefing de uma vez, porque os três
   * passam por aqui: o boot do agente, o servidor sendo ligado e a
   * reconexão do RCON.
   */
  readonly onRconConnected?: (serverId: string) => void;
}

export class ServerContext {
  readonly config: ServerConfig;
  readonly rcon: RconClient;
  readonly operations: OperationsService;
  /** O que o servidor está dizendo agora. Ver console-buffer.ts. */
  readonly console = new ConsoleBuffer();

  constructor(config: ServerConfig, deps: ServerContextDeps) {
    this.config = config;

    // O logger ganha o id do servidor: com quatro servidores no
    // ar, "rcon connection closed" sem dono é uma linha inútil.
    const logger = deps.logger.child({ server: config.id });

    this.rcon = new RconClient({
      host: config.rcon.host,
      port: config.rcon.port,
      password: config.rcon.password,
      logger,
    });

    // Toda linha que o servidor manda sem ser resposta de comando
    // vai para o buffer — é o que a tela de Console mostra. O
    // ouvinte é montado no CONSTRUTOR, e não no `start()`: as
    // primeiras linhas chegam junto com a conexão.
    //
    // ####  O CHAT NÃO SAI DAQUI  ####
    //
    // Ele já saiu: havia um `ChatBuffer` alimentado por este mesmo
    // evento, e ele ficava VAZIO num servidor com plugin de chat.
    // Um plugin que formata a mensagem cancela a original, e com
    // ela some o frame de chat do WebRCON. A aba lê o histórico do
    // próprio jogo (`chat.tail`) — ver game/chat.ts.
    this.rcon.on('log', (entry) => {
      this.console.push(entry);
    });

    this.rcon.on('connected', () => {
      this.console.pushLocal('conectado ao RCON');

      // Ver `onRconConnected`: é aqui que a lista de banidos deste
      // servidor volta a ser conferida. O `try` existe porque um
      // erro num ouvinte de evento derrubaria a conexão que acabou
      // de subir — e a lista pode esperar, a conexão não.
      try {
        deps.onRconConnected?.(config.id);
      } catch (error) {
        logger.warn({ err: error }, 'o gancho de reconexão falhou');
      }
    });

    this.rcon.on('disconnected', (info) => {
      this.console.pushLocal(
        `conexão com o RCON caiu (${String(info.code)}${info.reason === '' ? '' : ` ${info.reason}`})`,
        'Warning',
      );
    });

    this.operations = new OperationsService({
      server: config,
      paths: deps.paths,
      store: deps.store,
      lock: deps.lock,
      rcon: this.rcon,
      logger,
      startTimeoutMs: deps.startTimeoutMs,
    });
  }

  get id(): string {
    return this.config.id;
  }

  /**
   * Começa a cuidar do servidor.
   *
   * `connect()` não espera nada: o servidor de jogo pode estar
   * parado, e o cliente fica reconectando com recuo crescente até
   * ele aparecer. É o comportamento certo para um processo 24/7 —
   * mas é também o motivo de um servidor SEM O JOGO INSTALADO
   * nunca ser montado (ver supervisor.ts).
   */
  start(): void {
    this.rcon.connect();
  }

  /**
   * Para de cuidar.
   *
   * A ordem importa: o socket por último, para que nada tente
   * mandar comando num cliente já fechado.
   */
  async stop(): Promise<void> {
    await this.rcon.close();
  }

  /** O que o `/health` e a lista de servidores mostram. */
  status(): { readonly connected: boolean; readonly state: string } {
    return { connected: this.rcon.isConnected, state: this.rcon.state };
  }
}
