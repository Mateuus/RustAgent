// ============================================================
//  plugin-library.test.ts  -  as regras do acervo de plugins.
//
//  O que este arquivo guarda são as promessas que a tela faz e que
//  ninguém confere olhando:
//
//    1. ligar COPIA o arquivo e grava o applied_sha — sem ele, não
//       há como dizer se aquele servidor está em dia;
//    2. desligar apaga o `.cs` e PRESERVA `oxide\config\*.json`. Se
//       custasse a configuração, ninguém desligaria nada;
//    3. o CUSTOM é de um servidor só, e nenhum outro o enxerga;
//    4. dois plugins de mesmo nome não se ligam juntos — eles
//       gravariam o mesmo arquivo, e o Oxide carrega um só;
//    5. adotar traz para o acervo o que já estava no servidor, sem
//       apagar nada de lá;
//    6. subir uma versão nova NÃO aplica sozinho: ela fica
//       pendente, e a tela mostra "há atualização".
//
//  Tudo com pasta temporária de verdade e banco em memória: o que
//  se testa aqui é justamente o efeito em disco.
// ============================================================

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { PluginsRepository } from '../src/db/plugins-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { isApiError } from '../src/http/error-response.js';
import { createLogger } from '../src/logger.js';
import type { OpsRcon } from '../src/ops/service.js';
import { PluginLibrary, type PluginServers } from '../src/oxide/library.js';

const SERVER_ID = 'server01';
const OTHER_ID = 'server02';
const PLUGIN_FILE = 'OrigemZPlayer.cs';
const PLUGIN_NAME = 'OrigemZPlayer';

interface SourceOptions {
  readonly className?: string;
  /** `// Requires: X` — o Oxide não carrega sem. */
  readonly requires?: readonly string[];
  /** `[PluginReference]` — carrega sem, degradado. */
  readonly references?: readonly string[];
}

/** Um `.cs` plausível: o que a heurística de conteúdo aceita. */
function pluginSource(version: string, options: SourceOptions = {}): Buffer {
  const className = options.className ?? PLUGIN_NAME;

  return Buffer.from(
    [
      ...(options.requires ?? []).map((name) => `// Requires: ${name}`),
      'using Oxide.Core;',
      '',
      'namespace Oxide.Plugins',
      '{',
      `    [Info("Origem Z Player", "OrigemZ", "${version}")]`,
      '    [Description("Expõe posição e estado dos jogadores")]',
      `    public class ${className} : RustPlugin`,
      '    {',
      // O campo vai no MEIO da classe de propósito: é onde ele
      // aparece de verdade, e é o que prova que a leitura não olha
      // só o cabeçalho.
      ...(options.references ?? []).map(
        (name) => `        [PluginReference] private Plugin ${name};`,
      ),
      '    }',
      '}',
    ].join('\n'),
    'utf8',
  );
}

interface Harness {
  readonly library: PluginLibrary;
  readonly repository: PluginsRepository;
  readonly db: AgentDatabase;
  readonly root: string;
  readonly libraryDir: string;
  readonly pluginsDir: string;
  readonly configDir: string;
  /** Os comandos que chegaram ao RCON, na ordem. */
  readonly commands: string[];
}

let harness: Harness;

/** `Servers\<id>\oxide\{plugins,config}`, criadas. */
async function makeServerDirs(root: string, id: string): Promise<string> {
  const oxideDir = join(root, 'Servers', id, 'oxide');

  await mkdir(join(oxideDir, 'plugins'), { recursive: true });
  await mkdir(join(oxideDir, 'config'), { recursive: true });

  return oxideDir;
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'rustagent-plugins-'));
  const libraryDir = join(root, 'Plugins');

  const oxideDir = await makeServerDirs(root, SERVER_ID);
  const otherOxideDir = await makeServerDirs(root, OTHER_ID);

  const pluginsDir = join(oxideDir, 'plugins');
  const configDir = join(oxideDir, 'config');
  const otherPluginsDir = join(otherOxideDir, 'plugins');

  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  // As linhas em `servers` não são decoração: `server_plugins` e
  // `plugins.server_id` apontam para lá, e o pragma de chave
  // estrangeira está ligado.
  const servers = new ServersRepository(db);

  servers.create({
    id: SERVER_ID,
    name: 'PVP 1',
    identity: SERVER_ID,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: join(root, 'Servers', SERVER_ID),
  });

  servers.create({
    id: OTHER_ID,
    name: 'PVP 2',
    identity: OTHER_ID,
    gamePort: 28_115,
    rconPort: 28_116,
    queryPort: 28_117,
    appPort: 28_182,
    installDir: join(root, 'Servers', OTHER_ID),
  });

  const commands: string[] = [];

  const rcon: OpsRcon = {
    isConnected: true,
    send: (command: string) => {
      commands.push(command);
      return Promise.resolve('ok');
    },
  };

  const dirs: Record<string, string> = {
    [SERVER_ID]: pluginsDir,
    [OTHER_ID]: otherPluginsDir,
  };

  const pluginServers: PluginServers = {
    ids: () => [SERVER_ID, OTHER_ID],
    configOf: (id) => {
      const dir = dirs[id];

      return dir === undefined
        ? null
        : {
            paths: {
              pluginsDir: dir,
              // Irmãs da pasta de plugins, como em `resolveServerPaths`.
              oxideConfigDir: join(dir, '..', 'config'),
              backupsDir: join(root, 'Backups', id),
            },
          };
    },
    contextOf: (id) => (dirs[id] === undefined ? null : { rcon }),
  };

  const repository = new PluginsRepository(db);

  harness = {
    library: new PluginLibrary({
      libraryDir,
      repository,
      servers: pluginServers,
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
    }),
    repository,
    db,
    root,
    libraryDir,
    pluginsDir,
    configDir,
    commands,
  };
});

afterEach(async () => {
  harness.db.close();
  await rm(harness.root, { recursive: true, force: true });
});

describe('a biblioteca', () => {
  it('lê nome, autor e versão do próprio .cs', async () => {
    const { plugin } = await harness.library.add(PLUGIN_FILE, pluginSource('1.2.3'));

    expect(plugin.name).toBe(PLUGIN_NAME);
    expect(plugin.title).toBe('Origem Z Player');
    expect(plugin.author).toBe('OrigemZ');
    expect(plugin.version).toBe('1.2.3');
    expect(plugin.description).toBe('Expõe posição e estado dos jogadores');
    // Da biblioteca: sem dono, e ninguém ativou ainda.
    expect(plugin.serverId).toBeNull();
    expect(plugin.servers).toEqual([]);
  });

  it('grava o arquivo em Plugins\\, e não na pasta de servidor nenhum', async () => {
    await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));

    expect(existsSync(join(harness.libraryDir, PLUGIN_FILE))).toBe(true);
    expect(existsSync(join(harness.pluginsDir, PLUGIN_FILE))).toBe(false);
  });

  it('recusa um nome que sai da pasta do acervo', async () => {
    let thrown: unknown;

    try {
      await harness.library.add('..\\..\\Managed\\Oxide.Core.cs', pluginSource('1.0.0'));
    } catch (error) {
      thrown = error;
    }

    expect(isApiError(thrown)).toBe(true);
  });
});

describe('o plugin custom', () => {
  it('vai para Plugins\\<id>\\ e pertence àquele servidor', async () => {
    const { plugin } = await harness.library.addCustom(
      SERVER_ID,
      'MeuEvento.cs',
      pluginSource('0.1.0', { className: 'MeuEvento' }),
    );

    expect(plugin.serverId).toBe(SERVER_ID);
    expect(existsSync(join(harness.libraryDir, SERVER_ID, 'MeuEvento.cs'))).toBe(true);
    // Não encosta na biblioteca de rede.
    expect(existsSync(join(harness.libraryDir, 'MeuEvento.cs'))).toBe(false);
  });

  it('não aparece na tela de rede', async () => {
    await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));
    await harness.library.addCustom(SERVER_ID, 'MeuEvento.cs', pluginSource('0.1.0', { className: 'MeuEvento' }));

    expect((await harness.library.list()).map((plugin) => plugin.name)).toEqual([PLUGIN_NAME]);
  });

  it('não aparece no acervo de OUTRO servidor', async () => {
    await harness.library.addCustom(SERVER_ID, 'MeuEvento.cs', pluginSource('0.1.0', { className: 'MeuEvento' }));

    const meu = await harness.library.serverList(SERVER_ID);
    const outro = await harness.library.serverList(OTHER_ID);

    expect(meu.plugins.map((plugin) => plugin.name)).toContain('MeuEvento');
    expect(outro.plugins.map((plugin) => plugin.name)).not.toContain('MeuEvento');
  });

  it('ligar o custom de outro servidor é recusado', async () => {
    const { plugin } = await harness.library.addCustom(
      SERVER_ID,
      'MeuEvento.cs',
      pluginSource('0.1.0', { className: 'MeuEvento' }),
    );

    let thrown: unknown;

    try {
      await harness.library.setEnabled(OTHER_ID, plugin.id, true);
    } catch (error) {
      thrown = error;
    }

    expect(isApiError(thrown)).toBe(true);

    if (isApiError(thrown)) {
      expect(thrown.status).toBe(403);
      expect(thrown.message).toContain(SERVER_ID);
    }
  });

  it('dois servidores podem ter customs de mesmo nome e conteúdos diferentes', async () => {
    const meu = await harness.library.addCustom(
      SERVER_ID,
      'MeuEvento.cs',
      pluginSource('1.0.0', { className: 'MeuEvento' }),
    );
    const outro = await harness.library.addCustom(
      OTHER_ID,
      'MeuEvento.cs',
      pluginSource('2.0.0', { className: 'MeuEvento' }),
    );

    // Duas linhas distintas: é para isto que a chave deixou de ser
    // o nome.
    expect(meu.plugin.id).not.toBe(outro.plugin.id);
    expect(meu.plugin.version).toBe('1.0.0');
    expect(outro.plugin.version).toBe('2.0.0');
  });
});

describe('a pasta manda no acervo', () => {
  it('um .cs copiado para Plugins\\ à mão entra na biblioteca', async () => {
    await mkdir(harness.libraryDir, { recursive: true });
    await writeFile(join(harness.libraryDir, PLUGIN_FILE), pluginSource('3.0.0'));

    // Ninguém fez upload: o arquivo simplesmente apareceu na pasta.
    // Copiar trinta de uma vez precisa valer tanto quanto trinta
    // uploads.
    const plugins = await harness.library.list();

    expect(plugins.map((plugin) => plugin.name)).toEqual([PLUGIN_NAME]);
    expect(plugins[0]?.version).toBe('3.0.0');
  });

  it('editar o arquivo na pasta atualiza a versão no acervo', async () => {
    await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));
    await writeFile(join(harness.libraryDir, PLUGIN_FILE), pluginSource('4.0.0'));

    expect((await harness.library.list())[0]?.version).toBe('4.0.0');
  });

  it('um .cs em Plugins\\<id>\\ entra como custom daquele servidor', async () => {
    await mkdir(join(harness.libraryDir, SERVER_ID), { recursive: true });
    await writeFile(
      join(harness.libraryDir, SERVER_ID, 'MeuEvento.cs'),
      pluginSource('0.1.0', { className: 'MeuEvento' }),
    );

    const { plugins } = await harness.library.serverList(SERVER_ID);
    const custom = plugins.find((plugin) => plugin.name === 'MeuEvento');

    expect(custom?.serverId).toBe(SERVER_ID);
    // E continua invisível para os outros.
    expect((await harness.library.list()).map((plugin) => plugin.name)).not.toContain('MeuEvento');
  });

  it('arquivo que sumiu da pasta NÃO apaga a linha', async () => {
    const { plugin } = await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));

    await harness.library.setEnabled(SERVER_ID, plugin.id, true);
    await rm(join(harness.libraryDir, PLUGIN_FILE));

    // Apagar a linha derrubaria junto, por cascata, o registro de
    // quem ativou o quê — e um `.cs` movido por engano custaria a
    // configuração de vários servidores.
    expect((await harness.library.list()).map((plugin) => plugin.name)).toEqual([PLUGIN_NAME]);
    expect(harness.repository.serverPlugin(SERVER_ID, plugin.id)?.enabled).toBe(true);
  });
});

describe('as dependências entre plugins', () => {
  /** `OrigemZAgent` na biblioteca, com três dependentes dele. */
  async function comDependentes(): Promise<{ agente: number; player: number; ui: number }> {
    const agente = await harness.library.add(
      'OrigemZAgent.cs',
      pluginSource('1.0.0', { className: 'OrigemZAgent' }),
    );

    const player = await harness.library.add(
      PLUGIN_FILE,
      pluginSource('1.0.0', { requires: ['OrigemZAgent'] }),
    );

    const ui = await harness.library.add(
      'OrigemZUI.cs',
      pluginSource('1.0.0', { className: 'OrigemZUI', references: ['OrigemZAgent'] }),
    );

    return { agente: agente.plugin.id, player: player.plugin.id, ui: ui.plugin.id };
  }

  it('lê o "// Requires:" e o "[PluginReference]" do arquivo', async () => {
    const { plugin } = await harness.library.add(
      PLUGIN_FILE,
      pluginSource('1.0.0', { requires: ['OrigemZAgent'], references: ['Kits'] }),
    );

    expect(plugin.requires).toEqual(['OrigemZAgent']);
    // O campo está no meio da classe, e não no cabeçalho.
    expect(plugin.references).toEqual(['Kits']);
  });

  it('não confunde COMENTÁRIO com declaração', async () => {
    // Os nossos plugins explicam o mecanismo em prosa, e a primeira
    // versão da leitura saía desses comentários com `memoria`,
    // `mapa` e `System` como se fossem dependências. Metadado
    // errado é pior que ausente: a tela avisaria que tirar um
    // plugin quebra outro que nem existe, e quem lesse isso duas
    // vezes pararia de ler os avisos.
    const source = Buffer.from(
      [
        'using Oxide.Core;',
        'namespace Oxide.Plugins',
        '{',
        '    [Info("Falso", "OrigemZ", "1.0.0")]',
        '    public class Falso : RustPlugin',
        '    {',
        '        //  Consumida por outro plugin com [PluginReference] +',
        '        //  Call("Nome", ...). A memoria e liberada depois.',
        '        private int memoria = 0;',
        '',
        '        // [PluginReference] e o tipo Plugin moram em Oxide.Core.Plugins.',
        '        private string mapa = "x";',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const { plugin } = await harness.library.add('Falso.cs', source);

    expect(plugin.references).toEqual([]);
    expect(plugin.requires).toEqual([]);
  });

  it('o cabeçalho grande não esconde o metadado do plugin', async () => {
    // O `OrigemZQueue.cs` tem 104 linhas de comentário antes do
    // primeiro `using`, e o `[Info]` dele cai no caractere 5.248. As
    // duas leituras liam só o começo do arquivo — uma com 4 KB, a
    // outra com 8 KB — e o plugin ou sumia do acervo, ou entrava com
    // título, autor e versão nulos, que a tela mostra como três
    // travessões. Nenhuma das duas coisas dá erro em lugar nenhum.
    const header = Array.from(
      { length: 300 },
      (_, line) => `//  linha ${String(line)} do cabeçalho, explicando por que o arquivo existe`,
    ).join('\n');

    const source = Buffer.from(
      [
        header,
        '',
        'using Oxide.Core;',
        '',
        'namespace Oxide.Plugins',
        '{',
        '    [Info("Origem Z Fila", "OrigemZ", "2.1.0")]',
        '    [Description("A fila de entrada")]',
        '    public class OrigemZQueue : RustPlugin',
        '    {',
        '        [PluginReference] private Plugin OrigemZUI;',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    expect(source.byteLength).toBeGreaterThan(9_000);

    const { plugin } = await harness.library.add('OrigemZQueue.cs', source);

    expect(plugin.title).toBe('Origem Z Fila');
    expect(plugin.author).toBe('OrigemZ');
    expect(plugin.version).toBe('2.1.0');
    expect(plugin.references).toEqual(['OrigemZUI']);
  });

  it('o "[Info]" citado no cabeçalho não vira o metadado do plugin', async () => {
    // Os cabeçalhos daqui ensinam pelo exemplo. Ler o arquivo inteiro
    // sem descartar comentário só trocaria um bug por outro pior: a
    // tela mostraria a versão do exemplo como se fosse a do plugin, e
    // um metadado errado ninguém confere.
    const source = Buffer.from(
      [
        '//  Todo plugin de Oxide se declara assim:',
        '//',
        '//      [Info("Exemplo Didático", "Fulano", "9.9.9")]',
        '//      [Description("o que ele faz")]',
        '',
        'using Oxide.Core;',
        'namespace Oxide.Plugins',
        '{',
        '    [Info("Origem Z Player", "OrigemZ", "1.4.0")]',
        '    public class OrigemZPlayer : RustPlugin',
        '    {',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const { plugin } = await harness.library.add(PLUGIN_FILE, source);

    expect(plugin.title).toBe('Origem Z Player');
    expect(plugin.version).toBe('1.4.0');
  });

  it('a declaração de verdade é lida, mesmo quebrada em duas linhas', async () => {
    const source = Buffer.from(
      [
        'using Oxide.Core;',
        'namespace Oxide.Plugins',
        '{',
        '    [Info("Real", "OrigemZ", "1.0.0")]',
        '    public class Real : RustPlugin',
        '    {',
        // É assim que os nossos escrevem: atributo numa linha, o
        // campo na seguinte.
        '        [PluginReference]',
        '        private Plugin Kits;',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const { plugin } = await harness.library.add('Real.cs', source);

    expect(plugin.references).toEqual(['Kits']);
  });

  it('avisa o que falta ligar, sem impedir', async () => {
    const { player } = await comDependentes();

    // Ligar com a dependência fora NÃO é recusado: o Oxide segura o
    // plugin e o carrega quando ela aparecer. O que não pode é a
    // tela ficar calada.
    const { plugin } = await harness.library.setEnabled(SERVER_ID, player, true);

    expect(plugin.enabled).toBe(true);
    expect(plugin.missingRequires).toEqual(['OrigemZAgent']);
  });

  it('com a dependência ligada, não falta nada', async () => {
    const { agente, player } = await comDependentes();

    await harness.library.setEnabled(SERVER_ID, agente, true);

    const { plugin } = await harness.library.setEnabled(SERVER_ID, player, true);

    expect(plugin.missingRequires).toEqual([]);
  });

  it('a tela sabe quem cai se o plugin for tirado', async () => {
    const { agente, player, ui } = await comDependentes();

    await harness.library.setEnabled(SERVER_ID, agente, true);
    await harness.library.setEnabled(SERVER_ID, player, true);
    await harness.library.setEnabled(SERVER_ID, ui, true);

    const { plugins } = await harness.library.serverList(SERVER_ID);
    const visto = plugins.find((plugin) => plugin.name === 'OrigemZAgent');

    // Duro e mole são notícias diferentes: um sai do ar, o outro
    // fica no ar sem a parte que usava este.
    expect(visto?.dependents.hard).toEqual([PLUGIN_NAME]);
    expect(visto?.dependents.soft).toEqual(['OrigemZUI']);
  });

  it('tirar um plugin do qual outros dependem é RECUSADO, com os nomes', async () => {
    const { agente, player } = await comDependentes();

    await harness.library.setEnabled(SERVER_ID, agente, true);
    await harness.library.setEnabled(SERVER_ID, player, true);

    let thrown: unknown;

    try {
      await harness.library.setEnabled(SERVER_ID, agente, false);
    } catch (error) {
      thrown = error;
    }

    expect(isApiError(thrown)).toBe(true);

    if (isApiError(thrown)) {
      expect(thrown.status).toBe(409);
      // ####  ISTO É O TESTE  ####
      //
      // Sem esta frase, tirar o OrigemZAgent derrubaria o
      // OrigemZPlayer em silêncio — e o sintoma apareceria no jogo,
      // sem nada ligando uma coisa à outra.
      expect(thrown.message).toContain(PLUGIN_NAME);
    }

    // E nada foi feito: o plugin continua no ar.
    expect(harness.repository.serverPlugin(SERVER_ID, agente)?.enabled).toBe(true);
    expect(existsSync(join(harness.pluginsDir, 'OrigemZAgent.cs'))).toBe(true);
  });

  it('confirmado, tira mesmo assim', async () => {
    const { agente, player } = await comDependentes();

    await harness.library.setEnabled(SERVER_ID, agente, true);
    await harness.library.setEnabled(SERVER_ID, player, true);
    await harness.library.setEnabled(SERVER_ID, agente, false, true);

    expect(existsSync(join(harness.pluginsDir, 'OrigemZAgent.cs'))).toBe(false);

    // O dependente continua "ligado" no agente — o arquivo dele
    // está lá. Quem o descarregou foi o Oxide, e religar o
    // OrigemZAgent o traz de volta sozinho.
    const { plugins } = await harness.library.serverList(SERVER_ID);

    expect(plugins.find((plugin) => plugin.name === PLUGIN_NAME)?.missingRequires).toEqual([
      'OrigemZAgent',
    ]);
  });

  it('tirar um plugin de quem ninguém depende não pede confirmação', async () => {
    const { ui } = await comDependentes();

    await harness.library.setEnabled(SERVER_ID, ui, true);
    await harness.library.setEnabled(SERVER_ID, ui, false);

    expect(existsSync(join(harness.pluginsDir, 'OrigemZUI.cs'))).toBe(false);
  });
});

describe('o conflito de nome', () => {
  it('recusa ligar um custom quando o homônimo da biblioteca já está ligado', async () => {
    const daRede = await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));
    const custom = await harness.library.addCustom(SERVER_ID, PLUGIN_FILE, pluginSource('9.9.9'));

    await harness.library.setEnabled(SERVER_ID, daRede.plugin.id, true);

    let thrown: unknown;

    try {
      await harness.library.setEnabled(SERVER_ID, custom.plugin.id, true);
    } catch (error) {
      thrown = error;
    }

    expect(isApiError(thrown)).toBe(true);

    if (isApiError(thrown)) {
      expect(thrown.status).toBe(409);
      // A recusa diz DE ONDE vem o que está no caminho.
      expect(thrown.message).toContain('biblioteca');
    }

    // E o arquivo do que estava ligado continua intacto: a recusa
    // aconteceu ANTES de qualquer escrita.
    expect(await readFile(join(harness.pluginsDir, PLUGIN_FILE), 'utf8')).toContain('"1.0.0"');
  });

  it('a tela sabe quem está no caminho, pelo blockedBy', async () => {
    const daRede = await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));

    await harness.library.addCustom(SERVER_ID, PLUGIN_FILE, pluginSource('9.9.9'));
    await harness.library.setEnabled(SERVER_ID, daRede.plugin.id, true);

    const { plugins } = await harness.library.serverList(SERVER_ID);

    expect(plugins.find((plugin) => plugin.serverId === SERVER_ID)?.blockedBy).toBe('biblioteca');
    // O que está ligado não bloqueia a si mesmo.
    expect(plugins.find((plugin) => plugin.serverId === null)?.blockedBy).toBeNull();
  });
});

describe('ligar e desligar num servidor', () => {
  let pluginId: number;

  beforeEach(async () => {
    const { plugin } = await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));

    pluginId = plugin.id;
  });

  it('ligar copia o arquivo, grava o applied_sha e recarrega', async () => {
    const { plugin, reload } = await harness.library.setEnabled(SERVER_ID, pluginId, true);

    expect(await readFile(join(harness.pluginsDir, PLUGIN_FILE), 'utf8')).toContain(
      'class OrigemZPlayer',
    );

    expect(plugin.enabled).toBe(true);
    // Em dia: o que está no servidor é o que o acervo tem.
    expect(plugin.appliedSha).toBe(plugin.sha256);
    expect(plugin.updateAvailable).toBe(false);
    expect(plugin.servers).toEqual([SERVER_ID]);

    expect(reload.sent).toBe(true);
    expect(harness.commands).toContain(`oxide.reload ${PLUGIN_NAME}`);
  });

  it('desligar apaga o .cs, descarrega e PRESERVA a configuração', async () => {
    const configPath = join(harness.configDir, `${PLUGIN_NAME}.json`);

    await writeFile(configPath, '{"MinhaOpcao": 42}', 'utf8');

    await harness.library.setEnabled(SERVER_ID, pluginId, true);
    await harness.library.setEnabled(SERVER_ID, pluginId, false);

    expect(existsSync(join(harness.pluginsDir, PLUGIN_FILE))).toBe(false);
    expect(harness.commands).toContain(`oxide.unload ${PLUGIN_NAME}`);

    // ####  ISTO É O TESTE  ####
    //
    // Desligar para experimentar e voltar atrás não pode custar a
    // configuração do plugin. Se este arquivo sumir, o interruptor
    // vira uma decisão cara — e ninguém mais o usa.
    expect(await readFile(configPath, 'utf8')).toBe('{"MinhaOpcao": 42}');
  });

  it('desligar mantém a linha, com enabled = 0', async () => {
    await harness.library.setEnabled(SERVER_ID, pluginId, true);
    await harness.library.setEnabled(SERVER_ID, pluginId, false);

    const row = harness.repository.serverPlugin(SERVER_ID, pluginId);

    // A linha viva é o que separa "desliguei para testar" de
    // "nunca usei".
    expect(row).not.toBeNull();
    expect(row?.enabled).toBe(false);
    expect(row?.appliedSha).toBeNull();
  });

  it('ligar num servidor que não existe é 404', async () => {
    let thrown: unknown;

    try {
      await harness.library.setEnabled('nao-existe', pluginId, true);
    } catch (error) {
      thrown = error;
    }

    expect(isApiError(thrown)).toBe(true);

    if (isApiError(thrown)) {
      expect(thrown.status).toBe(404);
    }
  });
});

describe('a atualização', () => {
  it('subir a versão nova NÃO aplica sozinho: fica pendente', async () => {
    const { plugin } = await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));

    await harness.library.setEnabled(SERVER_ID, plugin.id, true);

    const antes = await readFile(join(harness.pluginsDir, PLUGIN_FILE), 'utf8');
    const { pendingServers } = await harness.library.add(PLUGIN_FILE, pluginSource('2.0.0'));

    expect(pendingServers).toEqual([SERVER_ID]);
    // O arquivo do servidor não foi tocado: cinco servidores no ar
    // não recarregam porque alguém arrastou um arquivo.
    expect(await readFile(join(harness.pluginsDir, PLUGIN_FILE), 'utf8')).toBe(antes);

    const { plugins } = await harness.library.serverList(SERVER_ID);

    expect(plugins[0]?.updateAvailable).toBe(true);
    expect(plugins[0]?.version).toBe('2.0.0');
  });

  it('aplicar é ligar de novo: recopia e volta a ficar em dia', async () => {
    const { plugin } = await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));

    await harness.library.setEnabled(SERVER_ID, plugin.id, true);
    await harness.library.add(PLUGIN_FILE, pluginSource('2.0.0'));

    const aplicado = await harness.library.setEnabled(SERVER_ID, plugin.id, true);

    expect(aplicado.plugin.updateAvailable).toBe(false);
    expect(await readFile(join(harness.pluginsDir, PLUGIN_FILE), 'utf8')).toContain('"2.0.0"');
  });
});

describe('a adoção', () => {
  it('o .cs desconhecido vira CUSTOM daquele servidor', async () => {
    await writeFile(join(harness.pluginsDir, PLUGIN_FILE), pluginSource('0.9.0'));

    await harness.library.adopt(SERVER_ID);

    const adotado = harness.repository.findCustom(SERVER_ID, PLUGIN_NAME);

    expect(adotado?.version).toBe('0.9.0');
    expect(existsSync(join(harness.libraryDir, SERVER_ID, PLUGIN_FILE))).toBe(true);

    // Um .cs solto na pasta de um servidor é DAQUELE servidor até
    // prova em contrário: mandá-lo para a biblioteca de todos seria
    // decidir por quem não pediu.
    expect(harness.repository.findLibrary(PLUGIN_NAME)).toBeNull();

    // Nasce LIGADO: ele já está carregado ali, e dizer o contrário
    // seria a tela mentir sobre o que roda.
    expect(harness.repository.serverPlugin(SERVER_ID, adotado?.id ?? 0)?.enabled).toBe(true);
  });

  it('não apaga o que estava lá', async () => {
    await writeFile(join(harness.pluginsDir, PLUGIN_FILE), pluginSource('0.9.0'));

    await harness.library.adopt(SERVER_ID);

    // Aquele plugin foi decisão de alguém; o agente é que acabou de
    // chegar.
    expect(existsSync(join(harness.pluginsDir, PLUGIN_FILE))).toBe(true);
  });

  it('com o nome já na biblioteca, vincula a ela — e a diferença vira pendência', async () => {
    await harness.library.add(PLUGIN_FILE, pluginSource('2.0.0'));
    await writeFile(join(harness.pluginsDir, PLUGIN_FILE), pluginSource('0.9.0'));

    await harness.library.adopt(SERVER_ID);

    // Não criou custom: o palpite é que aquele arquivo veio da
    // biblioteca, ligado antes de o agente existir.
    expect(harness.repository.findCustom(SERVER_ID, PLUGIN_NAME)).toBeNull();
    expect(harness.repository.findLibrary(PLUGIN_NAME)?.version).toBe('2.0.0');

    // E o servidor entra ligado, porém desatualizado. O agente
    // MOSTRA a diferença em vez de escolher um lado sozinho.
    const { plugins } = await harness.library.serverList(SERVER_ID);

    expect(plugins[0]?.enabled).toBe(true);
    expect(plugins[0]?.updateAvailable).toBe(true);
  });

  it('rodar duas vezes não muda nada', async () => {
    await writeFile(join(harness.pluginsDir, PLUGIN_FILE), pluginSource('0.9.0'));

    await harness.library.adopt(SERVER_ID);
    await harness.library.adopt(SERVER_ID);

    expect(harness.repository.customOf(SERVER_ID)).toHaveLength(1);
  });
});

describe('remover do acervo', () => {
  let pluginId: number;

  beforeEach(async () => {
    const { plugin } = await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));

    pluginId = plugin.id;
  });

  it('com servidores usando, recusa dizendo QUAIS', async () => {
    await harness.library.setEnabled(SERVER_ID, pluginId, true);

    let thrown: unknown;

    try {
      await harness.library.remove(pluginId, false);
    } catch (error) {
      thrown = error;
    }

    expect(isApiError(thrown)).toBe(true);

    if (isApiError(thrown)) {
      expect(thrown.status).toBe(409);
      // A contagem obrigaria a ir procurar quais; o nome resolve.
      expect(thrown.message).toContain(SERVER_ID);
    }
  });

  it('confirmada, sai do acervo e dos servidores — a configuração fica', async () => {
    const configPath = join(harness.configDir, `${PLUGIN_NAME}.json`);

    await writeFile(configPath, '{"MinhaOpcao": 42}', 'utf8');
    await harness.library.setEnabled(SERVER_ID, pluginId, true);

    const { removedFrom } = await harness.library.remove(pluginId, true);

    expect(removedFrom).toEqual([SERVER_ID]);
    expect(existsSync(join(harness.libraryDir, PLUGIN_FILE))).toBe(false);
    expect(existsSync(join(harness.pluginsDir, PLUGIN_FILE))).toBe(false);
    expect(harness.repository.get(pluginId)).toBeNull();
    expect(await readFile(configPath, 'utf8')).toBe('{"MinhaOpcao": 42}');
  });

  it('remover um custom não encosta na biblioteca', async () => {
    const custom = await harness.library.addCustom(
      SERVER_ID,
      'MeuEvento.cs',
      pluginSource('0.1.0', { className: 'MeuEvento' }),
    );

    await harness.library.remove(custom.plugin.id, true);

    expect(harness.repository.findLibrary(PLUGIN_NAME)?.id).toBe(pluginId);
    expect(existsSync(join(harness.libraryDir, PLUGIN_FILE))).toBe(true);
  });
});

describe('a configuração de cada plugin', () => {
  const CONFIG_PATH_OF = (plugin: string): string => join(harness.configDir, `${plugin}.json`);
  const ANTES = '{\n  "Preco": 10\n}';
  const DEPOIS = '{\n  "Preco": 25\n}';

  /** Os backups daquele servidor, em ordem. */
  async function backups(): Promise<string[]> {
    const dir = join(harness.root, 'Backups', SERVER_ID, 'oxide-config');

    try {
      return (await readdir(dir)).sort();
    } catch {
      return [];
    }
  }

  it('lista o que está na pasta, e não o que está no acervo', async () => {
    // A config ÓRFÃ — de um plugin que saiu, ou que nunca passou pelo
    // agente — é justamente a que alguém vai procurar para recuperar
    // horas de ajuste. Escondê-la seria esconder o arquivo que está
    // lá, em disco.
    await writeFile(CONFIG_PATH_OF('PluginQueSaiu'), ANTES, 'utf8');
    await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));
    await writeFile(CONFIG_PATH_OF(PLUGIN_NAME), ANTES, 'utf8');

    const { configs } = await harness.library.configList(SERVER_ID);

    expect(configs.map((config) => config.plugin)).toEqual(['OrigemZPlayer', 'PluginQueSaiu']);
    expect(configs.find((config) => config.plugin === 'PluginQueSaiu')?.inStore).toBe(false);
    expect(configs.find((config) => config.plugin === PLUGIN_NAME)?.inStore).toBe(true);
  });

  it('####  JSON inválido é recusado, e o arquivo em disco não muda  ####', async () => {
    await writeFile(CONFIG_PATH_OF(PLUGIN_NAME), ANTES, 'utf8');

    // O Oxide não carrega um plugin com a config quebrada, e o erro
    // dele sai no console do jogo — longe de quem clicou em gravar.
    // Recusar antes de escrever é o que impede a tela de derrubar um
    // plugin que estava no ar.
    await expect(
      harness.library.configWrite(SERVER_ID, PLUGIN_NAME, '{"Preco": 25,}'),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_PLUGIN_CONFIG' });

    expect(await readFile(CONFIG_PATH_OF(PLUGIN_NAME), 'utf8')).toBe(ANTES);
    // E nem backup houve: nada foi tocado.
    expect(await backups()).toEqual([]);
  });

  it('gravar faz backup ANTES, e o backup tem o conteúdo anterior', async () => {
    await writeFile(CONFIG_PATH_OF(PLUGIN_NAME), ANTES, 'utf8');

    const { backup, config } = await harness.library.configWrite(SERVER_ID, PLUGIN_NAME, DEPOIS);

    expect(backup).not.toBeNull();
    // O backup guarda o que ESTAVA lá — se guardasse o novo, não
    // serviria para desfazer nada.
    expect(await readFile(backup ?? '', 'utf8')).toBe(ANTES);
    expect(config?.text).toBe(DEPOIS);
    expect(await readFile(CONFIG_PATH_OF(PLUGIN_NAME), 'utf8')).toBe(DEPOIS);
  });

  it('a primeira gravação, sem arquivo anterior, não inventa backup', async () => {
    const { backup } = await harness.library.configWrite(SERVER_ID, PLUGIN_NAME, DEPOIS);

    expect(backup).toBeNull();
    expect(await backups()).toEqual([]);
  });

  it('gravar recarrega o plugin LIGADO aqui', async () => {
    const { plugin } = await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));

    await harness.library.setEnabled(SERVER_ID, plugin.id, true);
    harness.commands.length = 0;

    const { reload } = await harness.library.configWrite(SERVER_ID, PLUGIN_NAME, DEPOIS);

    expect(reload.sent).toBe(true);
    expect(harness.commands).toEqual([`oxide.reload ${PLUGIN_NAME}`]);
  });

  it('gravar a config de um plugin DESLIGADO não manda comando nenhum', async () => {
    // Editar a config de um plugin desligado é legítimo: o arquivo
    // está lá e passa a valer quando alguém o ligar. O que não pode é
    // mandar `oxide.reload` de um plugin que aquele servidor não usa
    // — o console do jogo encheria de um erro que não é erro.
    await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));
    harness.commands.length = 0;

    const { reload } = await harness.library.configWrite(SERVER_ID, PLUGIN_NAME, DEPOIS);

    expect(reload.sent).toBe(false);
    expect(harness.commands).toEqual([]);
    expect(await readFile(CONFIG_PATH_OF(PLUGIN_NAME), 'utf8')).toBe(DEPOIS);
  });

  it('restaurar apaga a config, faz backup e NÃO desliga o plugin', async () => {
    const { plugin } = await harness.library.add(PLUGIN_FILE, pluginSource('1.0.0'));

    await harness.library.setEnabled(SERVER_ID, plugin.id, true);
    await writeFile(CONFIG_PATH_OF(PLUGIN_NAME), ANTES, 'utf8');

    const { backup, config } = await harness.library.configReset(SERVER_ID, PLUGIN_NAME);

    expect(await readFile(backup ?? '', 'utf8')).toBe(ANTES);
    // Quem recria o arquivo é o plugin, no próximo carregamento. O
    // RCON aqui é de mentira, então ninguém o recriou.
    expect(config).toBeNull();
    expect(existsSync(CONFIG_PATH_OF(PLUGIN_NAME))).toBe(false);
    // O `.cs` e o interruptor não são da conta do "voltar ao padrão".
    expect(existsSync(join(harness.pluginsDir, PLUGIN_FILE))).toBe(true);
    expect(harness.repository.serverPlugin(SERVER_ID, plugin.id)?.enabled).toBe(true);
  });

  it('o nome com travessia é recusado antes de tocar em disco', async () => {
    // `oxide\config\..\..\..\Configs\server01.ini` é o arquivo que
    // decide em que porta o servidor sobe.
    for (const nome of ['..\\..\\Configs\\server01', '../../evil', 'C:\\Windows\\System32\\x']) {
      await expect(harness.library.configWrite(SERVER_ID, nome, DEPOIS)).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_PLUGIN_NAME',
      });
    }
  });

  it('config vazia é recusada, com o caminho do "voltar ao padrão" na mensagem', async () => {
    await expect(
      harness.library.configWrite(SERVER_ID, PLUGIN_NAME, '   '),
    ).rejects.toMatchObject({ status: 400 });
  });
});
