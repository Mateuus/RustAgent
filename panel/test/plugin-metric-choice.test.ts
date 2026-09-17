// ============================================================
//  O aviso da métrica que o plugin não conta.
//
//  O ranking "Madeira" (`farm.madeira`, origem plugin) salvou e
//  ficou em zero em 16/09/2026. O core recusa ao salvar; este lado
//  avisa enquanto o admin digita — e as duas listas têm de ser a
//  mesma.
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  checkPluginMetric,
  FIXED_PLUGIN_METRICS,
  gatherShortnameOf,
} from '@/components/ranking/plugin-metric-choice';

describe('a métrica de um ranking do plugin, no painel', () => {
  it('aceita as chaves do plugin e a coleta', () => {
    expect(checkPluginMetric('ore.metal')).toEqual({ ok: true, suggestion: null });
    expect(checkPluginMetric('gather.wood')).toEqual({ ok: true, suggestion: null });
  });

  it('`farm.madeira` não conta, e a sugestão é `gather.wood`', () => {
    expect(checkPluginMetric('farm.madeira')).toEqual({ ok: false, suggestion: 'gather.wood' });
  });

  it('sem palpite, só avisa', () => {
    expect(checkPluginMetric('farm.xyz')).toEqual({ ok: false, suggestion: null });
  });

  it('o shortname sai do que vem depois do prefixo', () => {
    expect(gatherShortnameOf('gather.metal.ore')).toBe('metal.ore');
    expect(gatherShortnameOf('gather.')).toBeNull();
  });

  it('a lista é a mesma do core', () => {
    const core = readFileSync(
      fileURLToPath(new URL('../../core/src/rankings/plugin-metrics.ts', import.meta.url)),
      'utf8',
    );
    const block = /FIXED_PLUGIN_METRICS: readonly string\[\] = \[([\s\S]*?)\];/.exec(core)?.[1] ?? '';
    const keys = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);

    expect(keys).toEqual(FIXED_PLUGIN_METRICS);
  });
});
