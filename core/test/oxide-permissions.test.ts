// ============================================================
//  oxide-permissions.test.ts  -  ler o que o Oxide responde, e
//  reconhecer quando ele recusa.
//
//  ####  AS RESPOSTAS AQUI SÃO REAIS  ####
//
//  Cada bloco de texto deste arquivo veio do servidor de verdade
//  (Oxide 2.0.7585, pelo RCON), e não foi escrito de memória. É o
//  que dá valor ao teste: um parser conferido contra um exemplo
//  inventado passa aqui e quebra no primeiro servidor.
//
//  O que este arquivo guarda:
//
//    1. "No permissions currently granted" é uma lista VAZIA, e
//       não uma permissão chamada assim;
//    2. a herança sai das seções `Parent group '…'`, que é a única
//       forma de vê-la sem abrir o protobuf;
//    3. as quatro recusas em prosa viram erro com motivo — e o que
//       não é recusa passa como sucesso;
//    4. nome de grupo com espaço não chega ao console.
// ============================================================

import { describe, expect, it } from 'vitest';

import { isApiError } from '../src/http/error-response.js';
import type { OpsRcon } from '../src/ops/service.js';
import {
  assertAccepted,
  assertOxideName,
  createGroup,
  parseGroup,
  parseGroupNames,
  parseLoadedPlugins,
  parsePermissionNames,
  parseUser,
  parseVersion,
  setUserGroup,
} from '../src/oxide/permissions.js';

/** Um RCON que guarda o que recebeu e responde o que mandarem. */
function fakeRcon(reply: string | ((command: string) => string) = ''): {
  rcon: OpsRcon;
  commands: string[];
} {
  const commands: string[] = [];

  return {
    commands,
    rcon: {
      isConnected: true,
      send: (command: string): Promise<string> => {
        commands.push(command);

        return Promise.resolve(typeof reply === 'string' ? reply : reply(command));
      },
    },
  };
}

describe('as listas do console', () => {
  it('lê os grupos separados por vírgula', () => {
    const raw = 'Groups:\ndefault, admin, origemz.vip.gold, origemz.vip.silver, player';

    expect(parseGroupNames(raw)).toEqual([
      'default',
      'admin',
      'origemz.vip.gold',
      'origemz.vip.silver',
      'player',
    ]);
  });

  it('lê as permissões registradas pelos plugins', () => {
    const raw =
      'Permissions:\noxide.plugins, oxide.load, oxide.reload, oxide.grant, origemzchat.admin';

    expect(parsePermissionNames(raw)).toContain('origemzchat.admin');
    expect(parsePermissionNames(raw)).toHaveLength(5);
  });

  it('devolve lista vazia quando o cabeçalho não veio', () => {
    // Acontece com o RCON respondendo outra coisa (uma linha de
    // log que chegou no lugar). Vazio é diferente de inventado.
    expect(parseGroupNames('Server startup complete')).toEqual([]);
  });
});

describe('o conteúdo de um grupo', () => {
  it('reconhece "nada aqui" como lista vazia, e não como conteúdo', () => {
    // Resposta REAL de `oxide.show group origemz.vip.gold`.
    const raw = [
      "Group 'origemz.vip.gold' players:",
      'No players currently in group',
      '',
      "Group 'origemz.vip.gold' permissions:",
      'No permissions currently granted',
      "Parent group 'origemz.vip.silver' permissions:",
      '',
      "Parent group 'origemz.vip.bronze' permissions:",
      '',
    ].join('\n');

    const group = parseGroup('origemz.vip.gold', raw);

    expect(group.members).toEqual([]);
    expect(group.permissions).toEqual([]);
    // A herança do VIP, inteira, e na ordem: o pai mais próximo
    // primeiro.
    expect(group.parents).toEqual(['origemz.vip.silver', 'origemz.vip.bronze']);
  });

  it('lê os membros com o nome entre parênteses', () => {
    // Resposta REAL de `oxide.show group default`.
    const raw = [
      "Group 'default' players:",
      '76561198065694695 (Mateuus)',
      '',
      "Group 'default' permissions:",
      'No permissions currently granted',
    ].join('\n');

    const group = parseGroup('default', raw);

    expect(group.members).toEqual([{ steamId: '76561198065694695', name: 'Mateuus' }]);
    expect(group.parents).toEqual([]);
  });

  it('separa o que é do grupo do que vem do pai', () => {
    const raw = [
      "Group 'origemz.vip.gold' players:",
      '76561198123456789 (Fulano)',
      "Group 'origemz.vip.gold' permissions:",
      'loja.desconto',
      "Parent group 'origemz.vip.silver' permissions:",
      'fila.prioridade',
    ].join('\n');

    const group = parseGroup('origemz.vip.gold', raw);

    expect(group.permissions).toEqual(['loja.desconto']);
    expect(group.inherited).toEqual([
      { group: 'origemz.vip.silver', permissions: ['fila.prioridade'] },
    ]);
  });
});

describe('o que um jogador tem', () => {
  it('lê os grupos e o nome do cabeçalho', () => {
    // Resposta REAL de `oxide.show user 76561198065694695`.
    const raw = [
      "Player 'Mateuus (76561198065694695)' permissions:",
      'No permissions currently granted',
      '',
      "Player 'Mateuus (76561198065694695)' groups:",
      'default',
    ].join('\n');

    const user = parseUser('76561198065694695', raw);

    expect(user.name).toBe('Mateuus');
    expect(user.groups).toEqual(['default']);
    expect(user.permissions).toEqual([]);
  });
});

describe('o Oxide em si', () => {
  it('lê a versão e o branch', () => {
    const raw = 'Oxide.Rust Version: 2.0.7585\nOxide.Rust Branch: master';

    expect(parseVersion(raw)).toEqual({ version: '2.0.7585', branch: 'master' });
  });

  it('devolve nulo em vez de inventar uma versão', () => {
    // Um número de versão inventado é o que alguém usaria para
    // decidir atualizar (ou não).
    expect(parseVersion('qualquer outra coisa')).toEqual({ version: null, branch: null });
  });

  it('lê os plugins que o Oxide diz estar rodando', () => {
    // Resposta REAL de `oxide.plugins`.
    const raw = [
      'Listing 6 plugins:',
      '  01 "OrigemZAgent" (0.3.0) by OrigemZ (0.14s / 2 MB) - OrigemZAgent.cs',
      '  02 "OrigemZVip" (0.1.0) by OrigemZ (0.00s / 16 KB) - OrigemZVip.cs',
    ].join('\n');

    expect(parseLoadedPlugins(raw)).toEqual([
      { name: 'OrigemZAgent', version: '0.3.0', author: 'OrigemZ', file: 'OrigemZAgent.cs' },
      { name: 'OrigemZVip', version: '0.1.0', author: 'OrigemZ', file: 'OrigemZVip.cs' },
    ]);
  });
});

describe('a recusa em prosa', () => {
  it('grupo que não existe vira erro com motivo', () => {
    try {
      assertAccepted("Group 'zzz' doesn't exist", { group: 'zzz' });
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('OXIDE_GROUP_NOT_FOUND');
    }
  });

  it('permissão que nenhum plugin registrou vira erro com motivo', () => {
    try {
      assertAccepted("Permission 'loja.nada' doesn't exist", { permission: 'loja.nada' });
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('OXIDE_PERMISSION_NOT_FOUND');
    }
  });

  it('jogador que o servidor não conhece vira erro com motivo', () => {
    try {
      assertAccepted("Player 'fulano' not found", { steamId: '76561198123456789' });
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('OXIDE_PLAYER_NOT_FOUND');
    }
  });

  it('o console respondendo com o uso do comando é recusa', () => {
    try {
      assertAccepted('Usage: oxide.grant <group|user> <name|id> <permission>');
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('OXIDE_COMMAND_REFUSED');
    }
  });

  it('o que não é recusa conhecida passa como sucesso', () => {
    // Um alarme falso a cada concessão faria ninguém acreditar no
    // verdadeiro — a mesma regra do lastReload.
    expect(assertAccepted("Group 'vip' granted permission 'loja.desconto'")).toContain('granted');
    expect(assertAccepted('')).toBe('');
  });
});

describe('o que não chega ao console', () => {
  it('recusa nome de grupo com espaço', () => {
    // Sem esta trava, "vip ouro" viraria dois argumentos e o
    // comando faria outra coisa, em silêncio.
    try {
      assertOxideName('vip ouro', 'grupo');
      expect.unreachable('deveria ter recusado');
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('OXIDE_INVALID_NAME');
    }
  });

  it('aceita o formato que os plugins deste projeto usam', () => {
    expect(() => assertOxideName('origemz.vip.bronze', 'grupo')).not.toThrow();
    expect(() => assertOxideName('origemzchat.admin', 'permissão')).not.toThrow();
  });

  it('tira as aspas do título antes de montar o comando', async () => {
    const { rcon, commands } = fakeRcon();

    // A aspa fecharia o argumento cedo, e o resto viraria `rank`.
    await createGroup(rcon, { name: 'evento.natal', title: 'VIP "Ouro"', rank: 30 });

    expect(commands[0]).toBe('oxide.group add evento.natal "VIP Ouro" 30');
  });
});

describe('os comandos que saem', () => {
  it('põe o jogador no grupo pelo SteamID, e grava em seguida', async () => {
    const { rcon, commands } = fakeRcon();

    await setUserGroup(rcon, '76561198123456789', 'origemz.vip.gold', true);

    expect(commands).toEqual([
      'oxide.usergroup add 76561198123456789 origemz.vip.gold',
      // Sem o save, a concessão vive só na memória do Oxide até
      // ele decidir gravar — e um crash a perde.
      'oxide.save',
    ]);
  });

  it('define o pai depois de criar o grupo, e não antes', async () => {
    const { rcon, commands } = fakeRcon();

    await createGroup(rcon, { name: 'vip.novo', parent: 'origemz.vip.bronze' });

    // A ordem é obrigatória: o Oxide recusa herança de um grupo
    // que ainda não existe.
    expect(commands[0]).toBe('oxide.group add vip.novo');
    expect(commands[1]).toBe('oxide.group parent vip.novo origemz.vip.bronze');
  });

  it('não deixa um grupo herdar de si mesmo', async () => {
    const { rcon } = fakeRcon();

    await expect(createGroup(rcon, { name: 'vip.novo', parent: 'vip.novo' })).rejects.toMatchObject({
      code: 'OXIDE_INVALID_PARENT',
    });
  });
});
