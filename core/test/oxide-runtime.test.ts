// ============================================================
//  oxide-runtime.test.ts  -  ler o `oxide.plugins` sem chutar.
//
//  A saída deste comando é PROSA de terceiro, e o que se extrai
//  dela vira alarme na tela. Os casos aqui são os que separam o
//  alarme verdadeiro do falso:
//
//    - o carregado é indexado pelo ARQUIVO, não pelo título;
//    - "Failed to compile" e "Missing dependencies" são falhas,
//      e a mensagem do compilador (com a linha) chega inteira;
//    - o que não casa nenhum dos dois formatos não vira plugin.
//
//  A listagem usada é a real desta máquina no dia em que o
//  OrigemZAgent parou de compilar.
// ============================================================

import { describe, expect, it } from 'vitest';

import { parseOxidePlugins, readOxideRuntime } from '../src/oxide/runtime.js';

const LISTAGEM_REAL = [
  'Listing 10 plugins:',
  '  01 "AdminHammer" (1.13.1) by mvrb (0.00s / 20 KB) - AdminHammer.cs',
  '  02 "Admin No Loot" (0.1.3) by Dana (0.00s / 0 B) - AdminNoLoot.cs',
  '  03 "Admin Panel" (1.4.8) by nivex (0.01s / 96 KB) - AdminPanel.cs',
  '  04 "Admin Radar" (5.4.3) by nivex (1.67s / 2 MB) - AdminRadar.cs',
  '  05 "OrigemZChat" (0.2.0) by OrigemZ (0.00s / 4 KB) - OrigemZChat.cs',
  '  06 "OrigemZUI" (0.1.0) by OrigemZ (0.35s / 41 MB) - OrigemZUI.cs',
  "  07 OrigemZAgent - Failed to compile: There is no argument given that corresponds to the required parameter 'targetPos' of 'ItemContainer.CanAcceptItem(BasePlayer, Item, int)' | Line: 1858, Pos: 30",
  '  08 OrigemZPlayer - Missing dependencies: OrigemZAgent',
  '  09 OrigemZQueue - Missing dependencies: OrigemZAgent',
  '  10 OrigemZVip - Missing dependencies: OrigemZAgent',
].join('\n');

describe('parseOxidePlugins', () => {
  it('indexa o plugin carregado pelo nome do arquivo, e não pelo título', () => {
    const plugins = parseOxidePlugins(LISTAGEM_REAL);
    const semLoot = plugins.find((plugin) => plugin.name === 'AdminNoLoot');

    // "Admin No Loot" é o título; `AdminNoLoot.cs` é o que o
    // acervo conhece. Casar pelo título deixaria este plugin
    // invisível para a tela de plugins.
    expect(semLoot).toEqual({
      name: 'AdminNoLoot',
      title: 'Admin No Loot',
      version: '0.1.3',
      loaded: true,
      failure: null,
    });
  });

  it('reconhece a falha de compilação e preserva a linha do erro', () => {
    const plugins = parseOxidePlugins(LISTAGEM_REAL);
    const agent = plugins.find((plugin) => plugin.name === 'OrigemZAgent');

    expect(agent?.loaded).toBe(false);
    // A linha é o que resolve o problema. Um resumo aqui obrigaria
    // a abrir o console para descobrir onde olhar.
    expect(agent?.failure).toContain('Failed to compile');
    expect(agent?.failure).toContain('Line: 1858');
  });

  it('reconhece a dependência que não subiu', () => {
    const plugins = parseOxidePlugins(LISTAGEM_REAL);
    const caidos = plugins.filter((plugin) => !plugin.loaded).map((plugin) => plugin.name);

    // Um plugin que não compila leva junto quem depende dele — e a
    // tela precisa mostrar os quatro, não só o primeiro.
    expect(caidos).toEqual(['OrigemZAgent', 'OrigemZPlayer', 'OrigemZQueue', 'OrigemZVip']);
    expect(plugins.find((plugin) => plugin.name === 'OrigemZVip')?.failure).toBe(
      'Missing dependencies: OrigemZAgent',
    );
  });

  it('conta dez plugins e nem um a mais: o cabeçalho não é plugin', () => {
    expect(parseOxidePlugins(LISTAGEM_REAL)).toHaveLength(10);
  });

  it('ignora o que não casa nenhum dos dois formatos', () => {
    // Inventar plugin a partir de texto desconhecido é pior que não
    // ver o plugin: a tela passaria a mostrar linhas que ninguém
    // consegue ligar, desligar nem remover.
    expect(parseOxidePlugins('No plugins are currently loaded.')).toEqual([]);
    expect(parseOxidePlugins('')).toEqual([]);
  });

  it('aguenta o título com hífen no meio', () => {
    const plugins = parseOxidePlugins(
      '  01 "Rust - Kits" (2.0.0) by alguém (0.01s / 8 KB) - RustKits.cs',
    );

    expect(plugins).toEqual([
      { name: 'RustKits', title: 'Rust - Kits', version: '2.0.0', loaded: true, failure: null },
    ]);
  });
});

describe('readOxideRuntime', () => {
  it('pergunta ao servidor e devolve o que ele respondeu', async () => {
    const enviados: string[] = [];
    const runtime = await readOxideRuntime({
      isConnected: true,
      send: (command) => {
        enviados.push(command);
        return Promise.resolve(LISTAGEM_REAL);
      },
    });

    expect(enviados).toEqual(['oxide.plugins']);
    expect(runtime.plugins).toHaveLength(10);
    expect(runtime.readAt).toBeGreaterThan(0);
  });
});
