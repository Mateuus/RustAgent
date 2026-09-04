// ============================================================
//  machine.ts  -  o retrato da MÁQUINA, numa leitura só.
//
//  ####  NÃO EXISTE CPU EM PORCENTAGEM, E É DELIBERADO  ####
//
//  Ela exige DUAS leituras separadas no tempo (o `os.cpus()` dá
//  tempo acumulado desde o boot), e uma leitura só produziria a
//  média desde que a máquina ligou — um número que não muda e que
//  ninguém sabe interpretar. A decisão está escrita por extenso em
//  `http/routes/system.ts`, e este arquivo é o mesmo acordo em
//  forma de função: quem quiser CPU% precisa de um amostrador, e
//  ele não existe.
//
//  ####  NO WINDOWS O `loadavg` É SEMPRE [0,0,0]  ####
//
//  Devolver isso seria inventar uma medida — e o agente roda no
//  Windows. Por isso `load1` vem `null` lá, e o `null` viaja até o
//  site: um zero seria lido como "máquina ociosa".
// ============================================================

import { cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from 'node:os';

import type { DiskUsage } from './disk.js';

export interface MachineSnapshot {
  readonly hostname: string;
  readonly platform: string;
  readonly cpu: {
    readonly model: string | null;
    readonly cores: number;
    readonly speedMhz: number | null;
  };
  readonly memory: { readonly total: number; readonly free: number };
  /** `total: 0, free: 0` = o sistema não respondeu. Ver `diskUsage`. */
  readonly disk: DiskUsage;
  readonly uptimeSeconds: number;
  /** `null` no Windows, sempre. Ver o cabeçalho. */
  readonly load1: number | null;
}

/**
 * A carga do último minuto, ou `null` quando o sistema não a mede.
 *
 * Ela mora aqui — e não nos dois leitores — porque uma segunda
 * cópia da regra discordaria desta no dia em que alguém mudasse o
 * critério do zero.
 */
export function load1Of(load: readonly number[]): number | null {
  return load[0] === 0 && load[1] === 0 && load[2] === 0 ? null : (load[0] ?? null);
}

export interface MachineProbe {
  /** O `loadavg()` do sistema. Injetável para o teste. */
  readonly load?: readonly number[];
  /** `null` = não deu para ler o disco. Ver `disk` acima. */
  readonly disk?: DiskUsage | null;
}

/** Uma leitura da máquina. Síncrona: o disco vem pronto de fora. */
export function machineSnapshot(probe: MachineProbe = {}): MachineSnapshot {
  const processors = cpus();

  return {
    hostname: hostname(),
    platform: platform(),
    cpu: {
      model: processors[0]?.model.trim() ?? null,
      cores: processors.length,
      speedMhz: processors[0]?.speed ?? null,
    },
    memory: { total: totalmem(), free: freemem() },
    // ####  ZERO AQUI É "NÃO SEI", E O CONTRATO PEDE O OBJETO  ####
    //
    // O corpo do site declara `disk` sempre presente, com dois
    // números. Quando o `statfs` não responde (disco de rede,
    // contêiner), o par vai zerado — que é exatamente o exemplo do
    // contrato. Quem desenhar a tela do outro lado precisa saber
    // disso: `total: 0` não é disco cheio, é leitura ausente.
    disk: probe.disk ?? { total: 0, free: 0 },
    uptimeSeconds: Math.floor(uptime()),
    load1: load1Of(probe.load ?? loadavg()),
  };
}
