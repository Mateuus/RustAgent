// ============================================================
//  plugins.test.ts  -  as travas do gerenciador de plugins.
//
//  O que este arquivo guarda não é comportamento de conveniência:
//  é a barreira que impede um upload de escrever FORA da pasta de
//  plugins daquele servidor. Um nome com `..` que passasse
//  substituiria um assembly do Oxide em
//  RustDedicated_Data\Managed — e o sintoma seria um servidor que
//  não sobe mais, sem ninguém ligar isso a um upload.
// ============================================================

import { describe, expect, it } from 'vitest';

import { isApiError } from '../src/http/error-response.js';
import {
  assertPluginContent,
  MAX_PLUGIN_BYTES,
  PLUGIN_NAME_PATTERN,
  pluginPath,
} from '../src/oxide/plugins.js';

const PLUGINS_DIR = 'F:\\Projects\\RustAgent\\Servers\\pvp1\\oxide\\plugins';

describe('pluginPath', () => {
  it('aceita um nome comum', () => {
    expect(pluginPath(PLUGINS_DIR, 'MeuPlugin.cs')).toBe(`${PLUGINS_DIR}\\MeuPlugin.cs`);
  });

  it.each([
    ['..\\..\\RustDedicated_Data\\Managed\\Oxide.Core.dll', 'travessia com barra invertida'],
    ['../../evil.cs', 'travessia com barra normal'],
    ['C:\\Windows\\System32\\evil.cs', 'caminho absoluto'],
    ['sub/dir/Plugin.cs', 'subpasta'],
    ['Plugin.dll', 'extensão que não é .cs'],
    ['Plugin', 'sem extensão'],
    ['', 'vazio'],
    ['Plugin.cs.exe', 'extensão dupla'],
  ])('recusa %s (%s)', (name) => {
    let thrown: unknown;

    try {
      pluginPath(PLUGINS_DIR, name);
    } catch (error) {
      thrown = error;
    }

    expect(isApiError(thrown)).toBe(true);

    if (isApiError(thrown)) {
      expect(thrown.status).toBe(400);
      // A recusa precisa dizer o que fazer, não só que recusou.
      expect(thrown.message).toMatch(/nome de plugin aceito|sai da pasta de plugins/);
    }
  });

  it('o padrão do nome não aceita barra, dois-pontos nem controle', () => {
    for (const name of ['a/b.cs', 'a\\b.cs', 'C:.cs', 'a\nb.cs', 'a b.cs']) {
      expect(PLUGIN_NAME_PATTERN.test(name)).toBe(false);
    }
  });
});

/** O que a trava recusou, ou `null` se ela deixou passar. */
function refusal(content: Buffer): string | null {
  try {
    assertPluginContent(content);

    return null;
  } catch (error) {
    if (!isApiError(error)) {
      throw error;
    }

    expect(error.status).toBe(400);

    return error.message;
  }
}

describe('assertPluginContent', () => {
  it('aceita um plugin comum', () => {
    expect(refusal(Buffer.from('using Oxide.Core;\nclass A {}', 'utf8'))).toBeNull();
  });

  it('####  aceita o .cs cujo código começa depois de 6 KB de comentário  ####', () => {
    // ISTO É O `OrigemZQueue.cs`. O cabeçalho dele tem 104 linhas, e
    // a versão que olhava só os primeiros 4 KB o recusava: o plugin
    // não entrava no acervo, a varredura da pasta engolia o erro num
    // aviso de log, e ele simplesmente não aparecia na tela.
    const header = Array.from(
      { length: 200 },
      (_, line) => `//  linha ${String(line)} de cabeçalho explicando por que este arquivo existe`,
    ).join('\n');

    const content = Buffer.from(`${header}\n\nusing Oxide.Core;\n\nclass Fila {}\n`, 'utf8');

    expect(content.byteLength).toBeGreaterThan(6_000);
    expect(refusal(content)).toBeNull();
  });

  it('aceita o .cs salvo em UTF-16, que o Windows produz', () => {
    const content = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('using Oxide.Core;\nclass A {}', 'utf16le'),
    ]);

    expect(refusal(content)).toBeNull();
  });

  it('recusa o zip renomeado, dizendo que é um zip', () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]);

    // A recusa precisa mandar EXTRAIR o arquivo. "Não achei a palavra
    // class" mandaria procurar defeito num plugin que está inteiro,
    // dentro do zip.
    expect(refusal(zip)).toMatch(/\.zip/);
  });

  it('recusa a .dll compilada', () => {
    const dll = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(200)]);

    expect(refusal(dll)).toMatch(/\.dll/);
  });

  it('recusa o PDF', () => {
    expect(refusal(Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1'))).toMatch(/PDF/);
  });

  it('recusa binário desconhecido, pelos bytes zero', () => {
    const bytes = Buffer.from([0x00, 0x13, 0x37, 0x00, 0x42, 0x00, 0x99]);

    expect(refusal(bytes)).toMatch(/não é texto/);
  });

  it('recusa o arquivo que só TEM comentário', () => {
    // O `.md` que fala sobre plugins, ou o cabeçalho copiado sem o
    // código. A palavra `class` está lá, mas declaração não há.
    const content = Buffer.from(
      ['// Este documento explica a class de um plugin', '// e o namespace onde ele mora.'].join(
        '\n',
      ),
      'utf8',
    );

    expect(refusal(content)).toMatch(/fora dos comentários/);
  });

  it('recusa o vazio', () => {
    expect(refusal(Buffer.alloc(0))).toMatch(/vazio/);
  });

  it('recusa o que passa do teto', () => {
    const grande = Buffer.from(`class A {}\n${'x'.repeat(MAX_PLUGIN_BYTES)}`, 'utf8');

    expect(refusal(grande)).toMatch(/limite/);
  });
});
