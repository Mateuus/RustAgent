'use client';

// ============================================================
//  O interruptor: DOIS SEGMENTOS, e não uma pílula deslizante.
//
//  ####  POR QUE NÃO O SWITCH DE SEMPRE  ####
//
//  O design system não tem forma orgânica: a escala de raio inteira
//  foi redefinida para no máximo 4px (ver tailwind.config.ts), e uma
//  pílula com bolinha destoa de tudo o que está em volta. Pior: com
//  o fundo vermelho, o knob escuro simplesmente sumia.
//
//  O segmentado resolve os dois e ganha uma terceira coisa: ele diz
//  em PALAVRAS o que está ligado. Cor sozinha não fala com quem não
//  separa vermelho de cinza — e "qual lado é o ligado?" é a dúvida
//  clássica do switch sem rótulo.
//
//  ------------------------------------------------------------
//  ####  POR QUE ELE MORA EM ui\  ####
//
//  Nasceu dentro de server-settings.tsx, onde havia dois usos. Está
//  aqui para que o terceiro não vire uma cópia — e a cópia é o que
//  diverge no primeiro ajuste de altura ou de contraste, deixando o
//  painel com dois interruptores de mesmo papel e aparências
//  diferentes.
//
//  ####  ONDE ELE NÃO SERVE  ####
//
//  Em tela que já separa os estados em listas — a aba de plugins de
//  um servidor tem uma coluna "disponíveis" e outra "ativos". Ali o
//  estado está na COLUNA, e um interruptor de dois lados por linha
//  repetiria a mesma informação; o certo é o botão da ação que
//  falta ("Ligar", "Tirar").
// ============================================================

import { cn } from '@/lib/utils';

export interface ToggleProps {
  readonly on: boolean;
  /** Em voo: os dois lados ficam inertes até a resposta chegar. */
  readonly busy: boolean;
  readonly onChange: (value: boolean) => void;
  /** `[ligado, desligado]` — nesta ordem. */
  readonly labels?: readonly [string, string];
  /** O que o leitor de tela anuncia antes dos rótulos. */
  readonly label?: string;
}

export function Toggle({
  on,
  busy,
  onChange,
  labels = ['Ligado', 'Desligado'],
  label,
}: ToggleProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex shrink-0 border border-border', busy && 'opacity-50')}
    >
      {([true, false] as const).map((value, index) => (
        <button
          key={String(value)}
          type="button"
          // `aria-pressed`, e não um `role="switch"`: são dois alvos
          // de clique de verdade, e cada um diz se É o estado atual.
          // Um switch anunciaria "ativado/desativado" sem os rótulos
          // que estão escritos na tela.
          aria-pressed={on === value}
          disabled={busy}
          onClick={() => {
            if (on !== value) {
              onChange(value);
            }
          }}
          className={cn(
            'px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide transition-colors',
            index === 1 && 'border-l border-border',
            on === value
              ? value
                ? 'bg-rust text-white'
                : 'bg-surface-2 text-foreground'
              : 'text-muted hover:text-foreground',
          )}
        >
          {labels[index]}
        </button>
      ))}
    </div>
  );
}
