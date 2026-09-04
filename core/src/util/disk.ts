// ============================================================
//  disk.ts  -  quanto cabe ainda, no disco onde o jogo mora.
//
//  ####  `null` NÃO É ZERO  ####
//
//  O `statfs` não responde em disco de rede e em alguns
//  contêineres. Um `0` ali seria lido como "disco cheio" e
//  assustaria à toa — a mesma disciplina do resto do agente:
//  ausente é ausente, e nunca um número plausível inventado.
//
//  Ele mora aqui, e não na rota, porque agora há DOIS leitores: a
//  tela de sistema (`http/routes/system.ts`) e o retrato que sobe
//  para o site (`site/status.ts`). Duas cópias divergiriam no dia
//  em que uma delas trocasse `bavail` por `bfree`.
// ============================================================

import { statfs } from 'node:fs/promises';

export interface DiskUsage {
  readonly total: number;
  readonly free: number;
}

/** O espaço daquele caminho. `null` = o sistema não respondeu. */
export async function diskUsage(path: string): Promise<DiskUsage | null> {
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
