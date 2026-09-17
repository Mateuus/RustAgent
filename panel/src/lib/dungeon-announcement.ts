// ============================================================
//  dungeon-announcement.ts  -  a frase que o servidor inteiro lê.
//
//  ####  ISTO É UM ESPELHO, E O ORIGINAL É O DO PLUGIN  ####
//
//  A conta de verdade mora em `Plugins/OrigemZDungeon.cs`
//  (`AnnouncementText`), e o desenho da linha no OrigemZChat
//  (`origemz.chat.broadcast`). A cópia existe por um motivo só: a
//  PRÉVIA do passo "Mapa e chat". Ela mostra a frase sem erguer
//  masmorra nenhuma — e uma prévia que monta a frase diferente do
//  jogo mente com confiança.
//
//  ####  AS DUAS VARIÁVEIS  ####
//
//    {nome}  o NOME que o admin deu (o identificador, se vazio)
//    {grid}  a grade do mapa, como G6 — ou "algum lugar", quando a
//            masmorra é para ser procurada
//
//  Com a grade ligada e sem ela na frase, o plugin a acrescenta no
//  fim, entre parênteses: uma masmorra que ninguém sabe onde fica não
//  é um evento, é um boato.
//
//  ####  O TESTE DA GRADE É NA FRASE PRONTA  ####
//
//  O plugin pergunta se a GRADE aparece no texto já trocado, e não se
//  o texto tinha `{grid}`. Na prática dá no mesmo — a diferença é a
//  frase que já traz a grade escrita à mão, que não ganha a segunda.
//  A prévia faz a mesma pergunta, com a grade de exemplo.
// ============================================================

/** Os padrões que o jogo usa quando o campo está vazio. */
export const ANNOUNCE_DEFAULTS = {
  onBuild: 'Uma masmorra apareceu em {grid}.',
  onEnd: 'A masmorra de {grid} fechou.',
  /** A cor da tag no OrigemZChat. */
  tagColor: '#ffcc00',
  /** A cor do texto: branco. */
  color: '#ffffff',
  /** O tamanho do chat. */
  size: 15,
} as const;

/** O que `{grid}` vira quando a masmorra não diz onde está. */
export const HIDDEN_GRID = 'algum lugar';

/** A grade que a prévia usa no lugar da de verdade. */
export const SAMPLE_GRID = 'G6';

/** O teto de cada frase. O mesmo do schema do agente. */
export const ANNOUNCE_MAX_TEXT = 300;

/** O teto da tag. O mesmo do schema do agente. */
export const ANNOUNCE_MAX_TAG = 40;

/** O tamanho da letra: zero (o do chat) ou esta faixa. */
export const ANNOUNCE_SIZE_RANGE = { min: 8, max: 40 } as const;

/**
 * A mesma trava de cor do agente (`announceColorSchema`).
 *
 * A cor vai para dentro de um `<color=…>` no jogo, e aceitar texto
 * livre ali seria um caminho para injetar marcação — na tela, para
 * injetar CSS na página de quem administra.
 *
 * Três, quatro, seis ou oito dígitos: é o que o rich text do jogo
 * entende (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`).
 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u;

export interface AnnouncementInput {
  /** O texto do campo. Vazio = o padrão. */
  readonly template: string;
  /** O padrão daquela frase (`ANNOUNCE_DEFAULTS.onBuild` ou `.onEnd`). */
  readonly fallback: string;
  /** O nome da masmorra. */
  readonly name: string;
  /** O identificador, que vale quando o nome está vazio. */
  readonly slug: string;
  /** A grade do mapa. */
  readonly grid: string;
  readonly showGrid: boolean;
}

/**
 * A frase, com as variáveis trocadas.
 *
 * A ordem das trocas é a do plugin — `{grid}` primeiro, `{nome}`
 * depois —, e ela importa num caso só: um nome que contém `{grid}`
 * sai literal, nos dois lados.
 */
export function announcementText(input: AnnouncementInput): string {
  const name = input.name === '' ? input.slug : input.name;
  const source = input.template === '' ? input.fallback : input.template;

  const text = source
    .replaceAll('{grid}', input.showGrid ? input.grid : HIDDEN_GRID)
    .replaceAll('{nome}', name);

  if (input.showGrid && !text.includes(input.grid)) return `${text} (${input.grid})`;

  return text;
}

/** O campo de cor está vazio ou é um hexadecimal que o agente aceita? */
export function isAnnounceColor(value: string): boolean {
  return value === '' || HEX_COLOR.test(value.trim());
}

/** O tamanho é zero (o do chat) ou está na faixa? */
export function isAnnounceSize(value: number): boolean {
  return (
    value === 0 ||
    (Number.isInteger(value) && value >= ANNOUNCE_SIZE_RANGE.min && value <= ANNOUNCE_SIZE_RANGE.max)
  );
}

/**
 * O visual que a linha vai ter, com os padrões no lugar dos vazios.
 *
 * Cor torta vira o padrão — é o que o `style` da prévia pode receber
 * sem risco, e o que a validação do passo já está apontando.
 */
export function announcementStyle(announce: {
  readonly tagColor: string;
  readonly color: string;
  readonly size: number;
}): { readonly tagColor: string; readonly color: string; readonly size: number } {
  const pick = (value: string, fallback: string): string => {
    const clean = value.trim();

    return clean !== '' && HEX_COLOR.test(clean) ? clean : fallback;
  };

  return {
    tagColor: pick(announce.tagColor, ANNOUNCE_DEFAULTS.tagColor),
    color: pick(announce.color, ANNOUNCE_DEFAULTS.color),
    size: isAnnounceSize(announce.size) && announce.size > 0 ? announce.size : ANNOUNCE_DEFAULTS.size,
  };
}
