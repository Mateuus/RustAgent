// ============================================================
//  routes/health.ts  -  GET /health, sem autenticação.
//
//  ####  ELE RESPONDE 200 COM O RCON FORA DO AR  ####
//
//  O processo do AGENTE está saudável; o servidor de jogo é que
//  pode estar reiniciando, atualizando ou nem instalado. Devolver
//  503 aqui faria o PM2 reiniciar o agente no meio de um wipe — e
//  levar junto o estado das operações em curso.
//
//  Quem quiser alarmar com o jogo fora do ar olha
//  `servers[].rcon.connected`, que é a informação certa para essa
//  pergunta.
// ============================================================

import type { FastifyInstance } from 'fastify';

export interface HealthServerView {
  readonly id: string;
  readonly enabled: boolean;
  readonly rcon: { readonly connected: boolean; readonly state: string } | null;
}

export interface HealthDeps {
  readonly version: string;
  readonly startedAt: number;
  /** O retrato de agora — chamado a cada requisição, não cacheado. */
  readonly servers: () => readonly HealthServerView[];
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async () => {
    const servers = deps.servers();

    // "degraded" = há servidor ligado cujo RCON não responde.
    // Servidor DESLIGADO não conta: ninguém pediu que ele
    // estivesse no ar.
    const degraded = servers.some((server) => server.enabled && server.rcon?.connected !== true);

    return {
      ok: true,
      status: degraded ? 'degraded' : 'ok',
      version: deps.version,
      startedAt: new Date(deps.startedAt).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      servers,
    };
  });
}
