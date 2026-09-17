// ============================================================
//  rankings-plugin-metrics.test.ts  -  o que o plugin sabe contar.
//
//  O defeito de 16/09/2026: o ranking "Madeira", métrica
//  `farm.madeira`, origem "plugin", ligado — e parado em zero. O
//  plugin só emite o que está escrito nele, e nada pedia `wood`.
//
//  O que se prova aqui:
//
//    1. o cadastro reconhece o que o plugin conta, e recusa o resto
//       com a chave certa na frase;
//    2. a família `gather.<shortname>` vira a lista que viaja no
//       `flush`;
//    3. as chaves fixas daqui são as MESMAS do plugin — as duas
//       cópias divergiriam em silêncio.
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildStatsFlushCommand } from '../src/game/stats-contract.js';
import {
  FIXED_PLUGIN_METRICS,
  gatherShortnameOf,
  gatherShortnamesOf,
  whyNotPluginMetric,
} from '../src/rankings/plugin-metrics.js';

describe('a métrica de um ranking do plugin', () => {
  it('aceita as chaves fixas e a família de coleta', () => {
    expect(whyNotPluginMetric('ore.sulfur')).toBeNull();
    expect(whyNotPluginMetric('pvp.kills')).toBeNull();
    expect(whyNotPluginMetric('gather.wood')).toBeNull();
    expect(whyNotPluginMetric('gather.hq.metal.ore')).toBeNull();
  });

  it('recusa `farm.madeira`, e diz qual é a chave certa', () => {
    const recusa = whyNotPluginMetric('farm.madeira');

    expect(recusa).toContain('"farm.madeira"');
    expect(recusa).toContain('"gather.wood"');
  });

  it('sem palpite, ainda explica como se faz', () => {
    expect(whyNotPluginMetric('quest.completed')).toMatch(/gather\.<shortname do item>/);
  });

  it('`gather.` sozinho não é coleta de nada', () => {
    expect(gatherShortnameOf('gather.')).toBeNull();
    expect(gatherShortnameOf('gather.wood')).toBe('wood');
    expect(gatherShortnameOf('ore.metal')).toBeNull();
  });
});

describe('a lista que vai ao plugin', () => {
  it('só os rankings do plugin, ligados, de coleta — sem repetir e em ordem', () => {
    expect(
      gatherShortnamesOf([
        { metric: 'gather.wood', source: 'plugin', enabled: true },
        { metric: 'gather.cloth', source: 'plugin', enabled: true },
        // Desligado: nenhuma tela o mostra, e o plugin não conta.
        { metric: 'gather.leather', source: 'plugin', enabled: false },
        // Concedido: quem o alimenta é a missão, não o golpe.
        { metric: 'gather.stones', source: 'item', enabled: true },
        { metric: 'ore.metal', source: 'plugin', enabled: true },
      ]),
    ).toEqual(['cloth', 'wood']);
  });

  it('viaja como quarto argumento do flush', () => {
    expect(buildStatsFlushCommand(0, 100, 'abc', ['cloth', 'wood'])).toBe(
      'origemz.stats.flush 0 100 abc cloth,wood',
    );
    // Lista vazia é "pare de contar", e não "não mexa".
    expect(buildStatsFlushCommand(0, 100, 'abc', [])).toBe('origemz.stats.flush 0 100 abc -');
    // Sem segredo, o lugar dele é guardado — o argumento é posicional.
    expect(buildStatsFlushCommand(0, 100, undefined, ['wood'])).toBe(
      'origemz.stats.flush 0 100 - wood',
    );
    // Sem lista, o comando é o de sempre: o plugin não mexe no que tem.
    expect(buildStatsFlushCommand(100, 100, 'abc')).toBe('origemz.stats.flush 100 100 abc');
  });
});

describe('as duas cópias', () => {
  it('as chaves fixas são as que o plugin declara', () => {
    const plugin = readFileSync(
      fileURLToPath(new URL('../../Plugins/OrigemZAgent.cs', import.meta.url)),
      'utf8',
    );
    const declared = [...plugin.matchAll(/const string Metric\w+ = "([^"]+)"/g)].map(
      (match) => match[1],
    );
    // O minério mora num mapa, e não em constantes.
    const ores = [...plugin.matchAll(/\{ "[a-z.]+", "(ore\.[a-z]+)" \}/g)].map((match) => match[1]);

    expect(new Set([...declared, ...ores])).toEqual(new Set(FIXED_PLUGIN_METRICS));
  });
});
