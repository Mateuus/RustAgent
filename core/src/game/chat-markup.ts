// ============================================================
//  chat-markup.ts  -  COR NO MEIO DA FRASE.
//
//  A `Cor do texto` da tela pinta a fala INTEIRA. Ela resolve
//  "meus avisos são amarelos" e não resolve o que todo servidor
//  acaba querendo:
//
//      Agora tem [verde]{online}[/]/{max}
//
//  — o número em destaque, o resto na cor de sempre. Sem isto, a
//  única saída do admin seria escrever `<color=#22c55e>` na mão, e
//  essa porta está FECHADA de propósito (ver abaixo).
//
//  ------------------------------------------------------------
//  ####  POR QUE NÃO DEIXAR O ADMIN ESCREVER RICH TEXT  ####
//
//  O campo é um formulário, e o que sai dele vai para o chat de
//  todo mundo. Rich text solto ali é a porta de `</color><size=90>`
//  — uma linha que empurra o chat inteiro para fora da tela — e de
//  um `<color>` sem fechar que pinta as mensagens SEGUINTES, que
//  não são do admin. Por isso o `OrigemZChat` passa todo texto de
//  fora pelo `StripRichText`, e ele continua passando.
//
//  A marcação daqui é o caminho controlado: `[verde]` só vira
//  `<color=#22c55e>` depois de ser reconhecida como cor, e o
//  fechamento é o plugin quem escreve — nunca o texto do
//  formulário.
//
//  ------------------------------------------------------------
//  ####  QUEM CONVERTE É O PLUGIN, E NÃO ESTE ARQUIVO  ####
//
//  O agente manda a marcação como ela foi escrita, e o
//  `OrigemZChat` (Plugins/OrigemZChat.cs, `ApplyChatMarkup`) é
//  quem produz o rich text — DEPOIS da faxina. Se o agente
//  mandasse `<color=…>` pronto, o plugin teria de confiar no que
//  chega pelo RCON para distinguir a cor que ele mesmo pediu da
//  que veio de um site integrado. Ele não precisa: a marcação
//  atravessa a faxina intacta, porque colchete não é rich text.
//
//  O que ESTE arquivo faz é o outro lado: saber ler a marcação
//  para o `say` do jogo (que não tem cor nenhuma) e para quem
//  precisar mostrar a frase sem os marcadores.
//
//  ------------------------------------------------------------
//  ####  O QUE NÃO É COR SAI LITERAL  ####
//
//  Mesma regra das variáveis (messages/variables.ts): `[AVISO]`,
//  `[BR]` e `[1x]` continuam sendo o que são. Só vira cor o que o
//  agente RECONHECE como cor — nome desta paleta ou hexadecimal.
//  Comer todo colchete faria a tag que o admin digitou no meio da
//  frase sumir sem aviso.
// ============================================================

/**
 * As cores com nome, em português.
 *
 * ####  POR QUE UMA PALETA, E NÃO SÓ HEXADECIMAL  ####
 *
 * `[verde]` é o que alguém escreve sem consultar nada. `#22c55e`
 * é o que se copia errado de um site e vira uma fala cinza que
 * ninguém entende por quê. O hexadecimal continua aceito — a
 * paleta é o atalho, não a cerca.
 *
 * Os valores são os mesmos do painel (message-dialog.tsx) e do
 * plugin (`ChatColors`, em Plugins/OrigemZChat.cs). Mudar um deles
 * exige mudar os três, ou a prévia passa a mentir.
 */
export const CHAT_COLORS: Readonly<Record<string, string>> = {
  branco: '#ffffff',
  preto: '#000000',
  cinza: '#9ca3af',
  vermelho: '#ef4444',
  laranja: '#f97316',
  amarelo: '#facc15',
  dourado: '#ffcc00',
  verde: '#22c55e',
  ciano: '#22d3ee',
  azul: '#3b82f6',
  roxo: '#a855f7',
  rosa: '#ec4899',
};

/** Os nomes da paleta, para a tela listar em ordem estável. */
export const CHAT_COLOR_NAMES = Object.keys(CHAT_COLORS);

/**
 * Hexadecimal como o rich text do jogo aceita: `#rgb`, `#rrggbb`
 * ou `#rrggbbaa`.
 *
 * O `aa` entra porque o TextMeshPro do Rust lê alfa, e um admin
 * que já tem a cor da marca com transparência não deveria ter de
 * cortá-la aqui.
 */
const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Um marcador: `[verde]`, `[#ff0000]`, `[/]`, `[/verde]`.
 *
 * Sem espaço e sem colchete no miolo, e no máximo 20 caracteres:
 * é o que impede `[a cada 30 min]` de ser lido como marcador
 * quebrado no meio de uma frase.
 */
const MARKER_PATTERN = /\[(\/?)([^[\]\s]{0,20})\]/g;

/** Um pedaço da frase e a cor em que ele sai. `null` = a cor padrão. */
export interface ColorSpan {
  readonly text: string;
  /** Hexadecimal já normalizado, ou `null` para a cor do campo. */
  readonly color: string | null;
}

/**
 * `verde` ou `#22C55E` -> `#22c55e`. `null` quando não é cor.
 *
 * A normalização para minúsculas existe para o "abrir a mesma cor
 * fecha" (abaixo) enxergar `[VERDE]` e `[verde]` como a mesma
 * coisa.
 */
export function resolveChatColor(token: string): string | null {
  const clean = token.trim().toLowerCase();

  if (clean === '') {
    return null;
  }

  if (HEX_PATTERN.test(clean)) {
    return clean;
  }

  return CHAT_COLORS[clean] ?? null;
}

/**
 * Quebra a frase nos pedaços coloridos.
 *
 * ####  AS TRÊS REGRAS, E POR QUE ELAS SÃO ESSAS  ####
 *
 *  1. `[cor]` liga a cor daí em diante.
 *  2. `[/]` (ou `[/cor]`) desliga e volta à anterior.
 *  3. Abrir A MESMA cor que já está ligada DESLIGA.
 *
 * A regra 3 não é enfeite: é como a maioria escreve na primeira
 * tentativa — `[azul]{online}[azul]/{max}` — e sem ela essa frase
 * sairia azul até o fim, calada. Com ela, o par funciona nos dois
 * estilos e ninguém precisa decorar qual é o certo.
 *
 * Cor aberta e não fechada vale ATÉ O FIM da frase. Esquecer o
 * fechamento é o erro mais comum, e o resultado dele aqui é uma
 * frase colorida demais — não uma frase com `[/]` faltando que
 * pinta a mensagem do jogador seguinte.
 */
export function parseChatMarkup(text: string): readonly ColorSpan[] {
  const spans: ColorSpan[] = [];
  const open: string[] = [];

  let buffer = '';
  let cursor = 0;

  const flush = (): void => {
    if (buffer !== '') {
      spans.push({ text: buffer, color: open.at(-1) ?? null });
      buffer = '';
    }
  };

  for (const match of text.matchAll(MARKER_PATTERN)) {
    const at = match.index;
    const closing = match[1] === '/';
    const color = resolveChatColor(match[2] ?? '');

    buffer += text.slice(cursor, at);

    if (closing) {
      // `[/]` sem nada aberto NÃO é fechamento: é um marcador
      // sobrando, e ele sai literal para o admin ver que sobrou.
      // `[/qualquercoisa]` idem — só `[/]` e `[/cor]` fecham.
      if (open.length === 0 || (match[2] !== '' && color === null)) {
        buffer += match[0];
      } else {
        flush();
        open.pop();
      }
    } else if (color === null) {
      // `[AVISO]`, `[BR]`, `[1x]`: não é cor, então é texto.
      buffer += match[0];
    } else {
      flush();

      if (open.at(-1) === color) {
        open.pop();
      } else {
        open.push(color);
      }
    }

    cursor = at + match[0].length;
  }

  buffer += text.slice(cursor);
  flush();

  return spans;
}

/**
 * A frase sem os marcadores que viraram cor.
 *
 * É o que vai para o `say` do jogo — que não tem cor nenhuma e
 * mostraria `[verde]` como texto — e para qualquer lugar que
 * precise da fala crua.
 */
export function stripChatMarkup(text: string): string {
  return parseChatMarkup(text)
    .map((span) => span.text)
    .join('');
}

/**
 * Tem alguma cor de verdade aqui dentro?
 *
 * Serve para a tela decidir se explica a marcação, e para o log
 * não prometer cor numa frase que só tem `[AVISO]` literal.
 */
export function hasChatMarkup(text: string): boolean {
  return parseChatMarkup(text).some((span) => span.color !== null);
}
