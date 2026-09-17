// ============================================================
//  plugins-single-line-json.test.ts  -  o JSON dos plugins cabe
//  numa linha, mesmo com outro plugin mexendo no Newtonsoft.
//
//  O defeito de 16/09/2026: o CopyPaste 4.3.0 carregou no server01
//  e pôs o `JsonConvert.DefaultSettings` em `Formatting.Indented`.
//  Esse valor é GLOBAL do processo, e o CopyPaste não o desfaz no
//  unload. Todo `SerializeObject(x)` sem formato passou a sair em
//  várias linhas, e o `firstJsonLine` — que lê linha a linha —
//  deixou de achar a resposta do `origemz.stats.flush` e do
//  `origemz.item.pending`. O ranking parou, e o log perguntava se o
//  plugin estava carregado. Estava.
//
//  A regra que se prova aqui: nos plugins da casa, TODA chamada de
//  `JsonConvert.SerializeObject` passa o formato explícito. Sem
//  exceção para as que "só vão para outro plugin": regra com
//  exceção é a que ninguém confere.
// ============================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PLUGINS_DIR = fileURLToPath(new URL('../../Plugins/', import.meta.url));
const CALL = 'JsonConvert.SerializeObject(';

interface SerializeCall {
  readonly where: string;
  readonly args: readonly string[];
}

/** O índice da aspa que fecha a string aberta em `start`. */
function skipString(source: string, start: number): number {
  const verbatim =
    source[start - 1] === '@' || (source[start - 1] === '$' && source[start - 2] === '@');

  for (let i = start + 1; i < source.length; i += 1) {
    if (verbatim) {
      if (source[i] === '"') {
        // `""` é a aspa escapada de uma string verbatim.
        if (source[i + 1] === '"') {
          i += 1;
          continue;
        }

        return i;
      }

      continue;
    }

    if (source[i] === '\\') {
      i += 1;
      continue;
    }

    if (source[i] === '"') {
      return i;
    }
  }

  throw new Error(`string sem fim a partir do índice ${String(start)}`);
}

/** O índice do apóstrofo que fecha o `char` aberto em `start`. */
function skipChar(source: string, start: number): number {
  return source[start + 1] === '\\' ? source.indexOf("'", start + 3) : start + 2;
}

/**
 * Os argumentos de primeiro nível da chamada cujo `(` está em `open`.
 *
 * Não é um parser de C#: a vírgula de um genérico
 * (`Dictionary<string, object>`) conta como separador. Para a
 * pergunta daqui — "algum argumento depois do primeiro é um
 * `Formatting.`?" — isso não muda a resposta.
 */
function argumentsAt(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let from = open + 1;

  for (let i = open; i < source.length; i += 1) {
    const char = source[i];

    if (char === '"') {
      i = skipString(source, i);
    } else if (char === "'") {
      i = skipChar(source, i);
    } else if (char === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
    } else if (char === '(' || char === '{' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;

      if (depth === 0) {
        args.push(source.slice(from, i).trim());
        return args;
      }
    } else if (char === ',' && depth === 1) {
      args.push(source.slice(from, i).trim());
      from = i + 1;
    }
  }

  throw new Error(`chamada sem fim a partir do índice ${String(open)}`);
}

function serializeCallsOf(file: string): SerializeCall[] {
  const source = readFileSync(join(PLUGINS_DIR, file), 'utf8');
  const calls: SerializeCall[] = [];

  for (let at = source.indexOf(CALL); at >= 0; at = source.indexOf(CALL, at + CALL.length)) {
    const lineStart = source.lastIndexOf('\n', at) + 1;

    // Chamada citada num comentário não é chamada.
    if (source.slice(lineStart, at).includes('//')) {
      continue;
    }

    const line = source.slice(0, at).split('\n').length;

    calls.push({
      where: `${file}:${String(line)}`,
      args: argumentsAt(source, at + CALL.length - 1),
    });
  }

  return calls;
}

describe('o JSON que os plugins da casa escrevem', () => {
  const files = readdirSync(PLUGINS_DIR).filter(
    (file) => file.startsWith('OrigemZ') && file.endsWith('.cs'),
  );
  const calls = files.flatMap(serializeCallsOf);

  it('é procurado onde ele existe', () => {
    // Sem isto, um caminho errado passaria o teste abaixo sem
    // conferir nada.
    expect(files).toContain('OrigemZAgent.cs');
    expect(calls.filter((call) => call.where.startsWith('OrigemZAgent.cs:')).length).toBeGreaterThan(
      10,
    );
  });

  it('passa o formato explícito em toda chamada de SerializeObject', () => {
    const missing = calls
      .filter((call) => !call.args.slice(1).some((arg) => arg.startsWith('Formatting.')))
      .map((call) => call.where);

    // Sem o formato, o Newtonsoft usa o `JsonConvert.DefaultSettings`
    // do processo, e qualquer plugin pode tê-lo trocado. Acrescente
    // `, Formatting.None` à chamada.
    expect(missing).toEqual([]);
  });
});
