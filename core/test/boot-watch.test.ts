// ============================================================
//  boot-watch.test.ts  -  o boot MORREU. O agente percebe?
//
//  ####  O DEFEITO QUE ISTO TRAVA  ####
//
//  Na noite de 03/09/2026 o servidor subiu com um Oxide feito
//  para o build anterior do Rust. O log do jogo terminou assim:
//
//      MissingMethodException: Method not found: void
//      Facepunch.ExceptionReporter.InitializeFromUrl(string)
//        at UnityEngine.SetupCoroutine.InvokeMoveNext (...)
//
//  ...e o agente esperou QUINZE MINUTOS olhando `rcon.isConnected`,
//  para então dizer "pode ser um mapa grande ainda gerando". O
//  processo estava vivo o tempo todo; o RCON nunca ia abrir.
//
//  ####  E O DEFEITO QUE ISTO NÃO PODE CRIAR  ####
//
//  Um boot SAUDÁVEL do Rust está cheio de linha assustadora —
//  `SocketException`, `Missing shader`, `not found`. As linhas
//  abaixo são de um boot que terminou BEM, com o servidor no ar.
//  Se alguma delas passar a matar a operação, o agente derruba
//  servidores que iam subir.
// ============================================================

import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BootLogWatcher, fatalBootError } from '../src/ops/boot-watch.js';

/** A linha exata que travou o servidor naquela noite. */
const A_LINHA =
  'MissingMethodException: Method not found: void ' +
  'Facepunch.ExceptionReporter.InitializeFromUrl(string)';

/** Linhas colhidas de um boot que terminou com o servidor NO AR. */
const BOOT_SAUDAVEL = [
  "Shader 'Soft Mask/TextMeshPro/Distance Field': fallback shader " +
    "'TextMeshPro/Mobile/Distance Field' not found",
  'Missing shader in Main Camera (TOD_Scattering)',
  'Missing EnvSync - creating',
  'Missing CommunityEntity - creating',
  'SocketException: Foi forçado o cancelamento de uma conexão existente pelo host remoto.',
  'Rethrow as IOException: Unable to read data from the transport connection: ' +
    'Foi forçado o cancelamento de uma conexão existente pelo host remoto.',
  "Can't find custom attr constructor image: Assembly-CSharp.dll mtoken: 0x0a002bd9 due to: " +
    'Could not resolve type with token 0100052d from typeref',
  '3D Noise requires higher shader capabilities (Shader Model 3.5 / OpenGL ES 3.0)',
  'HDR Render Texture not supported, disabling HDR on reflection probe.',
  'WebSocket RCON Started on :28016',
  'Generating procedural map of size 4000 with seed 1509704652',
  '[2.0s] Loading Monument Prefabs',
  '[0.6s] Height Map',
  '[0.4s] Lakes',
];

describe('fatalBootError', () => {
  it('reconhece a linha que travou o servidor em 03/09', () => {
    const fatal = fatalBootError(A_LINHA);

    expect(fatal).not.toBeNull();
    expect(fatal?.line).toBe(A_LINHA);
    expect(fatal?.what).toContain('método');
  });

  it('reconhece as outras exceções de assembly incompatível', () => {
    expect(fatalBootError('TypeLoadException: Could not load type X')).not.toBeNull();
    expect(fatalBootError('MissingFieldException: Field not found: Y')).not.toBeNull();
    expect(fatalBootError('BadImageFormatException: bad IL')).not.toBeNull();
    expect(
      fatalBootError("Could not load file or assembly 'Rust.RenderPipeline'"),
    ).not.toBeNull();
    expect(fatalBootError('ReflectionTypeLoadException: some types')).not.toBeNull();
  });

  // ####  ESTE É O TESTE QUE MAIS IMPORTA  ####
  //
  // Falso positivo aqui mata a operação de um servidor que ia
  // subir — e ao contrário do falso negativo, ninguém descobre
  // pelo log: a operação simplesmente "falhou".
  it.each(BOOT_SAUDAVEL)('não confunde linha de boot saudável: %s', (line) => {
    expect(fatalBootError(line)).toBeNull();
  });

  // `NullReferenceException` é o pão de cada dia de plugin mal
  // escrito, e não derruba servidor nenhum. Fica de fora de
  // propósito.
  it('deixa NullReferenceException passar — ela não mata o boot', () => {
    expect(fatalBootError('NullReferenceException: Object reference not set')).toBeNull();
  });
});

describe('BootLogWatcher', () => {
  const temporarios: string[] = [];

  afterEach(async () => {
    await Promise.all(temporarios.map((dir) => rm(dir, { recursive: true, force: true })));
    temporarios.length = 0;
  });

  async function logNovo(conteudo = ''): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'boot-watch-'));

    temporarios.push(dir);

    const path = join(dir, 'server-server01.log');

    await writeFile(path, conteudo, 'utf8');

    return path;
  }

  it('não reclama do log que ainda não existe', async () => {
    const watcher = new BootLogWatcher(join(tmpdir(), 'nao-existe', 'server.log'));

    await expect(watcher.read()).resolves.toEqual([]);
    await expect(watcher.findFatal()).resolves.toBeNull();
  });

  it('lê só o que cresceu desde a última vez', async () => {
    const path = await logNovo('primeira\n');
    const watcher = new BootLogWatcher(path);

    expect(await watcher.read()).toEqual(['primeira']);
    expect(await watcher.read()).toEqual([]);

    await appendFile(path, 'segunda\nterceira\n', 'utf8');

    expect(await watcher.read()).toEqual(['segunda', 'terceira']);
  });

  // O log cresce em PEDAÇOS, e um deles pode cortar a exceção ao
  // meio. Sem guardar o resto, a linha partida não casaria com
  // padrão nenhum — e o boot morto passaria batido.
  it('junta a linha partida entre duas leituras', async () => {
    const path = await logNovo('');
    const watcher = new BootLogWatcher(path);

    await appendFile(path, 'MissingMethod', 'utf8');
    expect(await watcher.findFatal()).toBeNull();

    await appendFile(path, 'Exception: Method not found\n', 'utf8');

    const fatal = await watcher.findFatal();

    expect(fatal?.line).toBe('MissingMethodException: Method not found');
  });

  it('acha a exceção no meio de um boot cheio de linha inofensiva', async () => {
    const path = await logNovo(`${BOOT_SAUDAVEL.join('\n')}\n${A_LINHA}\n`);
    const watcher = new BootLogWatcher(path);

    const fatal = await watcher.findFatal();

    expect(fatal?.line).toBe(A_LINHA);
  });

  it('não acha nada no boot que terminou bem', async () => {
    const path = await logNovo(`${BOOT_SAUDAVEL.join('\n')}\n`);
    const watcher = new BootLogWatcher(path);

    await expect(watcher.findFatal()).resolves.toBeNull();
  });

  // Um start novo reabre o mesmo caminho do zero. Ler a partir do
  // offset antigo devolveria texto do meio de outra execução.
  it('recomeça quando o arquivo encolhe (outro start reescreveu)', async () => {
    const path = await logNovo('linha muito longa da execução anterior\n');
    const watcher = new BootLogWatcher(path);

    await watcher.read();
    await writeFile(path, 'novo\n', 'utf8');

    expect(await watcher.read()).toEqual(['novo']);
  });

  it('guarda as últimas linhas para a mensagem de quem desistiu', async () => {
    const path = await logNovo(`${BOOT_SAUDAVEL.join('\n')}\n`);
    const watcher = new BootLogWatcher(path);

    await watcher.read();

    const tail = watcher.tail();

    expect(tail.length).toBeLessThanOrEqual(12);
    expect(tail.at(-1)).toBe('[0.4s] Lakes');
  });
});
