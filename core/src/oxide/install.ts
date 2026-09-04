// ============================================================
//  install.ts  -  instalar/atualizar o Oxide num servidor.
//
//  ####  POR QUE ISTO É PARTE DE TODA INSTALAÇÃO  ####
//
//  Todo `app_update` do SteamCMD SOBRESCREVE os assemblies do
//  Oxide em `RustDedicated_Data\Managed`. Se reinstalar o Oxide
//  fosse um passo separado que alguém precisa lembrar, o sintoma
//  de esquecer seria um servidor que sobe sem plugin nenhum — e
//  ninguém liga isso à atualização de ontem.
//
//  Por isso `ops/service.ts` chama esta função no fim de toda
//  instalação e de toda atualização.
//
//  ####  O QUE O ZIP TEM, E O QUE ELE NÃO TEM  ####
//
//  Ele traz `RustDedicated_Data\Managed\*` — os assemblies do
//  loader — e mais nada. A pasta `oxide\` (plugins, config, data,
//  lang) NÃO vem no zip: quem a cria é o próprio Oxide, no
//  primeiro boot do servidor.
//
//  Ou seja: a ausência de `oxide\` logo depois de instalar é o
//  estado normal, nunca um erro. Nós a criamos mesmo assim, para
//  dar para largar um plugin em `oxide\plugins` ANTES de subir o
//  servidor pela primeira vez.
// ============================================================

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { extractZip } from '../util/zip.js';
import {
  fetchLatestOxideRelease,
  OxideBehindRustError,
  oxideServesRustBuild,
  type OxideRelease,
} from './compat.js';

/**
 * Os quatro assemblies que provam que a instalação funcionou.
 *
 * É a ÚNICA verificação que vale — conferir a pasta `oxide\` daria
 * falso negativo (ver o cabeçalho) e conferir o tamanho do zip não
 * diria nada sobre a extração.
 */
const REQUIRED_ASSEMBLIES = [
  'Oxide.Core.dll',
  'Oxide.Rust.dll',
  'Oxide.CSharp.dll',
  'Oxide.Common.dll',
];

/** As pastas que o Oxide usa, criadas antecipadamente. */
const OXIDE_DIRS = ['plugins', 'config', 'data', 'lang', 'logs'];

/**
 * O carimbo da versão instalada, dentro de `oxide\`.
 *
 * ####  POR QUE NÃO PERGUNTAR AO SERVIDOR  ####
 *
 * A versão do Oxide vem do console do jogo — e o console só
 * responde com o servidor NO AR. Só que atualizar o Oxide exige
 * o servidor PARADO. Nas duas pontas o painel ficava sem saber o
 * que já estava em disco justamente na hora de decidir trocar.
 *
 * O ponto seguro para gravar isso é aqui, onde a release acabou
 * de ser baixada e o número é conhecido de primeira mão.
 */
const VERSION_STAMP = '.rustagent-oxide.json';

/** O que o carimbo guarda. */
export interface InstalledOxide {
  readonly tag: string;
  readonly installedAt: string;
  /**
   * Quando o OxideMod publicou a release, e o build do Rust que
   * estava em disco na hora.
   *
   * São o que responde "esta instalação era compatível?" DEPOIS,
   * olhando só o disco — sem isso, um servidor que não sobe
   * obriga a reconstruir a linha do tempo pelo log das operações,
   * que guarda só as 20 últimas.
   *
   * Opcionais porque carimbo gravado por versão anterior do
   * agente não os tem.
   */
  readonly publishedAt?: string | null;
  readonly rustBuildId?: string | null;
}

/**
 * A versão que ESTE agente instalou, lida do disco.
 *
 * `null` quando o carimbo não existe: ou o Oxide não está
 * instalado, ou entrou por fora (uma cópia à mão, um zip baixado
 * direto). Nos dois casos a tela diz que não sabe, em vez de
 * inventar um número.
 */
export async function readInstalledOxide(installDir: string): Promise<InstalledOxide | null> {
  const path = join(installDir, 'oxide', VERSION_STAMP);

  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const stamp = parsed as Partial<InstalledOxide>;

    if (typeof stamp.tag !== 'string' || typeof stamp.installedAt !== 'string') {
      return null;
    }

    return {
      tag: stamp.tag,
      installedAt: stamp.installedAt,
      publishedAt: typeof stamp.publishedAt === 'string' ? stamp.publishedAt : null,
      rustBuildId: typeof stamp.rustBuildId === 'string' ? stamp.rustBuildId : null,
    };
  } catch {
    return null;
  }
}

/**
 * O `oxide.config.json` daquele servidor, como está em disco.
 *
 * ####  ELE É DO FRAMEWORK, E NÃO DE UM PLUGIN  ####
 *
 * Mora em `Servers\<id>\oxide\oxide.config.json` — um nível ACIMA
 * de `oxide\config\`, que é onde ficam os `.json` de cada plugin
 * (ver oxide/plugin-config.ts). Ali dentro estão o prefixo dos
 * comandos de chat, os grupos padrão (`default`, `admin`), o
 * compilador e o console do Oxide.
 *
 * Só leitura, e de propósito: o Oxide o lê no START. Gravar com o
 * servidor no ar não teria efeito até o próximo boot, e a tela
 * estaria dizendo que mudou algo que não mudou — a mesma armadilha
 * do `users.cfg`.
 *
 * `text: null` = o arquivo não existe, que é o estado de um
 * servidor que ainda não subiu depois de instalar o Oxide.
 */
export async function readOxideFrameworkConfig(installDir: string): Promise<{
  readonly path: string;
  readonly text: string | null;
  readonly modifiedAt: string | null;
}> {
  const path = join(installDir, 'oxide', 'oxide.config.json');

  try {
    const [text, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);

    return { path, text, modifiedAt: new Date(stats.mtimeMs).toISOString() };
  } catch {
    return { path, text: null, modifiedAt: null };
  }
}

export interface InstallOxideOptions {
  /** `Servers\<id>\`. */
  readonly installDir: string;
  /** `Backups\<id>\`. */
  readonly backupsDir: string;
  readonly onLine: (line: string) => void;
  readonly signal?: AbortSignal;
  /** Carimbo do backup. Injetável para o teste não depender do relógio. */
  readonly now?: () => Date;
  /**
   * O build do Rust que está em disco, para conferir se a release
   * do Oxide o conhece. Ver compat.ts.
   *
   * Omitido = sem conferência. É o que faz o `oxide-install`
   * avulso continuar funcionando num servidor cujo manifest não dá
   * para ler, e o que mantém os testes de extração longe da rede.
   */
  readonly rustBuild?: {
    readonly buildId: string;
    /** `timeupdated` do branch. Epoch ms. */
    readonly publishedAt: number | null;
  };
  /**
   * Aplica a release mesmo defasada.
   *
   * Existe para o caso em que o OxideMod some por dias e o dono
   * decide subir assim mesmo — e para nada mais. O padrão recusa.
   */
  readonly allowBehind?: boolean;
  /** A release já escolhida, quando quem chama acabou de consultá-la. */
  readonly release?: OxideRelease;
}

export interface InstallOxideResult {
  readonly tag: string;
  /** Para onde o `oxide\` anterior foi copiado, se havia um. */
  readonly backup: string | null;
}

/**
 * Baixa a última release do Oxide e aplica por cima da instalação.
 *
 * @throws quando o jogo não está em disco, quando o download
 * falha, ou quando os assemblies não aparecem depois de extrair.
 * Todas com a frase pronta para a tela.
 */
export async function installOxide(options: InstallOxideOptions): Promise<InstallOxideResult> {
  const managedDir = join(options.installDir, 'RustDedicated_Data', 'Managed');

  if (!existsSync(managedDir)) {
    throw new Error(
      `não encontrei ${managedDir}. O Oxide entra POR CIMA de uma instalação do jogo — ` +
        'instale o servidor primeiro.',
    );
  }

  // ####  A CONFERÊNCIA VEM ANTES DE TUDO  ####
  //
  // Antes do backup e antes dos 13 MB de download, porque uma
  // release defasada não deve nem chegar perto do disco. E porque
  // desistir aqui deixa a instalação EXATAMENTE como estava — o
  // `oxide\` intacto, sem um backup órfão em `Backups\` para
  // alguém decifrar depois.
  const release = options.release ?? (await fetchLatestOxideRelease(options));

  if (
    options.rustBuild !== undefined &&
    options.allowBehind !== true &&
    !oxideServesRustBuild(release.publishedAt, options.rustBuild.publishedAt)
  ) {
    throw new OxideBehindRustError({
      tag: release.tag,
      oxidePublishedAt: release.publishedAt,
      rustBuildId: options.rustBuild.buildId,
      rustBuildPublishedAt: options.rustBuild.publishedAt,
    });
  }

  const oxideDir = join(options.installDir, 'oxide');
  let backup: string | null = null;

  // O backup é do `oxide\`, e não dos assemblies: o que dói
  // perder são os plugins, as configurações e os dados deles. Os
  // assemblies vêm do zip de novo em trinta segundos.
  if (existsSync(oxideDir)) {
    const stamp = (options.now?.() ?? new Date())
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);

    backup = join(options.backupsDir, `oxide-${stamp}`);

    options.onLine(`[Oxide] backup de oxide\\ -> ${backup}`);
    await mkdir(options.backupsDir, { recursive: true });
    await cp(oxideDir, backup, { recursive: true });
  }

  const archive = await downloadArchive(release, options);
  const tag = release.tag;

  options.onLine(`[Oxide] release ${tag} baixada (${String(archive.length)} bytes) — extraindo...`);

  // Extrai direto por cima: o zip já vem com a árvore
  // `RustDedicated_Data\Managed\` na raiz, então o caminho de cada
  // entrada cai exatamente onde deve.
  const result = await extractZip(archive, options.installDir);

  options.onLine(`[Oxide] ${String(result.files)} arquivos aplicados`);

  const missing = REQUIRED_ASSEMBLIES.filter((assembly) => !existsSync(join(managedDir, assembly)));

  if (missing.length > 0) {
    throw new Error(
      `o Oxide foi extraído, mas ${missing.join(', ')} não apareceu em ` +
        'RustDedicated_Data\\Managed. A instalação NÃO está boa — o servidor subiria sem ' +
        'plugin nenhum. Rode a operação de novo.',
    );
  }

  for (const dir of OXIDE_DIRS) {
    await mkdir(join(oxideDir, dir), { recursive: true });
  }

  // O carimbo é o ÚLTIMO passo: gravado antes das conferências
  // acima, ele diria "2.0.7638 instalado" sobre uma instalação que
  // não ficou de pé.
  const stamp: InstalledOxide = {
    tag,
    installedAt: (options.now?.() ?? new Date()).toISOString(),
    publishedAt: release.publishedAt === null ? null : new Date(release.publishedAt).toISOString(),
    rustBuildId: options.rustBuild?.buildId ?? null,
  };

  try {
    await writeFile(join(oxideDir, VERSION_STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
  } catch (error) {
    // Não falha a instalação por causa do carimbo: o Oxide está
    // aplicado e funcionando. O painel só vai dizer que não sabe
    // a versão.
    options.onLine(
      `[Oxide] instalado, mas não consegui gravar o carimbo da versão: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  options.onLine('[Oxide] instalado. Os plugins carregam no próximo start do servidor.');

  return { tag, backup };
}

/**
 * Baixa o `Oxide.Rust.zip` da release já escolhida.
 *
 * Escolher qual release é assunto de `compat.ts`, e a separação
 * não é estética: a escolha precisa acontecer ANTES do backup e
 * do download, para que uma release defasada não deixe rastro em
 * disco.
 */
async function downloadArchive(
  release: OxideRelease,
  options: InstallOxideOptions,
): Promise<Buffer> {
  try {
    const response = await fetch(release.zipUrl, {
      signal: options.signal,
      headers: { 'User-Agent': 'RustAgent' },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(
      `não consegui baixar o Oxide de ${release.zipUrl} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'Confira a conexão desta máquina com a internet.',
      { cause: error },
    );
  }
}
