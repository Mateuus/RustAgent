// ============================================================
//  oxide-install-recusa.test.ts  -  a instalação DESISTE antes de
//  encostar no disco.
//
//  ####  POR QUE "ANTES" É A PARTE QUE IMPORTA  ####
//
//  Recusar depois de copiar o `oxide\` para `Backups\` deixaria
//  um backup órfão a cada rodada do vigia — de quinze em quinze
//  minutos, enquanto o OxideMod não publicasse. Em uma noite são
//  dezenas de pastas para alguém decifrar depois.
//
//  E recusar depois de extrair seria pior ainda: os assemblies
//  errados já estariam em `Managed\`, que é exatamente o estado
//  que esta conferência existe para evitar.
//
//  Por isso o teste não olha só a mensagem do erro: ele olha o
//  DISCO, e exige que nada tenha se mexido.
// ============================================================

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OxideBehindRustError, type OxideRelease } from '../src/oxide/compat.js';
import { installOxide } from '../src/oxide/install.js';

const RUST_BUILD_25083359 = Date.parse('2026-09-03T17:29:23.000Z');

/** A release que travou o servidor: de 28/08, para o build de setembro. */
const OXIDE_DEFASADA: OxideRelease = {
  tag: '2.0.7638',
  publishedAt: Date.parse('2026-08-28T10:57:01Z'),
  zipUrl: 'https://exemplo/nao-deve-ser-baixado.zip',
};

describe('installOxide recusa a release anterior ao build do Rust', () => {
  const temporarios: string[] = [];

  afterEach(async () => {
    await Promise.all(temporarios.map((dir) => rm(dir, { recursive: true, force: true })));
    temporarios.length = 0;
  });

  /** Uma instalação de mentira, com o que a conferência exige ver. */
  async function instalacao(): Promise<{ installDir: string; backupsDir: string }> {
    const raiz = await mkdtemp(join(tmpdir(), 'oxide-recusa-'));

    temporarios.push(raiz);

    const installDir = join(raiz, 'Servers', 'server01');
    const backupsDir = join(raiz, 'Backups', 'server01');

    await mkdir(join(installDir, 'RustDedicated_Data', 'Managed'), { recursive: true });
    await mkdir(join(installDir, 'oxide', 'plugins'), { recursive: true });
    await writeFile(join(installDir, 'oxide', 'plugins', 'OrigemZUI.cs'), '// meu plugin', 'utf8');

    return { installDir, backupsDir };
  }

  it('lança OxideBehindRustError com a versão e o build na frase', async () => {
    const { installDir, backupsDir } = await instalacao();

    const erro = await installOxide({
      installDir,
      backupsDir,
      onLine: () => undefined,
      release: OXIDE_DEFASADA,
      rustBuild: { buildId: '25083359', publishedAt: RUST_BUILD_25083359 },
    }).catch((error: unknown) => error);

    expect(erro).toBeInstanceOf(OxideBehindRustError);
    expect((erro as Error).message).toContain('2.0.7638');
    expect((erro as Error).message).toContain('25083359');
  });

  it('NÃO cria backup e NÃO toca em Managed\\', async () => {
    const { installDir, backupsDir } = await instalacao();

    await expect(
      installOxide({
        installDir,
        backupsDir,
        onLine: () => undefined,
        release: OXIDE_DEFASADA,
        rustBuild: { buildId: '25083359', publishedAt: RUST_BUILD_25083359 },
      }),
    ).rejects.toThrow(OxideBehindRustError);

    // `Backups\` nem chegou a existir: a conferência vem antes do
    // `mkdir`.
    await expect(readdir(backupsDir)).rejects.toThrow();

    await expect(readdir(join(installDir, 'RustDedicated_Data', 'Managed'))).resolves.toEqual([]);

    // E o plugin de quem opera continua onde estava.
    await expect(
      readFile(join(installDir, 'oxide', 'plugins', 'OrigemZUI.cs'), 'utf8'),
    ).resolves.toBe('// meu plugin');
  });

  // ####  A SAÍDA PARA QUANDO O OXIDE SOME POR DIAS  ####
  //
  // A recusa protege do caso comum. Ela não pode virar uma parede:
  // se o OxideMod atrasar uma semana, a decisão de subir assim
  // mesmo é de quem opera, não do agente.
  it('aceita quando quem chamou pediu allowBehind', async () => {
    const { installDir, backupsDir } = await instalacao();

    const erro = await installOxide({
      installDir,
      backupsDir,
      onLine: () => undefined,
      release: OXIDE_DEFASADA,
      rustBuild: { buildId: '25083359', publishedAt: RUST_BUILD_25083359 },
      allowBehind: true,
    }).catch((error: unknown) => error);

    // Passou da conferência — o que vem depois é o download, que
    // esta URL de mentira faz falhar. O que importa é que o erro
    // NÃO é mais o da recusa.
    expect(erro).not.toBeInstanceOf(OxideBehindRustError);
  });

  // Sem `rustBuild` não há o que conferir. É o `oxide-install` de
  // um servidor cujo manifest não dá para ler — raro, mas não pode
  // travar.
  it('não confere quando não sabe o build em disco', async () => {
    const { installDir, backupsDir } = await instalacao();

    const erro = await installOxide({
      installDir,
      backupsDir,
      onLine: () => undefined,
      release: OXIDE_DEFASADA,
    }).catch((error: unknown) => error);

    expect(erro).not.toBeInstanceOf(OxideBehindRustError);
  });

  it('recusa antes de existir instalação, com a frase de instalar primeiro', async () => {
    const raiz = await mkdtemp(join(tmpdir(), 'oxide-recusa-'));

    temporarios.push(raiz);

    await expect(
      installOxide({
        installDir: join(raiz, 'Servers', 'vazio'),
        backupsDir: join(raiz, 'Backups', 'vazio'),
        onLine: () => undefined,
        release: OXIDE_DEFASADA,
      }),
    ).rejects.toThrow(/instale o servidor primeiro/);
  });
});
