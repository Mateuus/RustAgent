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
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { extractZip } from '../util/zip.js';

const RELEASE_API = 'https://api.github.com/repos/OxideMod/Oxide.Rust/releases/latest';
const FALLBACK_ZIP =
  'https://github.com/OxideMod/Oxide.Rust/releases/latest/download/Oxide.Rust.zip';

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

  const { tag, archive } = await downloadRelease(options);

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

  options.onLine('[Oxide] instalado. Os plugins carregam no próximo start do servidor.');

  return { tag, backup };
}

/**
 * A última release, pela API do GitHub — e a URL direta como
 * plano B.
 *
 * A API dá o número da versão, que é o que aparece no log e no
 * painel. Ela também é o que estoura o limite de 60 requisições
 * por hora por IP quando alguém reinstala muito — daí o plano B,
 * que não passa pela API e sempre entrega a mais recente.
 */
async function downloadRelease(
  options: InstallOxideOptions,
): Promise<{ tag: string; archive: Buffer }> {
  let assetUrl = FALLBACK_ZIP;
  let tag = 'latest';

  try {
    const response = await fetch(RELEASE_API, {
      signal: options.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RustAgent' },
    });

    if (response.ok) {
      const release = (await response.json()) as {
        tag_name?: string;
        assets?: { name?: string; browser_download_url?: string }[];
      };

      const asset = release.assets?.find((candidate) => candidate.name === 'Oxide.Rust.zip');

      if (asset?.browser_download_url !== undefined) {
        assetUrl = asset.browser_download_url;
        tag = release.tag_name ?? 'latest';
      }
    } else {
      options.onLine(
        `[Oxide] a API do GitHub respondeu ${String(response.status)} — usando a URL direta.`,
      );
    }
  } catch (error) {
    options.onLine(
      '[Oxide] não consegui consultar a API do GitHub ' +
        `(${error instanceof Error ? error.message : String(error)}) — usando a URL direta.`,
    );
  }

  try {
    const response = await fetch(assetUrl, {
      signal: options.signal,
      headers: { 'User-Agent': 'RustAgent' },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }

    return { tag, archive: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    throw new Error(
      `não consegui baixar o Oxide de ${assetUrl} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'Confira a conexão desta máquina com a internet.',
    );
  }
}
