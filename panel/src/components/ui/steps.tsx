'use client';

// ============================================================
//  steps.tsx  -  a trilha de um formulário longo.
//
//  ####  TRINTA CAMPOS NUMA TELA SÓ É O JEITO DE GARANTIR QUE
//        NINGUÉM PREENCHA O DÉCIMO  ####
//
//  A trilha corta o formulário em passos que cabem numa tela, e o
//  trilho no topo diz três coisas de relance: onde estou, o que já
//  fiz, e onde está o problema.
//
//  Cinco regras, cada uma com um porquê:
//
//    1. DÁ PARA PULAR PARA FRENTE. Quem já conhece não quer clicar
//       seis vezes. O passo incompleto fica MARCADO, não trancado —
//       trancar transforma o assistente numa burocracia.
//
//    2. O PASSO COM ERRO FICA MARCADO NO TRILHO, mesmo estando três
//       passos atrás. Sem isso, "não consigo salvar" vira uma caça
//       ao campo.
//
//    3. O ESTADO NÃO É SÓ COR. Cada marca tem forma e rótulo: um
//       número, um traço, um "!" — a régua do design system diz que
//       identidade nunca vem só da cor, e aqui isso pesa porque
//       vermelho e verde são o par que o daltonismo mais confunde.
//
//    4. O RÓTULO NUNCA É CORTADO. A primeira versão dava `flex-1` a
//       cada passo e truncava o que não coubesse: com seis passos
//       num modal estreito, o trilho virou "IDE… TA… SA… INI… EN…
//       CO…" — seis reticências que não dizem nada e envergonham a
//       tela. Agora cada passo ocupa a largura que precisa, e é o
//       TRILHO que rola quando a soma não cabe.
//
//    5. `aria-current` NO PASSO ATUAL. É o que faz um leitor de
//       tela dizer "passo 3 de 6, atual" em vez de ler seis botões
//       iguais.
// ============================================================

import { Check, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface Step {
  readonly id: string;
  /** Uma ou duas palavras: o trilho é estreito. */
  readonly label: string;
  /** Aparece embaixo do título quando o passo está aberto. */
  readonly hint?: string;
  /** A frase do que falta. Marca o passo no trilho. */
  readonly problem?: string;
  /** O admin já mexeu neste passo. */
  readonly done?: boolean;
}

export interface StepsProps {
  readonly steps: readonly Step[];
  readonly current: string;
  readonly onGo: (id: string) => void;
  readonly className?: string;
}

export function Steps({ steps, current, onGo, className }: StepsProps) {
  return (
    <nav
      aria-label="Etapas"
      className={cn('overflow-x-auto border-b border-border bg-surface-2', className)}
    >
      <ol className="flex min-w-max">
        {steps.map((step, index) => {
          const active = step.id === current;
          const failed = step.problem !== undefined;

          return (
            <li key={step.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onGo(step.id)}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'flex w-full items-center gap-2 border-b-2 px-3 py-2 text-left transition-colors',
                  active
                    ? 'border-rust bg-surface'
                    : 'border-transparent hover:bg-surface hover:text-foreground',
                )}
              >
                <Marker index={index} active={active} done={step.done === true} failed={failed} />

                <span>
                  <span
                    className={cn(
                      'block whitespace-nowrap font-condensed text-2xs font-bold uppercase tracking-wide',
                      active ? 'text-foreground' : 'text-muted',
                    )}
                  >
                    {step.label}
                  </span>
                  {failed && (
                    // A frase do problema no trilho, e não só um
                    // ponto colorido: quem está no passo 6 precisa
                    // saber O QUE falta no passo 2. Ela tem teto
                    // próprio; o rótulo acima é que nunca corta.
                    <span className="block max-w-40 truncate text-2xs text-muted">
                      {step.problem}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Marker({
  index,
  active,
  done,
  failed,
}: {
  readonly index: number;
  readonly active: boolean;
  readonly done: boolean;
  readonly failed: boolean;
}) {
  if (failed) {
    return (
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center border border-amber text-amber"
      >
        <TriangleAlert className="h-3 w-3" />
      </span>
    );
  }

  if (done && !active) {
    return (
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center border border-olive text-olive"
      >
        <Check className="h-3 w-3" />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center border font-condensed text-2xs font-bold',
        active ? 'border-rust bg-rust text-white' : 'border-border text-muted',
      )}
    >
      {index + 1}
    </span>
  );
}

/**
 * O corpo de um passo.
 *
 * O título repetido aqui não é redundância: o trilho tem duas
 * palavras por passo, e é aqui que cabe a frase que diz o que se
 * decide nesta tela.
 */
export function StepBody({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="font-condensed text-sm font-bold uppercase tracking-wide">{title}</h3>
        {hint !== undefined && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>

      {children}
    </div>
  );
}
