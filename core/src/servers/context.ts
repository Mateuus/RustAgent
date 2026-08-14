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

export interface ServerContextDeps {
  readonly paths: AgentPaths;
  readonly store: OperationStore;
  readonly lock: OperationLock;
  readonly logger: Logger;
  readonly startTimeoutMs: number;
}

export class ServerContext {
  readonly config: ServerConfig;
  readonly rcon: RconClient;
  readonly operations: OperationsService;

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
