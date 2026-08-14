// ============================================================
//  vdf.ts  -  o formato de texto da Valve, lido do jeito burro.
//
//  Dois arquivos que o agente precisa ler falam VDF (também
//  chamado de KeyValues):
//
//    Server\steamapps\appmanifest_258550.acf   o que ESTÁ instalado
//    a saída de `steamcmd +app_info_print`     o que EXISTE na Steam
//
//  Os dois têm a mesma forma:
//
//      "AppState"
//      {
//          "buildid"   "24253458"
//          "InstalledDepots"
//          {
//              "258551"  { "manifest" "23216861..." }
//          }
//      }
//
//  ------------------------------------------------------------
//  ####  ISTO NÃO É UM PARSER DE VDF COMPLETO  ####
//
//  O VDF de verdade tem `#include`, macros de plataforma e
//  condicionais (`[$WIN32]`). Nada disso aparece nos dois arquivos
//  acima, e implementar o que não se lê é criar caminho não
//  testado.
//
//  O que este parser entende: strings entre aspas (com `\"` e
//  `\\`), blocos entre chaves, e nada mais. Qualquer outra coisa
//  fora de aspas é IGNORADA — e essa tolerância é essencial, não
//  preguiça: a saída do SteamCMD vem embrulhada em linhas de log
//  ("Connecting anonymously to Steam Public...OK") que não fazem
//  parte do documento.
//
//  ------------------------------------------------------------
//  ####  TUDO É STRING, DE PROPÓSITO  ####
//
//  `buildid` é um número que já passou de 24 milhões e cresce a
//  cada atualização da Facepunch. Ele é COMPARADO por igualdade e
//  nunca somado — transformar em número só abriria a porta para um
//  dia estourar o inteiro seguro do JavaScript sem ninguém ver.
// ============================================================

/** Um nó do documento: ou um valor, ou um bloco. */
export type VdfNode = { readonly [key: string]: string | VdfNode };

/**
 * Interpreta um documento VDF inteiro.
 *
 * Nunca lança: entrada malformada produz o que deu para ler. Quem
 * chama sempre trata "a chave que eu queria não veio" — e essa é
 * a mesma resposta para um arquivo truncado, um arquivo vazio e
 * um arquivo que a Valve mudou de formato.
 */
export function parseVdf(text: string): VdfNode {
  const reader = new Reader(text);
  return reader.readBlock();
}

/**
 * Recorta o bloco `"<chave>" { ... }` de dentro de um texto maior.
 *
 * É o que separa o documento do RUÍDO: a saída do SteamCMD tem
 * dezenas de linhas de log antes e depois do bloco do app, e
 * algumas delas contêm chaves e aspas.
 *
 * `null` quando a chave não aparece ou o bloco não fecha.
 */
export function extractBlock(text: string, key: string): string | null {
  const needle = `"${key}"`;
  const start = text.indexOf(needle);

  if (start < 0) {
    return null;
  }

  const open = text.indexOf('{', start + needle.length);

  if (open < 0) {
    return null;
  }

  // Contagem de chaves IGNORANDO o que está dentro de aspas: um
  // valor como "path" "C:\{x}" derrubaria uma contagem ingênua.
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = open; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        return text.slice(open, index + 1);
      }
    }
  }

  return null;
}

/**
 * Desce por um caminho de chaves e devolve o VALOR de texto do
 * fim.
 *
 * `null` se o caminho não existe ou se o fim é um bloco em vez de
 * um valor. A busca é insensível a maiúsculas porque a Valve não
 * é consistente: `buildid` no app_info e `buildid` no manifest,
 * mas `LastUpdated` e `lastupdated` aparecem dos dois jeitos em
 * arquivos diferentes.
 */
export function vdfString(root: VdfNode, ...path: readonly string[]): string | null {
  const found = vdfNode(root, ...path);
  return typeof found === 'string' ? found : null;
}

/** Igual ao acima, mas devolve o bloco. */
export function vdfBlock(root: VdfNode, ...path: readonly string[]): VdfNode | null {
  const found = vdfNode(root, ...path);
  return found !== null && typeof found === 'object' ? found : null;
}

function vdfNode(root: VdfNode, ...path: readonly string[]): string | VdfNode | null {
  let current: string | VdfNode = root;

  for (const segment of path) {
    if (typeof current === 'string') {
      return null;
    }

    const key: string | undefined = Object.keys(current).find(
      (candidate) => candidate.toLowerCase() === segment.toLowerCase(),
    );

    if (key === undefined) {
      return null;
    }

    // `noUncheckedIndexedAccess`: a chave veio do próprio
    // Object.keys, então o undefined é impossível — mas o
    // compilador não sabe, e um `!` seria mentir onde ele acerta.
    //
    // A anotação explícita também é obrigatória: sem ela o
    // compilador tenta inferir o tipo de `next` a partir de uma
    // expressão que depende do próprio `current`, e desiste
    // (TS7022).
    const next: string | VdfNode | undefined = current[key];

    if (next === undefined) {
      return null;
    }

    current = next;
  }

  return current;
}

// ------------------------------------------------------------
//  O leitor
// ------------------------------------------------------------

class Reader {
  readonly #text: string;
  #index = 0;

  constructor(text: string) {
    this.#text = text;
  }

  /**
   * Lê pares chave/valor até o fim do texto ou até a chave de
   * fechamento do bloco corrente — os dois encerram a leitura, e
   * o chamador de fora simplesmente nunca encontra a segunda.
   */
  readBlock(): VdfNode {
    const result: Record<string, string | VdfNode> = {};

    for (;;) {
      const key = this.#readToken();

      if (key === null) {
        return result;
      }

      if (key.kind === 'close') {
        // Fechamento sem abertura correspondente: documento
        // torto. Devolver o que já foi lido é melhor que jogar
        // fora — a chave que interessa costuma vir antes.
        return result;
      }

      if (key.kind === 'open') {
        // ####  UM `{` ONDE SE ESPERAVA UMA CHAVE  ####
        //
        // É o que `extractBlock` produz: ele devolve o bloco COM
        // as chaves em volta, e interpretá-lo aqui traz um bloco
        // anônimo no topo. O conteúdo dele é o documento, então
        // ele é MESCLADO no nível corrente.
        //
        // Descartá-lo (que era o que este ramo fazia antes) fazia
        // `parseVdf(extractBlock(...))` devolver um objeto vazio —
        // e o agente concluir "não achei o buildid" para um texto
        // em que ele estava.
        Object.assign(result, this.readBlock());
        continue;
      }

      const value = this.#readToken();

      if (value === null) {
        return result;
      }

      if (value.kind === 'open') {
        result[key.text] = this.readBlock();
        continue;
      }

      if (value.kind === 'close') {
        // "chave" seguida de fechamento: chave sem valor.
        return result;
      }

      result[key.text] = value.text;
    }
  }

  /**
   * O próximo token: uma string entre aspas, um `{`, um `}`, ou
   * `null` no fim do texto.
   *
   * Tudo que estiver FORA de aspas e não for chave é descartado —
   * é assim que as linhas de log do SteamCMD somem.
   */
  #readToken(): { kind: 'string' | 'open' | 'close'; text: string } | null {
    while (this.#index < this.#text.length) {
      const char = this.#text[this.#index];

      if (char === '"') {
        this.#index += 1;
        return { kind: 'string', text: this.#readQuoted() };
      }

      if (char === '{') {
        this.#index += 1;
        return { kind: 'open', text: '{' };
      }

      if (char === '}') {
        this.#index += 1;
        return { kind: 'close', text: '}' };
      }

      this.#index += 1;
    }

    return null;
  }

  /** Lê até a aspa de fechamento. O `\` escapa o próximo char. */
  #readQuoted(): string {
    let out = '';

    while (this.#index < this.#text.length) {
      const char = this.#text[this.#index];
      this.#index += 1;

      if (char === '"') {
        return out;
      }

      if (char === '\\') {
        const next = this.#text[this.#index];
        this.#index += 1;

        // `\\` e `\"` são os únicos que aparecem nos nossos
        // arquivos (caminhos do Windows e nada mais). Qualquer
        // outro é devolvido cru, e não interpretado como escape
        // de C — um `\n` num caminho é uma pasta chamada "n".
        out += next === undefined ? '' : next;
        continue;
      }

      out += char ?? '';
    }

    return out;
  }
}
