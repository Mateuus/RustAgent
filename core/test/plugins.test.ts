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
import { PLUGIN_NAME_PATTERN, pluginPath } from '../src/oxide/plugins.js';

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
