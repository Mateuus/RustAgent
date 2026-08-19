// ============================================================
//  server-config.test.ts  -  o que vira LINHA DE COMANDO do jogo.
//
//  ####  ERRO AQUI NÃO DÁ ERRO EM LUGAR NENHUM  ####
//
//  O `RustDedicated.exe` aceita o que receber. Um parâmetro que ele
//  não conhece é IGNORADO em silêncio; um que ele conhece, com valor
//  vazio, muda o comportamento do servidor sem nada no log.
//
//  Foi assim que um `+server.password` inventado atravessou teste,
//  build e produção: o jogo não reclamou, e o servidor continuou
//  aberto para todo mundo. O convar não existe — `find password`
//  responde só `rcon.*`, e `server.password` dá o mesmo erro de um
//  nome sorteado.
//
//  Por isso os opcionais têm teste: eles só entram quando foram
//  preenchidos, e só podem ser parâmetros que o jogo conhece.
// ============================================================

import { describe, expect, it } from 'vitest';

import type { ServerConfig } from '../src/config.js';
import { serverArgs } from '../src/ops/server-process.js';
import { applyIniValues } from '../src/servers/create-server.js';

/** Um servidor qualquer, com o que o teste precisar por cima. */
function config(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'pvp1',
    name: 'PVP 1',
    hostname: 'PVP 1',
    identity: 'pvp1',
    description: '',
    url: '',
    headerImage: '',
    level: 'Procedural Map',
    seed: 12_345,
    worldSize: 4000,
    // Vazio = mundo procedural, e a linha de comando sai sem
    // `+server.levelurl`. O `as ServerConfig` lá embaixo deixaria
    // este campo faltar em silêncio, e a fixture passaria
    // `undefined` para o jogo. Ver wipe-map-pool.test.ts.
    levelUrl: '',
    maxPlayers: 200,
    saveInterval: 600,
    enabled: true,
    consoleWindow: false,
    ports: { game: 28_015, rcon: 28_016, query: 28_017, app: 28_082 },
    rcon: { host: '127.0.0.1', port: 28_016, password: 'senha-do-rcon' },
    steam: { appId: '258550', login: 'anonymous', branch: 'public' },
    paths: {
      configPath: 'F:\\Configs\\pvp1.ini',
      installDir: 'F:\\Servers\\pvp1',
      exePath: 'F:\\Servers\\pvp1\\RustDedicated.exe',
      identityDir: 'F:\\Servers\\pvp1\\server\\pvp1',
      oxideDir: 'F:\\Servers\\pvp1\\oxide',
      oxidePluginsDir: 'F:\\Servers\\pvp1\\oxide\\plugins',
      oxideConfigDir: 'F:\\Servers\\pvp1\\oxide\\config',
      logsDir: 'F:\\Logs\\pvp1',
      backupsDir: 'F:\\Backups\\pvp1',
    },
    ...over,
  } as ServerConfig;
}

/** O valor que veio DEPOIS daquele parâmetro. `null` = não veio. */
function valueOf(args: readonly string[], key: string): string | null {
  const at = args.indexOf(key);

  return at < 0 ? null : (args[at + 1] ?? null);
}

describe('a linha de comando do jogo', () => {
  it('os outros opcionais seguem a mesma regra', () => {
    const vazio = serverArgs(config(), 'x.log');

    expect(vazio).not.toContain('+server.url');
    expect(vazio).not.toContain('+server.description');
    expect(vazio).not.toContain('+server.headerimage');

    const cheio = serverArgs(
      config({ url: 'https://exemplo', description: 'oi', headerImage: 'https://img' }),
      'x.log',
    );

    expect(valueOf(cheio, '+server.url')).toBe('https://exemplo');
  });

  it('a seed e o tamanho do mundo viajam juntos', () => {
    // Os dois definem o mapa: a mesma seed com tamanho diferente dá
    // um mundo diferente, e é por isso que o rustmaps pede os dois.
    const args = serverArgs(config({ seed: 987_654, worldSize: 3500 }), 'x.log');

    expect(valueOf(args, '+server.seed')).toBe('987654');
    expect(valueOf(args, '+server.worldsize')).toBe('3500');
  });
});

describe('a gravação do .ini', () => {
  it('reescreve a chave que já existe, no lugar dela', () => {
    const ini = ['SERVER_HOSTNAME=Antigo', 'SERVER_URL=', 'SERVER_SEED=1'].join('\n');
    const out = applyIniValues(ini, { SERVER_URL: 'https://novo' });

    expect(out).toContain('SERVER_URL=https://novo');
    // E não duplica a chave no fim.
    expect(out.match(/SERVER_URL=/g)).toHaveLength(1);
  });

  it('acrescenta a chave que o modelo não trazia', () => {
    // Um `.ini` gravado antes de um campo existir precisa continuar
    // funcionando: a chave entra no fim, com um comentário dizendo
    // de onde veio.
    const out = applyIniValues('SERVER_HOSTNAME=X', { SERVER_SAVEINTERVAL: '900' });

    expect(out).toContain('SERVER_SAVEINTERVAL=900');
  });

  it('preserva o CRLF do arquivo original', () => {
    // Estes arquivos são lidos pelo `for /f` do cmd.exe, e trocar
    // CRLF por LF é o tipo de coisa que se descobre na marra.
    const out = applyIniValues('SERVER_HOSTNAME=X\r\nSERVER_SEED=1', { SERVER_SEED: '2' });

    expect(out).toContain('\r\n');
    expect(out).toContain('SERVER_SEED=2');
  });
});
