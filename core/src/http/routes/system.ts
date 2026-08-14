// ============================================================
//  routes/system.ts  -  a MÁQUINA e o AGENTE.
//
//  O painel abre no Dashboard, e a primeira pergunta de quem
//  administra um dedicado não é sobre um servidor: é "esta máquina
//  aguenta mais um?". Núcleos, memória e disco livre respondem
//  isso — e são justamente o que ninguém quer abrir o Gerenciador
//  de Tarefas para ver.
//
//  ####  O QUE NÃO ESTÁ AQUI, E POR QUÊ  ####
//
//  Uso de CPU em porcentagem. Ele exige DUAS leituras separadas no
//  tempo (o `os.cpus()` dá tempo acumulado desde o boot), e uma
//  leitura só produziria a média desde que a máquina ligou — um
//  número que não muda e que ninguém sabe interpretar. O que dá
//  para saber com uma leitura é a CARGA (`loadavg`), e é ela que
//  vai; no Windows ela é sempre 0, e aí o campo vem `null` em vez
//  de mentir um zero.
// ============================================================

import { statfs } from 'node:fs/promises';
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
} from 'node:os';

import type { FastifyInstance } from 'fastify';

import type { AgentPaths } from '../../config.js';
import type { ServerSupervisor } from '../../servers/supervisor.js';

export interface SystemRoutesDeps {
  readonly paths: AgentPaths;
  readonly supervisor: ServerSupervisor;
  readonly version: string;
  readonly startedAt: number;
}

/**
 * Espaço no disco onde as instalações moram.
 *
 * `null` quando o sistema não responde — o que acontece em disco
 * de rede e em alguns contêineres. Um `0` ali seria lido como
 * "disco cheio" e assustaria à toa.
 */
async function diskOf(path: string): Promise<{ total: number; free: number } | null> {
  try {
    const stats = await statfs(path);

    return {
      total: Number(stats.blocks) * Number(stats.bsize),
      // `bavail` (disponível para quem NÃO é root), e não `bfree`:
      // é o número que corresponde ao que o download vai conseguir
      // usar de fato.
      free: Number(stats.bavail) * Number(stats.bsize),
    };
  } catch {
    return null;
  }
}

export function registerSystemRoutes(app: FastifyInstance, deps: SystemRoutesDeps): void {
  app.get('/system', async () => {
    const processors = cpus();

    await deps.supervisor.scanProcesses();

    const servers = deps.supervisor.list();

    // A pasta pode ainda não existir (máquina nova, nenhum
    // servidor instalado). Aí a pergunta certa é sobre a raiz do
    // projeto, que existe sempre.
    const disk = (await diskOf(deps.paths.serversDir)) ?? (await diskOf(deps.paths.root));

    const load = loadavg();

    return {
      ok: true,

      machine: {
        hostname: hostname(),
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: {
          model: processors[0]?.model.trim() ?? null,
          cores: processors.length,
          speedMhz: processors[0]?.speed ?? null,
        },
        // No Windows o `loadavg` é sempre [0,0,0] — devolver isso
        // seria inventar uma medida. Ver o cabeçalho.
        load1: load[0] === 0 && load[1] === 0 && load[2] === 0 ? null : (load[0] ?? null),
        memory: { total: totalmem(), free: freemem() },
        disk,
        uptimeSeconds: Math.floor(uptime()),
      },

      agent: {
        version: deps.version,
        startedAt: new Date(deps.startedAt).toISOString(),
        uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
        pid: process.pid,
        node: process.version,
        // O que o PROCESSO do agente ocupa. Ele fica na casa das
        // dezenas de MB; um número muito acima disso é vazamento,
        // e é bom que dê para ver sem ferramenta.
        rssBytes: process.memoryUsage().rss,
        paths: {
          root: deps.paths.root,
          servers: deps.paths.serversDir,
          steamCmd: deps.paths.steamCmdDir,
          logs: deps.paths.logsDir,
        },
      },

      servers: {
        total: servers.length,
        installed: servers.filter((server) => server.installed).length,
        // "Cuidado pelo agente" — não é o mesmo que estar no ar.
        enabled: servers.filter((server) => server.enabled).length,
        // "No ar" é o PROCESSO existir — inclusive o que roda sem
        // o agente cuidar dele. Contar só os de RCON conectado
        // diria "0 no ar" com o servidor cheio de gente.
        online: servers.filter((server) => server.running === true).length,
        // A soma dos slots dá a capacidade da máquina em jogadores,
        // que é a outra metade de "aguenta mais um?".
        maxPlayers: servers.reduce((sum, server) => sum + server.maxPlayers, 0),
      },
    };
  });
}
