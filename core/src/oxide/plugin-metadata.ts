// ============================================================
//  plugin-metadata.ts  -  o que o próprio .cs diz sobre si.
//
//  ####  O DADO JÁ ESTÁ NO ARQUIVO  ####
//
//  Todo plugin de Oxide declara nome, autor e versão num atributo
//  no topo da classe:
//
//      [Info("Origem Z Player", "OrigemZ", "1.2.3")]
//      [Description("Expõe posição e estado dos jogadores")]
//
//  Pedir isso num formulário de upload seria criar uma SEGUNDA
//  fonte para o mesmo fato — e a segunda é a que diverge no dia em
//  que alguém sobe a versão nova sem reabrir o formulário. A tela
//  passaria a mostrar 1.2.3 para um arquivo que já é 1.3.0, sem
//  erro nenhum.
//
//  ------------------------------------------------------------
//  ####  ISTO É REGEX, NÃO UM COMPILADOR DE C#  ####
//
//  E é o suficiente: o atributo é uma linha convencional, escrita
//  do mesmo jeito em todo plugin publicado. O que a regex não
//  pega — nome montado por concatenação, atributo dentro de um
//  `#if` — vira `null`, que a tela mostra como travessão.
//
//  O que ela NÃO pode fazer é adivinhar: um metadado errado é pior
//  que um ausente, porque ninguém confere o que parece certo.
// ============================================================

import { createHash } from 'node:crypto';

export interface PluginMetadata {
  /** O 1º argumento do `[Info]`. `null` se o arquivo não declara. */
  readonly title: string | null;
  readonly author: string | null;
  readonly version: string | null;
  readonly description: string | null;
  /**
   * `// Requires: X` — dependência DURA.
   *
   * O Oxide não carrega este plugin enquanto o `X` não estiver
   * carregado. Tirar o `X` de um servidor derruba este junto.
   */
  readonly requires: readonly string[];
  /**
   * `[PluginReference] private Plugin X;` — dependência MOLE.
   *
   * O plugin carrega e roda sem o `X`; o campo fica nulo e a parte
   * que dependia dele para de funcionar. Perder isso não derruba
   * nada, mas muda o que o servidor faz — e é o tipo de coisa que
   * ninguém liga ao plugin que foi desligado semana passada.
   */
  readonly references: readonly string[];
}

/**
 * `[Info("Título", "Autor", "1.2.3")]`.
 *
 * O terceiro argumento aceita as duas formas que aparecem na
 * prática: `"1.2.3"` entre aspas e `1.2` como literal numérico —
 * esta última é o que o compilador do Oxide converte em
 * `VersionNumber`, e há plugin publicado que a usa.
 *
 * O `\s*` generoso entre as partes é para o atributo quebrado em
 * várias linhas, comum quando o nome do autor é longo.
 */
const INFO_PATTERN =
  /\[\s*Info\s*\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*(?:"([^"]*)"|([0-9]+(?:\.[0-9]+)*))/;

const DESCRIPTION_PATTERN = /\[\s*Description\s*\(\s*"([^"]*)"\s*\)\s*\]/;

/**
 * `// Requires: OrigemZAgent`
 *
 * Diretiva do PRÓPRIO Oxide, e não convenção nossa: ele lê este
 * comentário e adia o carregamento até a dependência existir. Por
 * isso ela mora na primeira linha do arquivo, antes de qualquer
 * `using`.
 *
 * Aceita mais de um nome na mesma linha, separados por vírgula.
 */
const REQUIRES_PATTERN = /^[ \t]*\/\/[ \t]*Requires:[ \t]*(.+)$/gim;

/**
 * `[PluginReference] private Plugin Kits;`
 *
 * O nome que importa é o do CAMPO, não o do tipo: é ele que casa
 * com o nome do plugin. O atributo aceita um apelido —
 * `[PluginReference("Kits")]` — e aí o campo pode se chamar outra
 * coisa; o apelido ganha.
 *
 * ####  O TIPO `Plugin` NÃO É OPCIONAL NA REGEX  ####
 *
 * Sem exigi-lo, ela casava dentro de COMENTÁRIOS. Os nossos plugins
 * explicam o mecanismo em prosa —
 *
 *     // Consumida por outro plugin com [PluginReference] +
 *     // Call("Nome", ...)
 *     // [PluginReference] e o tipo Plugin moram em Oxide.Core.
 *
 * — e a versão frouxa saía dali com `memoria`, `mapa` e `System`
 * como se fossem dependências. Metadado errado é pior que ausente:
 * a tela avisaria que tirar um plugin quebra outro que nem existe,
 * e quem lesse isso duas vezes pararia de ler os avisos.
 *
 * Exigir `... Plugin <Nome>;` logo depois do `]` basta, porque nas
 * frases de comentário o que vem depois nunca é a declaração.
 */
const REFERENCE_PATTERN =
  /\[\s*PluginReference\s*(?:\(\s*"([^"]*)"\s*\))?\s*\]\s*(?:(?:private|public|protected|internal|static|readonly)\s+)*Plugin\s+(\w+)\s*[;=]/g;

/**
 * Até onde procurar o `[Info]` e o `[Description]`.
 *
 * Eles ficam logo antes da declaração da classe, depois dos
 * `using` — nunca passa de alguns milhares de caracteres. Varrer o
 * arquivo inteiro atrás deles multiplicaria o trabalho da regex por
 * um plugin de 180 KB sem chance de achar nada a mais.
 *
 * As DEPENDÊNCIAS são outra história e leem o arquivo todo: ver
 * `readDependencies`.
 */
const METADATA_HEAD_CHARS = 8_192;

/** Vazio vira `null`: `[Info("", "", "")]` não é metadado. */
function orNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();

  return trimmed === '' ? null : trimmed;
}

/** Nomes únicos, sem vazios, na ordem em que apareceram. */
function uniqueNames(names: readonly (string | undefined)[]): readonly string[] {
  const seen = new Set<string>();

  for (const raw of names) {
    const name = (raw ?? '').trim();

    if (name !== '') {
      seen.add(name);
    }
  }

  return [...seen];
}

/**
 * As dependências declaradas no arquivo.
 *
 * ####  POR QUE O ARQUIVO INTEIRO, E NÃO SÓ O COMEÇO  ####
 *
 * O `// Requires:` fica na primeira linha, mas o
 * `[PluginReference]` aparece onde o campo for declarado — e num
 * plugin grande isso pode ser na linha mil e duzentos. Ler só o
 * cabeçalho pegaria metade das dependências, que é pior que
 * nenhuma: a tela diria "nada depende disto" com confiança.
 */
function readDependencies(source: string): {
  requires: readonly string[];
  references: readonly string[];
} {
  const requires: string[] = [];

  for (const match of source.matchAll(REQUIRES_PATTERN)) {
    // `// Requires: A, B` — o Oxide aceita a lista na mesma linha.
    requires.push(...(match[1] ?? '').split(','));
  }

  const references: (string | undefined)[] = [];

  for (const match of source.matchAll(REFERENCE_PATTERN)) {
    // O apelido do atributo ganha do nome do campo.
    references.push(match[1] ?? match[2]);
  }

  const hard = uniqueNames(requires);

  return {
    requires: hard,
    // Um nome que já é dependência DURA não se repete na lista
    // mole: o plugin costuma declarar as duas coisas para o mesmo
    // vizinho, e mostrar duas vezes na tela só confunde.
    references: uniqueNames(references).filter((name) => !hard.includes(name)),
  };
}

export function readPluginMetadata(content: Buffer): PluginMetadata {
  const source = content.toString('utf8');
  const head = source.slice(0, METADATA_HEAD_CHARS);

  const info = INFO_PATTERN.exec(head);
  const description = DESCRIPTION_PATTERN.exec(head);

  return {
    title: orNull(info?.[1]),
    author: orNull(info?.[2]),
    // Um dos dois grupos casa, nunca os dois: aspas OU número.
    version: orNull(info?.[3] ?? info?.[4]),
    description: orNull(description?.[1]),
    ...readDependencies(source),
  };
}

/**
 * O resumo do conteúdo, em hex.
 *
 * É o que responde "este arquivo mudou?" sem comparar byte a byte
 * duas cópias que vivem em pastas diferentes. Data de modificação
 * não serve para isso: copiar um arquivo a reescreve, e dois `.cs`
 * idênticos passariam por versões diferentes.
 */
export function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
