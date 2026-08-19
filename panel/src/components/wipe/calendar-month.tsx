'use client';

// ============================================================
//  calendar-month.tsx  -  a grade de um mês. DA CASA, e não do
//  wipe.
//
//  ####  ELE NÃO SABE O QUE É UM WIPE  ####
//
//  Ele recebe MARCAÇÕES genéricas (`{ at, kind, label, tone }`) e
//  desenha o mês. É de propósito: a tela de EVENTOS vai usar esta
//  mesma grade, e um calendário que importasse `WipePlan` seria um
//  calendário para reescrever no dia em que o primeiro evento
//  entrasse.
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
import { useEffect, useMemo, useState } from 'react';

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
  readonly label: string;
  readonly tone: CalendarTone;
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

const BAR_CLASS: Readonly<Record<CalendarTone, string>> = {
  rust: 'bg-rust',
  amber: 'bg-amber',
  olive: 'bg-olive',
  muted: 'bg-muted',
};

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
}

export function CalendarMonth({ marks, today, legend, onVisibleMonthChange }: CalendarMonthProps) {
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
                  <DayCell key={cell.key} cell={cell} />
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
    </Section>
  );
}

function DayCell({ cell }: { readonly cell: CalendarDay }) {
  const labels = cell.marks.map((mark) => mark.label).join(' · ');

  return (
    <td
      // O `title` é o que dá a frase inteira sem transformar a
      // casa num acordeão. Ele acompanha um texto só para leitor
      // de tela, porque `title` sozinho não é lido em toque.
      title={labels === '' ? undefined : labels}
      className={cn(
        'h-16 border border-border align-top',
        cell.inMonth ? 'bg-surface' : 'bg-surface-2',
      )}
    >
      <div className="flex h-full flex-col gap-1 p-1">
        <span
          className={cn(
            'font-condensed text-xs tabular-nums',
            cell.inMonth ? 'text-foreground' : 'text-muted',
            cell.isToday && 'inline-flex h-5 w-5 items-center justify-center bg-rust text-white',
          )}
        >
          {cell.day}
        </span>

        {cell.marks.length > 0 && (
          <>
            <span className="sr-only">{labels}</span>

            <span className="flex flex-col gap-0.5">
              {cell.marks.map((mark, index) => (
                <span
                  key={`${mark.kind}-${String(mark.at)}-${String(index)}`}
                  aria-hidden="true"
                  data-kind={mark.kind}
                  className={cn('h-1.5 w-full', BAR_CLASS[mark.tone])}
                />
              ))}
            </span>
          </>
        )}
      </div>
    </td>
  );
}
