// ============================================================
//  steam-update.test.ts  -  o SteamCMD FALHOU. O agente percebe?
//
//  ####  O DEFEITO QUE ISTO TRAVA  ####
//
//  Numa atualização de verdade, o SteamCMD respondeu:
//
//      Update state (0x3) reconfiguring, progress: 0.00 (0 / 0)
//      Error! App '258550' state is 0x486 after update job.
//      [SteamCMD] terminou com código 8
//
//  ...e o agente seguiu em frente: aplicou o Oxide, subiu o
//  servidor e anunciou "jogo instalado" — com o build ANTIGO em
//  disco. Um servidor de build antigo não fica lento: ele recusa
//  TODOS os jogadores, em silêncio.
//
//  A conferência não pode ser o executável do jogo existir (numa
//  atualização ele já existe desde antes) nem o código de saída
//  (que é 7/8 em execuções boas). É a LINHA DE ERRO do SteamCMD e
//  o BUILDID que sobrou no manifest.
// ============================================================

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';
import { openOperationLogFile } from '../src/ops/op-log-file.js';
import { Operation } from '../src/ops/operations.js';

import { isFullyInstalled, parseInstalledBuild } from '../src/steam/builds.js';
import { explainAppState, progressOf, steamCmdFailure } from '../src/steam/steamcmd.js';

describe('steamCmdFailure', () => {
  it('reconhece o job que terminou com o app fora de ordem', () => {
    const failure = steamCmdFailure("Error! App '258550' state is 0x486 after update job.");

    expect(failure).not.toBeNull();
    expect(failure).toContain('0x486');
    expect(failure).toContain('NÃO foi aplicada');
  });

  it('reconhece a recusa de instalar, com o motivo entre parênteses', () => {
    const failure = steamCmdFailure("ERROR! Failed to install app '258550' (Disk write failure)");

    expect(failure).toContain('Disk write failure');
  });

  it('reconhece disco cheio, login recusado e queda de conexão', () => {
    expect(steamCmdFailure(' Update state (0x61) downloading: Disk write failure')).toContain(
      'espaço em disco',
    );
    expect(steamCmdFailure('Login Failure: Invalid Password')).toContain('login');
    expect(steamCmdFailure('Timeout downloading item')).toContain('conexão');
  });

  // ####  A LINHA NORMAL NÃO PODE VIRAR FALHA  ####
  //
  // O SteamCMD anuncia o redirecionamento do stderr em TODA
  // execução, e as linhas de progresso trazem "state" no meio.
  // Confundir qualquer uma delas com erro reprovaria toda
  // atualização que dá certo — que é o defeito oposto, e igual
  // de ruim.
  it('deixa passar as linhas normais de uma execução boa', () => {
    const normais = [
      'Steam Console Client (c) Valve Corporation - version 1785799152',
      'Loading Steam API...OK',
      'Connecting anonymously to Steam Public...OK',
      "Redirecting stderr to 'C:\\OrigemZ\\RustAgent\\SteamCMD\\logs\\stderr.txt'",
      "Logging directory: 'C:\\OrigemZ\\RustAgent\\SteamCMD/logs'",
      '[  0%] Checking for available updates...',
      '[----] Verifying installation...',
      ' Update state (0x61) downloading, progress: 42.15 (2695091 / 6394838)',
      ' Update state (0x81) verifying update, progress: 8.00 (5 / 62)',
      "Success! App '258550' fully installed.",
      "Success! App '258550' already up to date.",
    ];

    for (const line of normais) {
      expect(steamCmdFailure(line), line).toBeNull();
    }
  });
});

describe('explainAppState', () => {
  it('abre o campo de bits do estado que apareceu na falha real', () => {
    const texto = explainAppState('0x486');

    expect(texto).toContain('atualização pendente');
    expect(texto).toContain('arquivos corrompidos');
    expect(texto).toContain('atualização começada e não terminada');
  });

  it('não inventa nome para o que não reconhece', () => {
    expect(explainAppState('não é hexadecimal')).toBe('estado desconhecido');
  });
});

describe('progressOf', () => {
  it('lê o percentual da linha de progresso e ignora o resto', () => {
    expect(progressOf(' Update state (0x61) downloading, progress: 42.15 (269 / 639)')).toBeCloseTo(
      42.15,
    );
    expect(progressOf('Connecting anonymously to Steam Public...OK')).toBeNull();
  });
});

// ------------------------------------------------------------
//  O manifest depois de um job que abortou
// ------------------------------------------------------------

/** O `appmanifest_258550.acf` como o SteamCMD o deixou na falha. */
function manifest(buildId: string, stateFlags: number): string {
  return `"AppState"
{
\t"appid"\t\t"258550"
\t"Universe"\t\t"1"
\t"name"\t\t"Rust Dedicated Server"
\t"StateFlags"\t\t"${String(stateFlags)}"
\t"buildid"\t\t"${buildId}"
\t"LastUpdated"\t\t"1755500000"
}`;
}

describe('o manifest de um job que abortou', () => {
  // ####  POR QUE `isFullyInstalled` NÃO BASTA AQUI  ####
  //
  // 0x486 tem o bit 4 aceso: para o Steam, os arquivos do build
  // ANTIGO continuam inteiros em disco — e continuam mesmo. O que
  // não aconteceu foi a TROCA. Quem responde isso é o buildid.
  it('continua "instalado por completo", e por isso o buildid é que decide', () => {
    const build = parseInstalledBuild(manifest('24774405', 0x486));

    expect(build?.buildId).toBe('24774405');
    expect(isFullyInstalled(build)).toBe(true);
    expect(build?.buildId).not.toBe('24793074');
  });

  it('a instalação boa fica com o build publicado', () => {
    const build = parseInstalledBuild(manifest('24793074', 4));

    expect(build?.buildId).toBe('24793074');
    expect(isFullyInstalled(build)).toBe(true);
  });
});

// ============================================================
//  ####  O LOG DA OPERAÇÃO PRECISA SOBREVIVER À OPERAÇÃO  ####
//
//  A tentativa automática que falhou às 19:25 só existia no
//  console ao vivo do painel: 2.000 linhas em memória, apagadas
//  no `pm2 restart`. Quem fosse investigar de manhã encontrava o
//  log do PM2 SEM UMA LINHA DO STEAMCMD — ele nunca passou por
//  lá. Sem arquivo, não há o que ler; e sem o que ler, o palpite
//  vira diagnóstico.
// ============================================================

describe('o log de uma operação em disco', () => {
  it('grava as linhas e o desfecho, e o desfecho chega a quem esperava', async () => {
    const logsDir = await mkdtemp(join(tmpdir(), 'rustagent-ops-'));
    const operation = new Operation('server-auto-update', 'oz-vanilla');

    const file = openOperationLogFile(operation, {
      logsDir,
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
    });

    expect(file).not.toBeNull();
    operation.pipeTo(file!.sink);

    operation.log("Error! App '258550' state is 0x486 after update job.");
    operation.finish('failed', 'o job terminou com o app no estado 0x486');

    // `done` é o que o vigia da Steam usa para saber COMO acabou
    // a tentativa que ele mesmo disparou.
    const finished = await operation.done;

    expect(finished.status).toBe('failed');

    // A escrita ainda está a caminho do disco quando `finish`
    // devolve o controle.
    await file!.closed;

    const text = await readFile(file!.path, 'utf8');

    expect(text).toContain('server-auto-update');
    expect(text).toContain("state is 0x486");
    expect(text).toContain('FAILED');
    expect(text).toContain('o job terminou com o app no estado 0x486');
  });

  it('a operação anda mesmo quando não dá para abrir o arquivo', () => {
    const operation = new Operation('server-update', 'oz-vanilla');

    // Sem `pipeTo`: é o que acontece quando a pasta de logs não
    // aceita escrita. Escrever log não pode derrubar atualização.
    expect(() => {
      operation.log('[agente] seguindo sem arquivo');
      operation.finish('succeeded', null);
    }).not.toThrow();

    expect(operation.logFrom(0)).toHaveLength(1);
  });
});
