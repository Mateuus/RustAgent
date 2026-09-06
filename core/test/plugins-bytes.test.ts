// ============================================================
//  plugins-bytes.test.ts  -  nenhum `.cs` carrega byte que o
//                            Oxide não consegue ler.
//
//  ####  O ACIDENTE QUE ISTO EXISTE PARA PEGAR  ####
//
//  Um comentário com `Docs\CustomItem\03-…` escrito por heredoc
//  vira `Docs\CustomItem` + o byte **0x03**: o shell leu `\03`
//  como escape octal. O mesmo já aconteceu antes neste projeto
//  com `Docs\20`, que virou 0x10.
//
//  O sintoma é o pior possível:
//
//    - o Roslyn COMPILA sem reclamar (o byte está num comentário);
//    - o `git diff` fica limpo — o byte é invisível no editor;
//    - e o Oxide simplesmente **não carrega o plugin**, com
//      "Timed out waiting for compilation". O arquivo nem chega
//      ao compilador: não há job nenhum no log dele.
//
//  Em 06/09/2026 isso derrubou o `OrigemZItems` em produção, e a
//  caçada levou meia hora — porque todo sinal apontava para o
//  compilador, que estava perfeito.
//
//  ####  A REGRA QUE EVITA  ####
//
//  Caminho de documento em comentário se escreve com barra
//  NORMAL: `Docs/CustomItem/03`. Ela atravessa heredoc, shell e
//  C# sem virar escape de coisa nenhuma.
// ============================================================

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'Plugins');

/** Tabulação, retorno e nova linha são os únicos controles válidos. */
function isForbidden(byte: number): boolean {
  return byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f;
}

/** Onde está o byte, em linha e coluna, para a mensagem servir. */
function locate(buffer: Buffer, at: number): string {
  const before = buffer.subarray(0, at).toString('latin1');
  const lines = before.split('\n');
  const around = buffer
    .subarray(Math.max(0, at - 50), at)
    .toString('latin1')
    .replace(/\s+/g, ' ')
    .trim();

  return `linha ${String(lines.length)}, depois de "…${around.slice(-40)}"`;
}

describe('os plugins do jogo não têm byte que o Oxide recuse', () => {
  const files = readdirSync(PLUGINS).filter((name) => name.endsWith('.cs'));

  // Se a pasta mudar de lugar, o teste passaria vazio e não
  // guardaria nada — esta linha é o que impede isso.
  it('a pasta Plugins/ foi encontrada e tem arquivos', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s', (name) => {
    const buffer = readFileSync(join(PLUGINS, name));
    const found: string[] = [];

    for (let at = 0; at < buffer.length; at += 1) {
      const byte = buffer[at];

      if (byte !== undefined && isForbidden(byte)) {
        found.push(`0x${byte.toString(16).padStart(2, '0')} na ${locate(buffer, at)}`);
      }
    }

    expect(
      found,
      `${name} tem byte de controle — quase sempre um "\\0" de caminho ` +
        `escrito com barra invertida em heredoc. Use barra normal:\n  ${found.join('\n  ')}`,
    ).toEqual([]);
  });
});
