// ============================================================
//  csharp-source.ts  -  o texto do .cs, do jeito que dá para
//  procurar coisa dentro dele.
//
//  ####  ISTO NASCEU DE UM PLUGIN QUE SUMIU DA TELA  ####
//
//  O `OrigemZQueue.cs` abre com 104 linhas de comentário. Quem
//  procurava `using` nos primeiros 4 KB do arquivo só via a prosa
//  do cabeçalho, concluía "isto não é C#" e o plugin não entrava
//  no acervo — sem erro na tela, porque a varredura da pasta engole
//  o que não consegue ler. O sintoma era um plugin a menos na
//  lista, e nada apontando para o motivo.
//
//  Qualquer NÚMERO ali seria o próximo bug: o estilo desta base é
//  justamente o cabeçalho que explica por que o arquivo existe, e
//  ele cresce. Por isso aqui não há janela — há o arquivo inteiro,
//  sem os comentários.
//
//  ------------------------------------------------------------
//  ####  TIRAR O COMENTÁRIO É O QUE TORNA A BUSCA HONESTA  ####
//
//  E não é só pelo tamanho. Os cabeçalhos daqui CITAM código como
//  exemplo — o próprio plugin-metadata.ts mostra um
//  `[Info("Origem Z Player", "OrigemZ", "1.2.3")]` em prosa. Ler o
//  arquivo inteiro sem descartar comentário faria a tela exibir o
//  exemplo do cabeçalho como se fosse a versão do plugin, que é o
//  erro pior: o ausente aparece como travessão, o errado ninguém
//  confere.
//
//  Isto NÃO é um parser de C#. É uma varredura que sabe onde um
//  comentário começa e termina — o suficiente para não confundir
//  `// "aspas"` com string, nem `"http://x"` com comentário.
// ============================================================

/** BOM de UTF-16. Windows os produz mais do que se imagina. */
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

/**
 * Os bytes viram texto, na codificação em que foram gravados.
 *
 * ####  UTF-16 É C# VÁLIDO, E O COMPILADOR ACEITA  ####
 *
 * Um `.cs` salvo pelo Bloco de Notas como "Unicode", ou gerado por
 * um `>` do PowerShell antigo, sai em UTF-16 com BOM. Lido como
 * UTF-8, ele vira lixo entremeado de bytes zero: nenhuma busca
 * casa, o metadado inteiro vira `null` e a trava de conteúdo o
 * recusa como se fosse um zip. O arquivo estava certo o tempo
 * todo — quem estava errado era a leitura.
 */
export function decodeSource(content: Buffer): string {
  const head = content.subarray(0, 2);

  if (head.equals(BOM_UTF16LE)) {
    return content.subarray(2).toString('utf16le');
  }

  if (head.equals(BOM_UTF16BE) && content.length % 2 === 0) {
    // Node não decodifica UTF-16BE: a troca de bytes o transforma
    // no LE que ele conhece. A cópia é obrigatória — `swap16`
    // altera o buffer no lugar, e este é o mesmo que será gravado
    // em disco byte a byte.
    return Buffer.from(content.subarray(2)).swap16().toString('utf16le');
  }

  const text = content.toString('utf8');

  // O BOM de UTF-8 sobrevive à decodificação como U+FEFF e ficaria
  // grudado no primeiro token do arquivo.
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

/** Até o fim da linha — ou do arquivo, na última. */
function lineEnd(source: string, from: number): number {
  const found = source.indexOf('\n', from);

  return found === -1 ? source.length : found;
}

/**
 * O trecho vira espaço em branco, e não some.
 *
 * Trocar em vez de remover preserva posição e número de linha: o
 * que uma busca achar no resultado está no mesmo lugar do arquivo
 * de verdade, e é isso que permite apontar a linha de um erro para
 * quem vai abrir o `.cs` num editor.
 */
function blank(source: string, from: number, to: number): string {
  return source.slice(from, to).replace(/[^\n]/g, ' ');
}

/**
 * O fim de uma string `"..."` ou de um char `'x'`.
 *
 * Para na quebra de linha de propósito: string não fechada é código
 * quebrado, e engolir o resto do arquivo por causa de uma aspa
 * solta apagaria tudo o que vem depois dela.
 */
function skipQuoted(source: string, from: number, quote: string): number {
  let i = from;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (ch === quote) {
      return i + 1;
    }

    if (ch === '\n') {
      return i;
    }

    i++;
  }

  return i;
}

/**
 * O fim de uma string verbatim `@"..."`.
 *
 * Ali a contrabarra não escapa nada — é o que faz `@"C:\Servers\"`
 * funcionar — e a aspa se escapa dobrando. Ela atravessa linhas, e
 * é dentro dela que mora o `//` que não é comentário.
 */
function skipVerbatim(source: string, from: number): number {
  let i = from;

  while (i < source.length) {
    if (source[i] === '"') {
      if (source[i + 1] === '"') {
        i += 2;
        continue;
      }

      return i + 1;
    }

    i++;
  }

  return i;
}

/**
 * O mesmo arquivo, com os comentários virados espaço.
 *
 * O que sobra é só o que o compilador enxerga — e é onde procurar
 * `class`, `[Info(...)]` ou um `[PluginReference]` significa achar
 * a declaração, nunca a frase que fala sobre ela.
 */
export function stripComments(source: string): string {
  const parts: string[] = [];
  let start = 0;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const end = lineEnd(source, i);

      parts.push(source.slice(start, i), blank(source, i, end));
      start = end;
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      // Bloco não fechado: o resto do arquivo é comentário mesmo —
      // é assim que o compilador o lê.
      const end = close === -1 ? source.length : close + 2;

      parts.push(source.slice(start, i), blank(source, i, end));
      start = end;
      i = end;
      continue;
    }

    // As strings são puladas inteiras: o que estiver dentro delas
    // não abre comentário. `$"..."` cai no caso da aspa comum, que
    // é o bastante — o que houver entre chaves não interessa a
    // ninguém que procura uma declaração.
    if (ch === '@' && next === '"') {
      i = skipVerbatim(source, i + 2);
      continue;
    }

    if (ch === '$' && next === '@' && source[i + 2] === '"') {
      i = skipVerbatim(source, i + 3);
      continue;
    }

    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i + 1, ch);
      continue;
    }

    i++;
  }

  parts.push(source.slice(start));

  return parts.join('');
}
