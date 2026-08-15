// ============================================================
//  build-item-icons.mjs  -  o pacote de ícones dos itens.
//
//  Lê os PNGs 512x512 que o CLIENTE do Rust guarda em
//  `Bundles/items` e cospe WebP de 64x64 em `public/item-icons/`,
//  um por shortname.
//
//      node scripts/build-item-icons.mjs "H:\\SteamLibrary\\steamapps\\common\\Rust"
//      RUST_CLIENT_DIR=... node scripts/build-item-icons.mjs
//
//  ------------------------------------------------------------
//  ####  POR QUE ISTO É UM PASSO OFFLINE, E NÃO UMA ROTA  ####
//
//  Os ícones só existem na instalação do CLIENTE. O servidor
//  dedicado tem os `.json` dos 1243 itens em `Bundles/items` e
//  NENHUM `.png` — conferido nesta máquina. Ou seja: uma rota do
//  agente que lesse o ícone do disco funcionaria aqui, onde o
//  jogo está instalado, e devolveria 404 para tudo no VPS.
//
//  Por isso o pacote é gerado uma vez, versionado junto do
//  painel e viaja com o build. Roda de novo quando a Facepunch
//  mexer nos ícones — o mesmo gatilho que faz o agente remontar o
//  catálogo (mudança de protocolo).
//
//  ####  POR QUE 64x64 EM WebP  ####
//
//  O original é 512x512 e pesa ~180 KB. Cento e poucas linhas de
//  tabela nesse tamanho são ~20 MB de imagem para desenhar um
//  quadradinho de 28 px. Em WebP 64x64 cada ícone fica em ~1,7 KB
//  — o pacote inteiro dá ~2 MB, e 64 px ainda é o dobro do que a
//  maior ocorrência na tela usa (bom para telas retina).
//
//  ####  DEPENDE DO ffmpeg NO PATH  ####
//
//  De propósito. O redimensionador natural aqui seria o `sharp`,
//  que o pnpm-workspace.yaml BLOQUEIA por ser binário nativo
//  pesado que o painel não usa em mais nada. Trocar essa decisão
//  por um script que roda uma vez por wipe seria caro pelo lado
//  errado: o ffmpeg é ferramenta de máquina de desenvolvimento,
//  não dependência do projeto, e quem nunca rodar este script não
//  precisa dele.
// ============================================================

import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(HERE, '..');
const OUT_DIR = join(PANEL_DIR, 'public', 'item-icons');

/** Lado do ícone gerado, em pixels. */
const ICON_SIZE = 64;

/**
 * Qualidade do WebP (0–100).
 *
 * 80 é o joelho da curva para estes ícones: acima disso o arquivo
 * cresce sem que a diferença apareça em 28 px de tela; abaixo, o
 * contorno escuro dos ícones começa a sujar.
 */
const WEBP_QUALITY = 80;

/**
 * Quantos ffmpeg ao mesmo tempo.
 *
 * Cada um é um processo curto e ligado a CPU. Oito satura uma
 * máquina comum sem deixá-la de joelhos — e o script todo cabe em
 * ~1 minuto para os ~1250 itens.
 */
const CONCURRENCY = 8;

// ------------------------------------------------------------
//  Onde o jogo está
// ------------------------------------------------------------

/**
 * Caminhos onde o cliente do Rust costuma estar.
 *
 * São só um atalho para o caso comum: o argumento e a env var
 * ganham de qualquer palpite, e sem nenhum dos três o script
 * morre dizendo o que fazer em vez de adivinhar.
 */
const COMMON_CLIENT_DIRS = [
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Rust',
  'D:\\SteamLibrary\\steamapps\\common\\Rust',
  'E:\\SteamLibrary\\steamapps\\common\\Rust',
  'F:\\SteamLibrary\\steamapps\\common\\Rust',
  'H:\\SteamLibrary\\steamapps\\common\\Rust',
];

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Acha `Bundles/items` do cliente.
 *
 * Aceita tanto a raiz do jogo quanto a pasta de itens direto —
 * quem tem o caminho na mão raramente lembra qual dos dois o
 * script quer.
 */
async function resolveItemsDir() {
  const given = process.argv[2] ?? process.env.RUST_CLIENT_DIR ?? null;

  const candidates =
    given === null
      ? COMMON_CLIENT_DIRS.map((dir) => join(dir, 'Bundles', 'items'))
      : [join(given, 'Bundles', 'items'), given];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }

  const tried = candidates.map((path) => `  ${path}`).join('\n');
  throw new Error(
    `não achei a pasta Bundles/items do cliente do Rust. Tentei:\n${tried}\n\n` +
      'Passe o caminho da instalação do jogo:\n' +
      '  node scripts/build-item-icons.mjs "H:\\SteamLibrary\\steamapps\\common\\Rust"',
  );
}

// ------------------------------------------------------------
//  ffmpeg
// ------------------------------------------------------------

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} saiu com código ${String(code)}`));
    });
  });
}

async function assertFfmpeg() {
  try {
    await run('ffmpeg', ['-version']);
  } catch {
    throw new Error(
      'ffmpeg não está no PATH. Instale (https://ffmpeg.org/download.html ou ' +
        '`winget install Gyan.FFmpeg`) e rode de novo.',
    );
  }
}

/**
 * Um PNG 512x512 vira um WebP 64x64 com o alpha intacto.
 *
 * O `force_original_aspect_ratio` + `pad` existe para o punhado
 * de ícones que não é exatamente quadrado (bandage.png é
 * 514x514): esticar para 64x64 na marra os deformaria de leve, e
 * deformação em ícone pequeno é o tipo de coisa que ninguém sabe
 * nomear mas todo mundo acha feia. O padding é transparente, e é
 * por isso que ele vem com `color=#00000000` em vez de preto.
 */
function convert(source, target) {
  return run('ffmpeg', [
    '-y',
    '-loglevel', 'error',
    '-i', source,
    '-vf',
    `scale=${String(ICON_SIZE)}:${String(ICON_SIZE)}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${String(ICON_SIZE)}:${String(ICON_SIZE)}:(ow-iw)/2:(oh-ih)/2:color=#00000000`,
    '-c:v', 'libwebp',
    '-q:v', String(WEBP_QUALITY),
    '-compression_level', '6',
    target,
  ]);
}

/** Roda `worker` sobre `items` com no máximo `limit` em voo. */
async function mapWithLimit(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });

  await Promise.all(runners);
}

// ------------------------------------------------------------
//  Main
// ------------------------------------------------------------

async function main() {
  await assertFfmpeg();

  const itemsDir = await resolveItemsDir();
  const sources = (await readdir(itemsDir)).filter((name) => name.endsWith('.png'));

  if (sources.length === 0) {
    throw new Error(`${itemsDir} não tem nenhum .png — é a pasta certa?`);
  }

  console.log(`fonte:  ${itemsDir}`);
  console.log(`saída:  ${OUT_DIR}`);
  console.log(`itens:  ${String(sources.length)} PNGs\n`);

  // Apaga antes de gerar: sem isso, um item removido pelo jogo
  // continuaria com ícone no pacote para sempre, e o painel
  // desenharia uma arma que não existe mais.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  let done = 0;
  const failures = [];

  await mapWithLimit(sources, CONCURRENCY, async (name) => {
    const shortname = name.slice(0, -'.png'.length);
    try {
      await convert(join(itemsDir, name), join(OUT_DIR, `${shortname}.webp`));
    } catch (caught) {
      failures.push({ shortname, reason: caught instanceof Error ? caught.message : String(caught) });
    }

    done += 1;
    if (done % 100 === 0 || done === sources.length) {
      process.stdout.write(`\r  ${String(done)}/${String(sources.length)}`);
    }
  });

  process.stdout.write('\n');

  const written = (await readdir(OUT_DIR)).filter((name) => name.endsWith('.webp'));
  let bytes = 0;
  for (const name of written) bytes += (await stat(join(OUT_DIR, name))).size;

  // Um README ao lado do pacote: a pasta é grande, gerada, e a
  // primeira pergunta de quem a encontra no git é "quem põe isto
  // aqui?".
  await writeFile(
    join(OUT_DIR, 'README.md'),
    [
      '# Ícones dos itens',
      '',
      'Pasta **gerada**. Não edite à mão.',
      '',
      '```',
      'node scripts/build-item-icons.mjs "<pasta do cliente do Rust>"',
      '```',
      '',
      `WebP ${String(ICON_SIZE)}x${String(ICON_SIZE)}, um por shortname, extraídos do`,
      '`Bundles/items` da instalação do **cliente** — o servidor dedicado não',
      'tem os PNGs. Ver o cabeçalho de `scripts/build-item-icons.mjs`.',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`\n${String(written.length)} ícones, ${(bytes / 1024 / 1024).toFixed(1)} MB`);

  if (failures.length > 0) {
    console.warn(`\n${String(failures.length)} falharam:`);
    for (const failure of failures.slice(0, 10)) {
      console.warn(`  ${failure.shortname}: ${failure.reason}`);
    }
  }
}

main().catch((caught) => {
  console.error(`\n${caught instanceof Error ? caught.message : String(caught)}`);
  process.exitCode = 1;
});
