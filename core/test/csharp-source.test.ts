// ============================================================
//  csharp-source.test.ts  -  ler o .cs sem se enganar.
//
//  O que se guarda aqui é a diferença entre um comentário e uma
//  string. Errar isso não dá erro nenhum: dá um plugin que some da
//  tela, ou uma versão lida do exemplo que estava no cabeçalho — e
//  as duas coisas só aparecem quando alguém desconfia.
// ============================================================

import { describe, expect, it } from 'vitest';

import { decodeSource, stripComments } from '../src/oxide/csharp-source.js';

describe('decodeSource', () => {
  it('lê UTF-8 puro', () => {
    expect(decodeSource(Buffer.from('class Ação', 'utf8'))).toBe('class Ação');
  });

  it('tira o BOM de UTF-8, que grudaria no primeiro token', () => {
    const content = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('using X;', 'utf8'),
    ]);

    expect(decodeSource(content)).toBe('using X;');
  });

  it('lê UTF-16LE — o "Unicode" do Bloco de Notas', () => {
    const content = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('class A', 'utf16le')]);

    expect(decodeSource(content)).toBe('class A');
  });

  it('lê UTF-16BE, que o Node não decodifica sozinho', () => {
    const body = Buffer.from('class A', 'utf16le');
    const content = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body).swap16()]);

    expect(decodeSource(content)).toBe('class A');
  });

  it('não altera o buffer que recebeu', () => {
    // Ele é o MESMO que vai para o disco: um `swap16` no lugar
    // gravaria o arquivo com os bytes trocados.
    const body = Buffer.from('class A', 'utf16le');
    const content = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body).swap16()]);
    const before = Buffer.from(content);

    decodeSource(content);

    expect(content.equals(before)).toBe(true);
  });
});

describe('stripComments', () => {
  it('tira o comentário de linha e preserva a linha', () => {
    const code = stripComments('using X; // o resto some\nclass A');

    expect(code).toBe('using X;                \nclass A');
  });

  it('tira o bloco, inclusive de várias linhas', () => {
    const code = stripComments('/* nada\n  aqui */class A');

    expect(code.trim()).toBe('class A');
    // A quebra de linha fica: o número da linha do `class` não muda.
    expect(code.split('\n')).toHaveLength(2);
  });

  it('o "//" de uma URL dentro de string NÃO é comentário', () => {
    // Este é o caso que um `replace(/\/\/.*$/)` erraria, apagando o
    // resto da linha — e com ele a declaração que vinha depois.
    const code = stripComments('var url = "http://origemz.com/x"; class A');

    expect(code).toContain('class A');
    expect(code).toContain('"http://origemz.com/x"');
  });

  it('a contrabarra da string verbatim não escapa a aspa', () => {
    const code = stripComments('var dir = @"C:\\Servers\\"; class A');

    expect(code).toContain('class A');
  });

  it('a aspa dobrada dentro da verbatim não a fecha', () => {
    const code = stripComments('var s = @"diz ""oi"" agora"; class A // fim');

    expect(code).toContain('class A');
    expect(code).not.toContain('fim');
  });

  it('o char literal de aspa dupla não abre string', () => {
    const code = stripComments(`var q = '"'; class A // fim`);

    expect(code).toContain('class A');
    expect(code).not.toContain('fim');
  });

  it('string sem fechar não engole o resto do arquivo', () => {
    // Código quebrado é problema do compilador. O que não pode é
    // uma aspa solta apagar as mil linhas seguintes daqui.
    const code = stripComments('var s = "sem fechar\nclass A');

    expect(code).toContain('class A');
  });

  it('bloco sem fechar leva o resto — que é como o compilador lê', () => {
    const code = stripComments('class A\n/* daqui para baixo\nclass B');

    expect(code).toContain('class A');
    expect(code).not.toContain('class B');
  });

  it('o "[Info(...)]" citado em comentário não sobra', () => {
    const source = [
      '// Todo plugin declara:',
      '//     [Info("Exemplo", "Alguém", "9.9.9")]',
      '[Info("Real", "OrigemZ", "1.0.0")]',
      'class A {}',
    ].join('\n');

    const code = stripComments(source);

    expect(code).not.toContain('Exemplo');
    expect(code).toContain('"Real"');
  });
});
