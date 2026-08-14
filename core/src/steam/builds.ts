// ============================================================
//  builds.ts  -  que versão do Rust está instalada, e qual é a
//                que a Facepunch publicou.
//
//  Duas perguntas, duas fontes, e nenhuma delas é o jogo:
//
//    INSTALADA   Server\steamapps\appmanifest_258550.acf
//                Escrito pelo próprio SteamCMD ao terminar um
//                download. É o registro do que está no disco.
//
//    PUBLICADA   steamcmd +app_info_print 258550
//                Uma consulta ao catálogo da Steam. Não baixa
//                nada — leva ~4 s e alguns KB de rede.
//
//  As duas diferentes = tem atualização esperando.
//
//  ------------------------------------------------------------
//  ####  POR QUE NÃO PERGUNTAR AO SERVIDOR EM QUE VERSÃO ELE ESTÁ ####
//
//  O `serverinfo` do RCON traz `Protocol`, e o protocolo muda
//  quando a Facepunch publica a atualização MENSAL. Mas ele é
//  inútil para isto por duas razões:
//
//   1. Exige o servidor NO AR. Justamente quando ele está parado
//      é que mais interessa saber se há update pendente.
//   2. As correções semanais mudam o build e NÃO mudam o
//      protocolo. O servidor ficaria desatualizado em silêncio.
//
//  O buildid é a única resposta que vale para os dois casos.
//
//  ------------------------------------------------------------
//  ####  A CONFIGURAÇÃO SAI DO .INI DO SERVIDOR, E NÃO DO .env  ####
//
//  AppID, login e branch já estão em `Configs\<serverId>.ini`,
//  seção [SteamCMD] — é de lá que o UpdateServer.bat lê. Duplicá-los
//  no .env do agente criaria duas verdades sobre a MESMA instalação,
//  e no dia em que divergissem o agente compararia o build de um
//  branch com o arquivo baixado de outro: "tem update" para
//  sempre, ou nunca.
//
//  ------------------------------------------------------------
//  ####  UMA CONSULTA, N INSTALAÇÕES  ####
//
//  `queryRemoteBuilds` devolve TODOS os branches de uma vez, e é
//  ela que o vigia usa. O motivo é aritmético: a resposta da Steam
//  é a mesma para a máquina inteira, e cinco servidores fazendo
//  cinco consultas de ~4 s de SteamCMD a cada 15 minutos só
//  disputariam o lock que o update de verdade precisa.
//
//  `queryRemoteBuild` (singular) continua existindo para quem quer
//  UM branch e prefere a mensagem de erro pronta.
// ============================================================

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '../logger.js';
import { toError } from '../util.js';

import { extractBlock, parseVdf, vdfBlock, vdfString } from './vdf.js';

/** O AppID do servidor dedicado, quando o .ini não diz outro. */
export const DEFAULT_STEAM_APP_ID = '258550';

/** O branch padrão da Steam — o que todo servidor de produção usa. */
export const DEFAULT_STEAM_BRANCH = 'public';

export interface InstalledBuild {
  readonly buildId: string;
  /** Quando o SteamCMD terminou o último download. Epoch ms. */
  readonly updatedAt: number | null;
  /**
   * `StateFlags` do manifest — um CAMPO DE BITS, e não um estado.
   *
   * O bit 4 é "instalado por completo". Os outros contam outra
   * história ao mesmo tempo: 2 = atualização pendente,
   * 1024 = update começado, e por aí vai. Uma instalação sã com
   * update esperando responde 1158 (1024+128+4+2), não 4.
   *
   * Foi assim que a primeira versão disto errou: ela comparava
   * com `=== 4` e chamava de "instalação incompleta" um servidor
   * perfeitamente instalado — bastava o SteamCMD já saber que há
   * versão nova. Use `isFullyInstalled`.
   */
  readonly stateFlags: number | null;
}

export interface RemoteBuild {
  readonly branch: string;
  readonly buildId: string;
  /** Quando a Facepunch publicou. Epoch ms. */
  readonly updatedAt: number | null;
}

/** O bit de "instalado por completo" dentro de `StateFlags`. */
export const STATE_FLAG_FULLY_INSTALLED = 4;

/**
 * A instalação está inteira no disco?
 *
 * Testa o BIT, e não o valor: `StateFlags` acumula vários
 * estados de uma vez, e o mais comum deles — "existe atualização
 * publicada" — convive com uma instalação perfeitamente sã.
 *
 * `false` aqui é sério: significa download interrompido ou
 * arquivos faltando, e não "está desatualizado".
 */
export function isFullyInstalled(build: InstalledBuild | null): boolean {
  if (build === null || build.stateFlags === null) {
    return false;
  }

  return (build.stateFlags & STATE_FLAG_FULLY_INSTALLED) !== 0;
}

// ------------------------------------------------------------
//  O QUE ESTÁ INSTALADO
// ------------------------------------------------------------

/** Onde o SteamCMD grava o manifest, dentro da pasta do servidor. */
export function appManifestPath(serverDir: string, appId: string): string {
  return join(serverDir, 'steamapps', `appmanifest_${appId}.acf`);
}

/**
 * Lê o manifest da instalação.
 *
 * `null` quando o arquivo não existe — que é o caso normal de uma
 * máquina onde ninguém rodou o UpdateServer.bat ainda, e não um
 * erro a propagar.
 */
export async function readInstalledBuild(
  serverDir: string,
  appId: string,
): Promise<InstalledBuild | null> {
  let raw: string;

  try {
    raw = await readFile(appManifestPath(serverDir, appId), 'utf8');
  } catch {
    return null;
  }

  return parseInstalledBuild(raw);
}

/** O parser, separado da leitura para o teste não tocar em disco. */
export function parseInstalledBuild(raw: string): InstalledBuild | null {
  const block = extractBlock(raw, 'AppState');

  if (block === null) {
    return null;
  }

  const state = parseVdf(block);
  const buildId = vdfString(state, 'buildid');

  if (buildId === null || buildId.trim() === '') {
    return null;
  }

  return {
    buildId: buildId.trim(),
    updatedAt: epochSecondsToMs(vdfString(state, 'LastUpdated')),
    stateFlags: toInteger(vdfString(state, 'StateFlags')),
  };
}

// ------------------------------------------------------------
//  O QUE A STEAM PUBLICOU
// ------------------------------------------------------------

/**
 * O que uma consulta ao catálogo precisa. SEM branch: a resposta
 * traz todos eles, e escolher é de quem chama.
 */
export interface QueryCatalogOptions {
  /** Caminho absoluto do steamcmd.exe. */
  readonly steamCmdExe: string;
  readonly appId: string;
  /** `anonymous` no servidor dedicado do Rust, que é gratuito. */
  readonly login: string;
  readonly timeoutMs: number;
  readonly logger?: Logger;
}

export interface QueryRemoteBuildOptions extends QueryCatalogOptions {
  /** `public`, `staging`… Ver `branchFromSteamCmdArgs`. */
  readonly branch: string;
}

/**
 * Erro de consulta ao catálogo da Steam.
 *
 * Separado de Error comum porque o tratamento é único: a consulta
 * FALHA com frequência esperada (Steam fora do ar, rede caída,
 * SteamCMD atualizando a si mesmo), e nada disso pode virar
 * incidente. Quem chama registra e tenta de novo no próximo
 * intervalo.
 */
export class SteamQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SteamQueryError';
  }
}

/**
 * Pergunta à Steam o build publicado em CADA branch do app.
 *
 * UMA execução do SteamCMD, e a resposta serve a todos os
 * servidores da máquina — inclusive aos que acompanham branches
 * diferentes. Ver o cabeçalho.
 *
 * ####  `app_info_update 1` NÃO É OPCIONAL  ####
 *
 * O SteamCMD guarda um cache local do catálogo (appinfo.vdf). Sem
 * forçar a atualização, uma máquina que consultou ontem responde
 * o build de ontem — e o agente concluiria "estou em dia" no dia
 * seguinte a uma atualização. O sintoma seria o pior possível:
 * silêncio.
 *
 * @throws {SteamQueryError} quando o SteamCMD não respondeu, ou
 * respondeu sem o bloco do app.
 */
export async function queryRemoteBuilds(
  options: QueryCatalogOptions,
): Promise<ReadonlyMap<string, RemoteBuild>> {
  const output = await runSteamCmd(options);
  const builds = parseRemoteBuilds(output, options.appId);

  if (builds.size === 0) {
    throw new SteamQueryError(
      'O SteamCMD respondeu, mas não veio nenhum branch no bloco do app ' +
        `${options.appId}. Confira o AppID no .ini do servidor, seção [SteamCMD].`,
    );
  }

  return builds;
}

/**
 * O build publicado em UM branch.
 *
 * Atalho de `queryRemoteBuilds` para quem só tem um branch a
 * conferir e prefere a recusa pronta a um `undefined`.
 */
export async function queryRemoteBuild(
  options: QueryRemoteBuildOptions,
): Promise<RemoteBuild> {
  const builds = await queryRemoteBuilds(options);
  const found = pickBranch(builds, options.appId, options.branch);

  if (found instanceof Error) {
    throw found;
  }

  return found;
}

/**
 * O branch pedido dentro de um catálogo já consultado.
 *
 * DEVOLVE o erro em vez de lançar: com N servidores sobre UMA
 * consulta, o branch inexistente de um deles não pode derrubar a
 * conferência dos outros — ele vira o `lastError` daquele servidor
 * e mais nada.
 */
export function pickBranch(
  builds: ReadonlyMap<string, RemoteBuild>,
  appId: string,
  branch: string,
): RemoteBuild | SteamQueryError {
  const found = builds.get(branch.toLowerCase());

  if (found !== undefined) {
    return found;
  }

  const known = [...builds.keys()].join(', ');

  return new SteamQueryError(
    `O branch "${branch}" não existe no app ${appId}. ` +
      `Os que existem: ${known}. Confira STEAM_BRANCH no .ini deste servidor.`,
  );
}

/**
 * Extrai `branch -> build` da saída do `app_info_print`.
 *
 * A chave do mapa é o nome do branch em MINÚSCULAS: quem digita
 * `Public` no .ini quer o mesmo branch de quem digitou `public`, e
 * a Steam não distingue.
 */
export function parseRemoteBuilds(
  output: string,
  appId: string,
): ReadonlyMap<string, RemoteBuild> {
  const result = new Map<string, RemoteBuild>();

  // O bloco do app vem embrulhado em linhas de log do SteamCMD
  // ("Connecting anonymously to Steam Public...OK"), e algumas
  // delas têm aspas. Recortar antes de interpretar é o que impede
  // esse texto de virar chave do documento.
  const block = extractBlock(output, appId);

  if (block === null) {
    return result;
  }

  const app = parseVdf(block);

  // `branches` mora dentro de `depots` — não é intuitivo, e é
  // assim desde sempre.
  const branches = vdfBlock(app, 'depots', 'branches');

  if (branches === null) {
    return result;
  }

  for (const [name, node] of Object.entries(branches)) {
    if (typeof node === 'string') {
      continue;
    }

    const buildId = vdfString(node, 'buildid');

    if (buildId === null || buildId.trim() === '') {
      continue;
    }

    result.set(name.toLowerCase(), {
      branch: name,
      buildId: buildId.trim(),
      // `timeupdated` é quando o branch passou a apontar para
      // este build — que é o instante que interessa a quem
      // pergunta "quando saiu a atualização?".
      updatedAt: epochSecondsToMs(vdfString(node, 'timeupdated')),
    });
  }

  return result;
}

/**
 * O NOME do branch, a partir do que está em `STEAM_BRANCH`.
 *
 * O .ini guarda o valor como ARGUMENTO do SteamCMD, e não como
 * nome:
 *
 *     STEAM_BRANCH=              -> public
 *     STEAM_BRANCH=-beta staging -> staging
 *
 * É o formato que o `app_update` espera, e mudar isso quebraria o
 * UpdateServer.bat. Então a tradução acontece aqui.
 */
export function branchFromSteamCmdArgs(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();

  if (value === '') {
    return DEFAULT_STEAM_BRANCH;
  }

  // `-beta staging` e também `-beta staging -betapassword x`.
  const match = /-beta\s+([^\s]+)/i.exec(value);

  if (match?.[1] !== undefined) {
    return match[1];
  }

  // Alguém escreveu só o nome ("staging"). Não é o formato
  // documentado, mas a intenção é óbvia e recusá-la só produziria
  // uma comparação contra o branch errado.
  return /^[^\s-][^\s]*$/.test(value) ? value : DEFAULT_STEAM_BRANCH;
}

// ------------------------------------------------------------
//  Encanamento
// ------------------------------------------------------------

/**
 * Roda o SteamCMD e devolve a saída inteira.
 *
 * ####  ESTA CHAMADA NÃO BAIXA NADA  ####
 *
 * `app_info_print` só lê o catálogo. É seguro rodá-la de tempos
 * em tempos, com o servidor no ar, sem tocar em nenhum arquivo da
 * instalação. O que ela NÃO pode é acontecer junto de um
 * `app_update`: os dois usam o mesmo lock do SteamCMD, e o
 * segundo a chegar simplesmente falha. Quem agenda isto (o
 * update-watcher) pula a rodada quando há operação em curso.
 */
async function runSteamCmd(options: QueryCatalogOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Os argumentos vão como VETOR e nenhum deles vem de
    // requisição HTTP: appId e login saem do `.ini` do servidor,
    // que é arquivo local do dono. Ainda assim eles são peneirados
    // antes de chegar aqui (ver o watcher) — um valor com espaço
    // viraria dois argumentos.
    const child = spawn(
      options.steamCmdExe,
      [
        '+login',
        options.login,
        '+app_info_update',
        '1',
        '+app_info_print',
        options.appId,
        '+quit',
      ],
      { windowsHide: true },
    );

    let output = '';
    let settled = false;

    const finish = (error: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      if (error === null) {
        resolve(output);
      } else {
        reject(error);
      }
    };

    const timer = setTimeout(() => {
      // O SteamCMD trava de vez em quando (ele se auto-atualiza e
      // às vezes espera por uma entrada que ninguém vai dar). Sem
      // este teto, o processo ficaria pendurado até o fim do
      // agente, segurando o lock que o update de verdade precisa.
      child.kill();
      finish(
        new SteamQueryError(
          `O SteamCMD não respondeu em ${String(Math.round(options.timeoutMs / 1000))}s. ` +
            'A consulta foi abortada.',
        ),
      );
    }, options.timeoutMs);

    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    // O SteamCMD escreve avisos no stderr e o bloco do app no
    // stdout. Juntar os dois só embaralharia o documento, então o
    // stderr vai para o log e não para o parser.
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text !== '') {
        options.logger?.debug({ steamcmd: text }, 'steamcmd stderr');
      }
    });

    child.on('error', (error: unknown) => {
      finish(
        new SteamQueryError(
          `Não deu para executar o SteamCMD (${options.steamCmdExe}): ${toError(error).message}`,
        ),
      );
    });

    child.on('close', (code) => {
      // O código de saída é ignorado de propósito: o SteamCMD sai
      // com valores diferentes de zero em situações que não são
      // erro (ele acabou de se atualizar, por exemplo) e a
      // resposta que importa é o bloco do app estar na saída. Se
      // não estiver, quem interpreta é que reclama — com uma
      // frase melhor do que "código 7".
      options.logger?.debug({ exitCode: code }, 'steamcmd finished');
      finish(null);
    });
  });
}

function epochSecondsToMs(raw: string | null): number | null {
  const seconds = toInteger(raw);
  return seconds === null || seconds <= 0 ? null : seconds * 1000;
}

function toInteger(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }

  const value = Number(raw.trim());
  return Number.isInteger(value) ? value : null;
}
