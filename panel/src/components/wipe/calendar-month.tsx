'use client';

// ============================================================
//  calendar-month.tsx  -  a grade de um mês. DA CASA, e não do
//  wipe.
//
//  ####  ELE NÃO SABE O QUE É UM WIPE  ####
//
//  Ele recebe MARCAÇÕES genéricas (`{ at, kind, label, detail,
//  tone }`) e desenha o mês. É de propósito: a tela de EVENTOS vai
//  usar esta mesma grade, e um calendário que importasse `WipePlan`
//  seria um calendário para reescrever no dia em que o primeiro
//  evento entrasse.
//
//  Por isso o clique numa casa não abre nada aqui: ele só AVISA
//  (`onSelectDay`) qual dia foi escolhido, com as marcações dele.
//  Quem sabe o que aquilo significa é quem passou as marcações.
//
//  ####  A CASA MOSTRA O RÓTULO, E NÃO SÓ UMA BARRA  ####
//
//  A grade nasceu com barrinhas coloridas mudas: para saber o que
//  havia num dia era preciso parar o mouse em cima e esperar o
//  `title` do navegador aparecer. Um mês inteiro de tracinhos
//  anônimos não se lê — se adivinha.
//
//  Agora cada marcação é uma tarja com TEXTO ("16:00 · Cadência"),
//  a cor virou o acento à esquerda dela, e o balão — que é nosso, e
//  não do navegador — traz o resto na hora: blueprints, mapa,
//  situação, anotação.
//
//  ####  O BALÃO NÃO MORA DENTRO DA CASA  ####
//
//  A primeira versão era um `absolute` dentro do `<td>`, e ficava
//  entalada nele: numa casa de sexta ela vazava pela direita da
//  tela, e numa casa da última semana subia por cima do próprio
//  wipe que estava explicando. Uma célula de tabela é o pior lugar
//  do documento para ancorar um painel flutuante — a largura é a
//  da coluna, e não a do conteúdo.
//
//  Agora o balão sai num portal no `<body>`, em coordenadas de
//  viewport medidas da casa (`getBoundingClientRect`): ele escolhe
//  abrir para cima ou para baixo pelo espaço que sobra, e encosta
//  na borda da janela em vez de atravessá-la.
//
//  ####  SEM BIBLIOTECA DE CALENDÁRIO  ####
//
//  O painel não tem uma, e não vai ter. O que uma traria é
//  localização e navegação — e as duas cabem em `Intl` e em duas
//  setas. O que ela cobraria é um pacote a mais para atualizar, com
//  o CSS dele brigando com um design system de cantos retos.
//
//  ####  O FUSO É O DO NAVEGADOR  ####
//
//  A grade é lida no relógio de quem está olhando. O horário
//  CONFIGURADO do wipe (e o fuso IANA em que ele foi escrito)
//  aparecem separados, na configuração da cadência — misturar os
//  dois na mesma grade faria "quinta" significar duas coisas.
//
//  Por isso o dia de uma marcação é apurado pelos campos LOCAIS da
//  data (ano/mês/dia), e nunca somando 86.400.000 ms: na semana em
//  que o fuso muda de offset, um dia não tem 24 h — e a marcação
//  cairia na casa errada exatamente na semana em que ninguém
//  esperaria conferir.
// ============================================================

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** As quatro cores do chrome, e nada além delas. */
export type CalendarTone = 'rust' | 'amber' | 'olive' | 'muted';

/**
 * Uma coisa marcada no calendário.
 *
 * `kind` é texto livre (`'cadence'`, `'forced'`, `'event'`, …)
 * porque quem consome a grade é que sabe os seus tipos. A grade
 * só o repassa na chave de reação e no `data-kind`.
 */
export interface CalendarMark {
  /** Epoch ms. */
  readonly at: number;
  readonly kind: string;
  /**
   * A linha curta que cabe DENTRO da casa — "16:00 · Cadência".
   *
   * Curta de verdade: a casa tem um sétimo da largura da grade, e
   * o que não couber é cortado com reticências.
   */
  readonly label: string;
  /** O resto, uma frase por linha, que só o balão mostra. */
  readonly detail?: readonly string[];
  readonly tone: CalendarTone;
  /**
   * Não vai acontecer (cancelado, pulado, já feito).
   *
   * A tarja aparece riscada — o mesmo tratamento da lista logo
   * abaixo da grade. Existe porque `tone: 'muted'` sozinho é
   * cinza, e cinza, num tema escuro, também é só "menos
   * importante".
   */
  readonly struck?: boolean;
}

/** Uma casa da grade. */
export interface CalendarDay {
  /** `YYYY-MM-DD` no fuso do navegador. É a chave que agrupa as marcações. */
  readonly key: string;
  readonly day: number;
  /** Do mês que está sendo mostrado? As bordas vêm dos meses vizinhos. */
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly marks: readonly CalendarMark[];
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;

/**
 * `YYYY-MM-DD` a partir dos campos LOCAIS de um instante.
 *
 * Nunca `toISOString()`: aquele devolve o dia em UTC, e às 21h de
 * Brasília o dia em UTC já é o seguinte — metade das marcações da
 * noite cairia na casa errada.
 */
export function dayKey(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * O meio-dia do primeiro dia do mês daquele instante.
 *
 * Meio-dia, e não meia-noite: em fusos que adiantam o relógio à
 * meia-noite (como o horário de verão brasileiro fazia), o
 * instante "00:00" simplesmente não existe naquele dia, e o
 * navegador devolve o dia seguinte. Ao meio-dia nenhum fuso do
 * mundo tem esse buraco.
 */
export function monthStart(at: number): number {
  const date = new Date(at);

  return new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0).getTime();
}

/** O mesmo mês, N meses adiante (ou atrás, com N negativo). */
export function shiftMonth(at: number, delta: number): number {
  const date = new Date(at);

  return new Date(date.getFullYear(), date.getMonth() + delta, 1, 12, 0, 0, 0).getTime();
}

/** `setembro de 2026` — o `Intl` cuida do idioma. */
export function monthLabel(at: number): string {
  return new Date(at).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

/**
 * A grade do mês, em semanas de sete dias começando no domingo.
 *
 * As casas das bordas são dos meses vizinhos (`inMonth: false`) em
 * vez de buracos: uma grade que começa com quatro vazios não
 * ajuda a ver que o dia 1º é uma terça.
 */
export function buildMonthGrid(
  month: number,
  marks: readonly CalendarMark[],
  today: number,
): readonly (readonly CalendarDay[])[] {
  const byDay = new Map<string, CalendarMark[]>();

  for (const mark of marks) {
    const key = dayKey(mark.at);
    const bucket = byDay.get(key);

    if (bucket === undefined) {
      byDay.set(key, [mark]);
    } else {
      bucket.push(mark);
    }
  }

  for (const bucket of byDay.values()) {
    bucket.sort((left, right) => left.at - right.at);
  }

  const first = new Date(monthStart(month));
  const year = first.getFullYear();
  const index = first.getMonth();

  // `getDay()` de domingo é 0, que é justamente quantas casas
  // vazias a semana precisa antes do dia 1º.
  const leading = first.getDay();
  // Dia 0 do mês SEGUINTE é o último deste — a conta que dispensa
  // saber de fevereiro e de ano bissexto.
  const daysInMonth = new Date(year, index + 1, 0, 12, 0, 0, 0).getDate();
  const weeks = Math.ceil((leading + daysInMonth) / 7);

  const todayKey = dayKey(today);
  const rows: CalendarDay[][] = [];

  for (let week = 0; week < weeks; week += 1) {
    const row: CalendarDay[] = [];

    for (let column = 0; column < 7; column += 1) {
      const offset = week * 7 + column - leading + 1;
      // O construtor normaliza sozinho: dia 0 é o último do mês
      // anterior, e dia 32 é o 1º do seguinte.
      const date = new Date(year, index, offset, 12, 0, 0, 0);
      const key = dayKey(date.getTime());

      row.push({
        key,
        day: date.getDate(),
        inMonth: date.getMonth() === index && date.getFullYear() === year,
        isToday: key === todayKey,
        marks: byDay.get(key) ?? [],
      });
    }

    rows.push(row);
  }

  return rows;
}

/** A barra da legenda, e o traço de cor dentro do balão. */
const BAR_CLASS: Readonly<Record<CalendarTone, string>> = {
  rust: 'bg-rust',
  amber: 'bg-amber',
  olive: 'bg-olive',
  muted: 'bg-muted',
};

/** A mesma cor, agora como acento à esquerda da tarja. */
const EDGE_CLASS: Readonly<Record<CalendarTone, string>> = {
  rust: 'border-l-rust',
  amber: 'border-l-amber',
  olive: 'border-l-olive',
  muted: 'border-l-muted',
};

/**
 * Quantas tarjas cabem numa casa antes de virar "+2".
 *
 * Duas: é a altura que mantém o mês inteiro numa tela sem
 * rolagem, e ver o MÊS é o que a grade faz melhor que a lista.
 * Quem tem três wipes num dia abre a casa.
 */
const MAX_CHIPS = 2;

export interface CalendarMonthProps {
  readonly marks: readonly CalendarMark[];
  /**
   * O instante que a grade chama de "hoje".
   *
   * Vem do relógio do AGENTE, e não de `Date.now()`: quem opera o
   * servidor de outro fuso não pode ver "hoje" numa casa e a
   * contagem regressiva discordando dela.
   */
  readonly today: number;
  /** A legenda do rodapé, na ordem em que ela é lida. */
  readonly legend?: readonly { readonly tone: CalendarTone; readonly label: string }[];
  /**
   * Alguém navegou para outro mês. Serve para quem busca as
   * marcações por faixa de data.
   *
   * É chamado no CLIQUE, e não num efeito: um efeito com esta
   * função na lista de dependências dispararia a cada render de
   * quem passasse uma seta inline, e um `setState` do outro lado
   * fecharia o laço.
   */
  readonly onVisibleMonthChange?: (month: number) => void;
  /**
   * Alguém abriu uma casa COM marcações.
   *
   * Sem esta prop a casa não vira botão — e é o certo: uma grade
   * em que tudo tem `cursor: pointer` e metade não faz nada ensina
   * a não clicar em lugar nenhum.
   */
  readonly onSelectDay?: (day: CalendarDay) => void;
}

export function CalendarMonth({
  marks,
  today,
  legend,
  onVisibleMonthChange,
  onSelectDay,
}: CalendarMonthProps) {
  const [visible, setVisible] = useState(() => monthStart(today));

  // O "hoje" chega depois da primeira resposta do agente. Sem
  // isto, a grade abriria no mês do primeiro render e ficaria lá.
  // `monthStart` é estável dentro do mês, então o relógio andando
  // de segundo em segundo não arrasta a grade de volta.
  const todayMonth = monthStart(today);

  useEffect(() => {
    setVisible(todayMonth);
  }, [todayMonth]);

  function go(month: number): void {
    setVisible(month);
    onVisibleMonthChange?.(month);
  }

  const rows = useMemo(() => buildMonthGrid(visible, marks, today), [visible, marks, today]);

  /** A casa sob o mouse (ou sob o foco), e onde ela está na tela. */
  const [peek, setPeek] = useState<{ readonly cell: CalendarDay; readonly box: Box } | null>(null);

  function peekAt(cell: CalendarDay, element: HTMLElement | null): void {
    if (element === null || cell.marks.length === 0) {
      setPeek(null);

      return;
    }

    const rect = element.getBoundingClientRect();

    setPeek({
      cell,
      box: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
    });
  }

  // Rolar ou redimensionar deixa o balão parado no ar, longe da
  // casa que o abriu: a medida foi tirada uma vez, e refazê-la a
  // cada quadro de rolagem custaria um layout por quadro. Some, e
  // volta assim que o mouse encostar de novo.
  useEffect(() => {
    if (peek === null) {
      return;
    }

    const drop = (): void => {
      setPeek(null);
    };

    // `true` na captura: a rolagem pode acontecer num contêiner
    // interno, que não borbulha para a janela.
    window.addEventListener('scroll', drop, true);
    window.addEventListener('resize', drop);

    return () => {
      window.removeEventListener('scroll', drop, true);
      window.removeEventListener('resize', drop);
    };
  }, [peek]);

  return (
    <Section
      title={monthLabel(visible)}
      aside={
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Mês anterior"
            onClick={() => {
              go(shiftMonth(visible, -1));
            }}
          >
            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          </Button>

          <Button
            size="sm"
            variant="ghost"
            disabled={visible === todayMonth}
            onClick={() => {
              go(todayMonth);
            }}
          >
            hoje
          </Button>

          <Button
            size="sm"
            variant="ghost"
            aria-label="Próximo mês"
            onClick={() => {
              go(shiftMonth(visible, 1));
            }}
          >
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {/* Uma tabela de verdade: o leitor de tela anuncia "sábado,
            dia 12" porque a coluna tem cabeçalho, e não porque
            alguém escreveu isso num aria-label à mão. */}
        <table className="w-full table-fixed border-collapse">
          <caption className="sr-only">{`Calendário de ${monthLabel(visible)}`}</caption>
          <thead>
            <tr>
              {WEEKDAYS.map((weekday) => (
                <th
                  key={weekday}
                  scope="col"
                  className="border border-border bg-surface-2 py-1 font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
                >
                  {weekday}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]?.key ?? ''}>
                {row.map((cell) => (
                  <DayCell key={cell.key} cell={cell} onSelect={onSelectDay} onPeek={peekAt} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {legend !== undefined && legend.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {legend.map((entry) => (
              <li key={entry.label} className="flex items-center gap-1.5 text-2xs text-muted">
                <span aria-hidden="true" className={cn('h-3 w-[3px]', BAR_CLASS[entry.tone])} />
                {entry.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      {peek !== null && (
        <MarkBalloon
          cell={peek.cell}
          box={peek.box}
          clickable={onSelectDay !== undefined}
        />
      )}
    </Section>
  );
}

/**
 * Uma casa da grade.
 *
 * ####  O BALÃO É NOSSO, E NÃO O `title` DO NAVEGADOR  ####
 *
 * O `title` demora quase um segundo para aparecer, some quando o
 * mouse se mexe, não abre no foco do teclado e não formata nada:
 * tudo o que sabe fazer é uma linha com a fonte do sistema, fora
 * do tema. Para dizer "16:00 · Cadência · BP mantidos · mapa: o
 * primeiro pronto da fila" ele produzia uma frase corrida que
 * ninguém lia até o fim.
 *
 * O balão daqui abre no hover E no foco (`group-focus-within`),
 * porque a casa é um botão: quem chega nela pelo Tab vê a mesma
 * coisa que quem chega com o mouse.
 *
 * ####  A CASA VAZIA CONTINUA SENDO UM `div`  ####
 *
 * Só o dia que tem alguma marcação vira botão. Uma grade inteira
 * de botões faria o Tab passar por 35 paradas mudas antes de
 * chegar na lista de baixo.
 */
function DayCell({
  cell,
  onSelect,
  onPeek,
}: {
  readonly cell: CalendarDay;
  readonly onSelect?: (day: CalendarDay) => void;
  /** Avisa a grade qual casa mostrar no balão, e onde ela está. */
  readonly onPeek: (cell: CalendarDay, element: HTMLElement | null) => void;
}) {
  const has = cell.marks.length > 0;
  const clickable = has && onSelect !== undefined;

  // Para o leitor de tela a casa é uma frase só, com tudo o que o
  // balão mostraria: ele não tem hover para abrir balão nenhum.
  const spoken = cell.marks
    .map((mark) => [mark.label, ...(mark.detail ?? [])].join(', '))
    .join('; ');

  const shown = cell.marks.slice(0, MAX_CHIPS);
  const hidden = cell.marks.length - shown.length;

  const body = (
    <>
      <span className="flex items-center justify-between gap-1">
        <span
          className={cn(
            'font-condensed text-xs tabular-nums',
            cell.inMonth ? 'text-foreground' : 'text-muted',
            cell.isToday &&
              'inline-flex h-5 min-w-5 items-center justify-center bg-rust px-1 font-bold text-white',
          )}
        >
          {cell.day}
        </span>

        {hidden > 0 && (
          <span aria-hidden="true" className="font-condensed text-2xs text-muted">
            {`+${String(hidden)}`}
          </span>
        )}
      </span>

      {has && (
        <>
          <span className="sr-only">{spoken}</span>

          <span aria-hidden="true" className="flex flex-col gap-0.5">
            {shown.map((mark, index) => (
              <span
                key={`${mark.kind}-${String(mark.at)}-${String(index)}`}
                data-kind={mark.kind}
                className={cn(
                  'flex items-center overflow-hidden border-l-[3px] bg-surface-2 px-1 py-px',
                  EDGE_CLASS[mark.tone],
                )}
              >
                <span
                  className={cn(
                    'truncate font-condensed text-2xs leading-4',
                    mark.struck ? 'text-muted line-through' : 'text-foreground',
                  )}
                >
                  {mark.label}
                </span>
              </span>
            ))}
          </span>
        </>
      )}
    </>
  );

  const inner = 'flex h-full w-full flex-col gap-1 p-1 text-left';

  // O balão é da GRADE, e quem o abre é a casa: `onPeek` no
  // `<td>` inteiro cobre o mouse, e o `onFocus` do botão cobre
  // quem chega pelo Tab.
  function show(event: { readonly currentTarget: HTMLElement }): void {
    onPeek(cell, event.currentTarget);
  }

  function hide(): void {
    onPeek(cell, null);
  }

  return (
    <td
      onMouseEnter={show}
      onMouseLeave={hide}
      className={cn(
        'h-24 border border-border p-0 align-top',
        cell.inMonth ? 'bg-surface' : 'bg-background',
      )}
    >
      {clickable ? (
        <button
          type="button"
          aria-label={`Dia ${String(cell.day)}: ${spoken}`}
          onFocus={show}
          onBlur={hide}
          onClick={() => {
            onSelect(cell);
          }}
          className={cn(
            inner,
            'transition hover:bg-surface-2/60',
            'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2',
          )}
        >
          {body}
        </button>
      ) : (
        <div className={inner}>{body}</div>
      )}
    </td>
  );
}

/** Onde a casa está na janela, no instante em que o mouse chegou. */
interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
}

/** Largura fixa do balão, em px. É a conta que decide se ele cabe. */
const BALLOON_WIDTH = 300;

/** O respiro entre o balão e a casa que o abriu. */
const BALLOON_GAP = 6;

/**
 * A altura que se ASSUME para decidir o lado da abertura.
 *
 * Assumir, e não medir: medir exigiria renderizar o balão, ler a
 * altura e renderizar de novo — dois quadros, com um piscada no
 * meio. Errar aqui custa um balão que abre para baixo tendo espaço
 * de sobra em cima; errar para o outro lado cortaria o conteúdo.
 */
const BALLOON_GUESS = 220;

/**
 * O retângulo com o dia inteiro, flutuando sobre a página.
 *
 * ####  POR QUE FIXO, E POR QUE NUM PORTAL  ####
 *
 * Ancorado no `<td>` ele herdava a largura da coluna e o
 * empilhamento da tabela: vazava pela direita nas colunas de
 * sexta e sábado, e subia por cima do próprio wipe nas últimas
 * semanas. Em `position: fixed`, dentro de um portal no `<body>`,
 * ele existe em coordenadas de janela — e aí "não passar da borda"
 * vira uma conta de duas linhas.
 *
 * `pointer-events-none`: ele nasce por cima das casas vizinhas, e
 * um balão que intercepta o clique roubaria o clique de quem quer
 * abrir o dia debaixo dele.
 */
function MarkBalloon({
  cell,
  box,
  clickable,
}: {
  readonly cell: CalendarDay;
  readonly box: Box;
  readonly clickable: boolean;
}) {
  // A grade só pinta o balão depois de uma interação do mouse ou
  // do teclado, então aqui já é o navegador — mas o guarda fica,
  // porque o componente é pré-renderizado no servidor.
  if (typeof document === 'undefined') {
    return null;
  }

  const viewport = { width: window.innerWidth, height: window.innerHeight };

  // Alinhado pela esquerda da casa, recuando o quanto precisar
  // para não atravessar a borda direita da janela.
  const left = Math.max(8, Math.min(box.left, viewport.width - BALLOON_WIDTH - 8));

  // Para cima quando não sobra altura embaixo. `bottom` em vez de
  // `top` neste caso é o que dispensa saber a altura do balão.
  const up = box.bottom + BALLOON_GUESS > viewport.height;

  const style: CSSProperties = up
    ? { left, bottom: viewport.height - box.top + BALLOON_GAP, width: BALLOON_WIDTH }
    : { left, top: box.bottom + BALLOON_GAP, width: BALLOON_WIDTH };

  return createPortal(
    <div
      aria-hidden="true"
      style={style}
      className="pointer-events-none fixed z-50 border border-border bg-surface-2 shadow-lg"
    >
      <p className="border-b border-border px-2 py-1 font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
        {dayLabel(cell)}
      </p>

      <ul className="divide-y divide-border">
        {cell.marks.map((mark, index) => (
          <li key={`${mark.kind}-${String(mark.at)}-${String(index)}`} className="flex gap-2 p-2">
            <span className={cn('w-[3px] shrink-0', BAR_CLASS[mark.tone])} />

            <div className="min-w-0">
              <p
                className={cn(
                  'font-condensed text-sm font-bold uppercase tracking-wide',
                  mark.struck ? 'text-muted line-through' : 'text-foreground',
                )}
              >
                {mark.label}
              </p>

              {(mark.detail ?? []).map((line) => (
                <p key={line} className="mt-0.5 text-2xs leading-relaxed text-muted">
                  {line}
                </p>
              ))}
            </div>
          </li>
        ))}
      </ul>

      {clickable && (
        <p className="border-t border-border px-2 py-1 text-2xs text-muted">
          Clique no dia para abrir tudo — e para editar, mover ou deletar.
        </p>
      )}
    </div>,
    document.body,
  );
}

/**
 * `qui, 24/09` — o cabeçalho do balão.
 *
 * A data sai da marcação, e não da chave do dia: a chave é texto
 * cru (`2026-09-24`), e `new Date('2026-09-24')` seria lido em UTC
 * — o que devolve o dia 23 para quem está no Brasil.
 */
function dayLabel(cell: CalendarDay): string {
  const first = cell.marks[0];

  if (first === undefined) {
    return String(cell.day);
  }

  return new Date(first.at).toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
}
