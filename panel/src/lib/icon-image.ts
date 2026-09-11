// ============================================================
//  icon-image.ts  -  a imagem que o admin escolheu vira um ícone
//  que cabe no caminho até o jogo.
//
//  ####  POR QUE REDIMENSIONAR, E NÃO PEDIR AO ADMIN  ####
//
//  O agente recusa ícone acima de ~33 KB (`MAX_ICON_BYTES`). O teto
//  nasceu do frame do WebRCON, quando o PNG ia numa linha só de
//  console; desde 11/09/2026 ele vai em pedaços pelo OrigemZImages,
//  e o teto ficou porque um ícone de slot é desenhado pequeno e
//  cada jogador baixa o arquivo inteiro.
//
//  Exigir que quem cadastra saiba disso — e abra um editor de
//  imagem para descobrir que 128×128 dá 43 KB e 96×96 dá 25 KB — é
//  transferir para ele um detalhe que não é problema dele. A arte
//  real do Troféu Bleik tem 1254×1254 e 2,9 MB: 89 vezes o teto.
//
//  ####  POR QUE NO NAVEGADOR, E NÃO NO AGENTE  ####
//
//  Porque o navegador já traz o redimensionador pronto: o <canvas>
//  decodifica o PNG, reduz e recodifica sem uma linha de
//  dependência nova. No agente o mesmo trabalho custaria `sharp`
//  (binário nativo, um por plataforma, num deploy que roda noutra
//  máquina) ou `jimp` (JS puro, mas pesado) — e ainda assim quem
//  cadastra só veria o resultado depois de enviar.
//
//  MEDIDO em 06/09/2026, no Chrome 152, com a arte real do troféu:
//
//    lado      drawImage do canvas   box filter premultiplicado
//    128×128         43.005 bytes          42.792 bytes
//    112×112         33.478 bytes          33.267 bytes
//     96×96          25.060 bytes          24.822 bytes
//     80×80          17.649 bytes          17.604 bytes
//
//  Os dois caminhos empatam em bytes, empatam na transparência
//  (nenhum pixel de borda escurecido em nenhum dos dois) e empatam
//  na leitura da medalha ampliada. Escrever reamostragem nossa não
//  compraria nada — então quem reduz é o canvas.
//
//  ####  O QUE ESTE MÓDULO NÃO COBRE  ####
//
//  Upload por script, direto na API: ele não passa pelo navegador,
//  e o agente continua recusando o que estoura o teto — com uma
//  frase que diz o tamanho recomendado. A validação do servidor é a
//  GARANTIA; esta redução é a conveniência.
//
//  E ele não decide se a imagem ficou bonita. Reduzir 1254 px para
//  96 px perde detalhe, e isso é inevitável: o ícone aparece num
//  slot de inventário de poucos pixels.
// ============================================================

/**
 * O lado do ícone, em pixels.
 *
 * ####  O MAIOR QUE CABE COM FOLGA  ####
 *
 * MEDIDO com a arte da medalha: 96×96 dá 25 KB e sobra um quarto do
 * teto; 112×112 dá 33.478 bytes e ESTOURA por 478. Ficar em 112
 * seria escolher o tamanho que só cabe nesta arte — a próxima, com
 * um pixel a mais de detalhe, seria recusada sem ninguém entender
 * por quê. O slot do inventário do Rust desenha o ícone bem menor
 * que 96 de qualquer jeito.
 */
export const ICON_SIZE = 96;

/**
 * O menor lado que ainda vale a pena tentar.
 *
 * Abaixo disso o ícone deixa de ser reconhecível no slot, e insistir
 * seria entregar um borrão em vez de dizer que a arte não serve.
 */
export const MIN_ICON_SIZE = 32;

/**
 * O teto que o agente aplica, repetido aqui de propósito.
 *
 * Duplicar a constante é o preço de o navegador não conhecer o
 * `MAX_ICON_BYTES` do core. Ela existe aqui para a redução saber
 * quando insistir — e o agente continua sendo quem RECUSA, porque
 * ele é quem grava.
 */
export const MAX_ICON_BYTES = 33_000;

/** Os oito bytes que abrem todo PNG. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** As medidas de uma imagem, do jeito que a tela precisa contá-las. */
export interface IconMeasure {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** O que saiu da redução, com o que dizer sobre ela. */
export interface IconResizeResult {
  /** O PNG pronto para subir. */
  readonly file: File;
  /** A imagem como o admin a escolheu. */
  readonly source: IconMeasure;
  /** O ícone como ele ficou. */
  readonly icon: IconMeasure;
  /** "2,9 MB → 96×96, 25 KB" — a frase que a tela mostra. */
  readonly summary: string;
}

/**
 * É PNG de verdade, e não só um arquivo com o nome certo?
 *
 * Mesma conferência que o agente faz, pelos mesmos oito bytes. Aqui
 * ela vem ANTES de qualquer processamento por dois motivos: um JPG
 * decodifica sem erro e viraria um PNG opaco — um quadrado no slot
 * do inventário, no lugar da medalha recortada —, e recusar antes de
 * decodificar 2,9 MB é o que faz a resposta ser imediata.
 */
export function isPngBytes(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * O lado do quadrado em que a arte vai ser desenhada.
 *
 * ####  ELE NUNCA AUMENTA  ####
 *
 * Uma arte de 64×64 esticada para 96×96 não ganha detalhe nenhum —
 * ela ganha peso, porque o PNG passa a gravar os pixels inventados
 * pela interpolação. Quem desenhou um ícone de 64 px desenhou para
 * ser visto assim.
 *
 * O lado sai do MAIOR dos dois lados da origem: é ele que decide se
 * a arte precisa encolher. Uma faixa de 200×50 encolhe (200 > 96) e
 * uma etiqueta de 50×20 não (50 < 96).
 */
export function planIconSize(source: { readonly width: number; readonly height: number }): number {
  const longest = Math.max(source.width, source.height);

  return Math.max(1, Math.min(ICON_SIZE, Math.floor(longest)));
}

/**
 * Os lados a tentar, do maior para o menor.
 *
 * ####  POR QUE UMA ESCADA, E NÃO UMA CONTA  ####
 *
 * Não há como saber o tamanho do PNG comprimido antes de
 * comprimi-lo: ele depende do CONTEÚDO, e não só das dimensões. Uma
 * arte chapada de 128 px pode caber onde uma fotográfica de 96 px
 * não cabe.
 *
 * Na prática o laço acerta na primeira volta — a medalha, que é a
 * arte mais pesada que este projeto tem, sai com um quarto do teto
 * sobrando. Os degraus seguintes existem para a arte que ninguém
 * previu.
 */
export function iconSizeLadder(source: {
  readonly width: number;
  readonly height: number;
}): readonly number[] {
  const first = planIconSize(source);

  // A arte que já nasceu menor que o menor degrau não tem escada:
  // descer mais a apagaria, e subir até 32 seria o upscale que esta
  // regra existe para não fazer.
  if (first <= MIN_ICON_SIZE) {
    return [first];
  }

  const ladder: number[] = [];

  for (let size = first; size > MIN_ICON_SIZE; size = Math.floor(size * 0.75)) {
    ladder.push(size);
  }

  // O último degrau é sempre o menor lado aceitável: sem ele, a
  // escada geométrica pararia em 40 e a arte que precisasse de 32
  // seria recusada com um degrau ainda por tentar.
  ladder.push(MIN_ICON_SIZE);

  return ladder;
}

/**
 * Bytes na unidade em que uma pessoa lê.
 *
 * ####  KB DECIMAL, E NÃO BINÁRIO  ####
 *
 * O teto é 33.000 bytes, um número redondo em base 10. Em KiB ele
 * viraria "32,2 KB", e a tela passaria a dizer um teto que não é o
 * que está escrito no código — a pior forma de confundir quem
 * comparar os dois.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000) {
    return `${String(Math.round(bytes))} bytes`;
  }

  if (bytes < 1_000_000) {
    return `${String(Math.round(bytes / 1_000))} KB`;
  }

  return `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

/**
 * O que a redução fez, numa linha.
 *
 * Ela é mostrada na tela, e não só num toast que some: quem cadastra
 * precisa saber que o arquivo que ele escolheu não é o que subiu.
 */
export function describeIconResize(source: IconMeasure, icon: IconMeasure): string {
  const from = `${formatBytes(source.bytes)} → ${String(icon.width)}×${String(icon.height)}, ${formatBytes(icon.bytes)}`;

  if (Math.max(source.width, source.height) > icon.width) {
    return from;
  }

  return `${from} (a arte já cabia; aumentar um PNG só engorda o arquivo)`;
}

/**
 * Encolhe a imagem até ela caber, e devolve um PNG.
 *
 * @throws Error com a frase pronta quando o arquivo não é PNG ou
 * quando nem o menor lado couber no teto.
 */
export async function toIconFile(source: File): Promise<IconResizeResult> {
  const head = new Uint8Array(await source.arrayBuffer());

  if (!isPngBytes(head)) {
    throw new Error(
      'Este arquivo não é um PNG. O ícone precisa ser PNG porque é o formato que guarda o fundo ' +
        'transparente — um JPG viraria um quadrado opaco no slot do inventário.',
    );
  }

  const bitmap = await createImageBitmap(source);
  const measured: IconMeasure = {
    width: bitmap.width,
    height: bitmap.height,
    bytes: source.size,
  };

  let smallest = 0;

  try {
    for (const size of iconSizeLadder(bitmap)) {
      const blob = await drawToPng(bitmap, size);

      smallest = blob.size;

      if (blob.size <= MAX_ICON_BYTES) {
        const icon: IconMeasure = { width: size, height: size, bytes: blob.size };

        return {
          file: new File([blob], toIconName(source.name), { type: 'image/png' }),
          source: measured,
          icon,
          summary: describeIconResize(measured, icon),
        };
      }
    }
  } finally {
    // O bitmap segura memória do navegador até ser fechado, e uma
    // tela de cadastro aberta a tarde inteira faria isso somar.
    bitmap.close();
  }

  throw new Error(
    `Não consegui reduzir esta imagem até ${formatBytes(MAX_ICON_BYTES)}, que é o que cabe na ` +
      `linha de console que leva o ícone até o jogo: mesmo em ${String(MIN_ICON_SIZE)}×` +
      `${String(MIN_ICON_SIZE)} ela ficou com ${formatBytes(smallest)}. Tente uma arte com menos ` +
      'detalhe, ou com fundo transparente em vez de uma fotografia.',
  );
}

/**
 * Desenha o bitmap num quadrado e devolve o PNG.
 *
 * ####  O ALFA NÃO PODE SER ACHATADO  ####
 *
 * A medalha é redonda sobre fundo transparente, e a arte inteira tem
 * alfa: MEDIDO no arquivo do dono, 448.695 pixels totalmente
 * transparentes e só 24 totalmente opacos. Um caminho que perdesse o
 * canal alfa entregaria um QUADRADO no slot do inventário.
 *
 * São três decisões que o mantêm, e as três estão neste corpo:
 *
 *   1. `getContext('2d')` SEM `{ alpha: false }` — com ele o canvas
 *      nasce preto opaco, e a sobra do desenho contido vira moldura;
 *   2. nenhum preenchimento de fundo. O canvas já nasce transparente,
 *      e um `fillRect` "para limpar" é exatamente o que achata;
 *   3. `toBlob` em `image/png`. JPEG não tem canal alfa: o mesmo
 *      desenho sairia composto contra preto, sem erro nenhum.
 *
 * O desenho é CONTIDO e centralizado: uma arte retangular esticada
 * para caber num quadrado fica deformada, e o slot é quadrado sempre.
 * Sobra transparente nas bordas, que é o que o PNG comprime melhor.
 */
async function drawToPng(bitmap: ImageBitmap, size: number): Promise<Blob> {
  const canvas = document.createElement('canvas');

  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');

  if (context === null) {
    throw new Error('O navegador não permitiu desenhar a imagem.');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const scale = Math.min(size / bitmap.width, size / bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;

  context.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('O navegador não conseguiu gerar o PNG.'));
        return;
      }

      resolve(blob);
    }, 'image/png');
  });
}

/**
 * O nome do arquivo, dentro da régua do agente.
 *
 * O nome viaja num comando de console do jogo, onde o espaço separa
 * argumentos — daí a troca por sublinhado. E a extensão é sempre
 * `.png` porque é isso que sai do canvas, qualquer que tenha sido o
 * formato de entrada.
 */
export function toIconName(original: string): string {
  const base = original
    .replace(/\.[^.]+$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);

  return `${base === '' ? 'icone' : base}.png`;
}
