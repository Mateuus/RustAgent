'use client';

// ============================================================
//  help-tip.tsx  -  o (?) que explica um campo.
//
//  ####  `<button>`, E NÃO `title=""`  ####
//
//  O `title` do navegador não abre pelo teclado, não abre no
//  celular, some sozinho em poucos segundos e não é lido por
//  leitor de tela em vários navegadores. Ele parece a solução
//  barata e é uma dica que metade das pessoas nunca vê.
//
//  Aqui são duas camadas na mesma peça:
//
//    passar o mouse (ou focar)  →  a frase curta, uma linha
//    clicar                     →  o texto longo, no modal
//
//  ####  A BOLHA É `fixed`, E ISSO NÃO É DETALHE  ####
//
//  MEDIDO em 09/09/2026: com `absolute`, ela era CORTADA pelo
//  `overflow-y-auto` do corpo do modal e ficava ATRÁS do que
//  estivesse por perto. Um `(?)` perto da borda esquerda jogava
//  metade do texto para fora da tela.
//
//  `position: fixed` tira a bolha do fluxo — nenhum `overflow` de
//  ancestral a corta —, e a posição é MEDIDA no momento de abrir,
//  presa dentro da janela. Duas contas, e o problema inteiro
//  desaparece.
//
//  Dentro de um `<dialog>` modal isso continua valendo: a bolha é
//  descendente do diálogo, que está no top layer.
//
//  ####  O TEXTO NÃO MORA AQUI  ####
//
//  Ele vem de um registro (`lib/help/*`), por três razões: o mesmo
//  conceito aparece em três telas e tem de dizer a mesma coisa;
//  dá para revisar a redação inteira sem abrir seis componentes; e
//  é o que torna possível a tela de ajuda que se monta sozinha.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §12.2 e §12.3.
// ============================================================

import { HelpCircle } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** Um verbete. As quatro partes do §12.4, e nenhuma é opcional. */
export interface HelpTopic {
  readonly title: string;
  /** Uma linha. É o que aparece ao passar o mouse. */
  readonly short: string;
  /** O texto longo do modal: o que é, um exemplo com número, o limite. */
  readonly body: ReactNode;
}

export interface HelpTipProps {
  readonly topic: HelpTopic;
  readonly className?: string;
}

/** A largura da bolha, em px. Fixa, para a conta de borda ser exata. */
const BUBBLE_WIDTH = 240;

/** A folga mínima até a borda da janela. */
const EDGE = 8;

export function HelpTip({ topic, className }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const [bubble, setBubble] = useState<{ left: number; top: number } | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);

  /**
   * Onde a bolha cabe.
   *
   * Centrada no `(?)`, e então empurrada para dentro da janela nos
   * dois lados. Se não couber embaixo, ela sobe — é o caso do `(?)`
   * na última linha de um formulário longo.
   */
  const place = useCallback(() => {
    const element = anchor.current;

    if (element === null) return;

    const rect = element.getBoundingClientRect();
    const half = BUBBLE_WIDTH / 2;

    const wanted = rect.left + rect.width / 2 - half;
    const maxLeft = window.innerWidth - BUBBLE_WIDTH - EDGE;

    // Aproximação da altura: a bolha tem duas linhas curtas. Errar
    // um pouco aqui só decide se ela abre para cima cedo demais.
    const estimatedHeight = 72;
    const below = rect.bottom + 6;
    const fitsBelow = below + estimatedHeight < window.innerHeight - EDGE;

    setBubble({
      left: Math.max(EDGE, Math.min(wanted, Math.max(EDGE, maxLeft))),
      top: fitsBelow ? below : Math.max(EDGE, rect.top - estimatedHeight - 6),
    });
  }, []);

  return (
    <>
      <span className="inline-flex">
        <button
          ref={anchor}
          type="button"
          onClick={() => setOpen(true)}
          onPointerEnter={place}
          onPointerLeave={() => setBubble(null)}
          onFocus={place}
          onBlur={() => setBubble(null)}
          aria-label={`Ajuda sobre ${topic.title}`}
          className={cn(
            'inline-flex h-4 w-4 items-center justify-center text-muted transition-colors',
            'hover:text-amber focus-visible:text-amber',
            className,
          )}
        >
          <HelpCircle aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </span>

      {bubble !== null && (
        <span
          role="tooltip"
          style={{ left: bubble.left, top: bubble.top, width: BUBBLE_WIDTH }}
          // `z-[60]` fica acima dos toasts (z-50) do painel. E
          // `pointer-events-none` para a bolha nunca roubar o
          // clique do que está embaixo dela.
          className={cn(
            'pointer-events-none fixed z-[60]',
            'border border-border bg-surface-2 px-2 py-1.5 text-2xs leading-snug text-foreground',
            'shadow-[0_2px_12px_rgba(0,0,0,0.6)]',
          )}
        >
          {topic.short}
          <span className="mt-1 block text-muted">Clique para o texto inteiro.</span>
        </span>
      )}

      <Dialog open={open} title={topic.title} onClose={() => setOpen(false)}>
        <div className="space-y-3 text-sm leading-relaxed text-foreground">{topic.body}</div>
      </Dialog>
    </>
  );
}

/**
 * Um rótulo com o `(?)` ao lado.
 *
 * Existe para que a distância entre o texto e o ícone seja a mesma
 * em toda tela — trinta campos com espaçamentos ligeiramente
 * diferentes é o tipo de coisa que ninguém aponta e todo mundo
 * sente.
 */
export function FieldLabel({
  children,
  topic,
  htmlFor,
  className,
}: {
  readonly children: ReactNode;
  readonly topic?: HelpTopic;
  readonly htmlFor?: string;
  readonly className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        'flex items-center gap-1.5 font-condensed text-2xs uppercase tracking-wide text-muted',
        className,
      )}
    >
      {children}
      {topic !== undefined && <HelpTip topic={topic} />}
    </label>
  );
}

/** Um exemplo com número, dentro do modal. */
export function HelpExample({ children }: { readonly children: ReactNode }) {
  return (
    <p className="border-l-2 border-olive bg-surface-2 px-3 py-2 text-xs">
      <span className="font-condensed uppercase tracking-wide text-muted">Por exemplo: </span>
      {children}
    </p>
  );
}

/**
 * O limite prático, e o sintoma de passar dele.
 *
 * É a parte que falta em toda documentação de plugin de Rust, e a
 * que o admin precisa às duas da manhã. Borda em `--amber` e texto
 * em `--text`: o token de aviso não tem contraste para texto
 * corrido (3.7:1), e é regra do design system que a cor fique no
 * ícone e na borda.
 */
export function HelpWarn({ children }: { readonly children: ReactNode }) {
  return (
    <p className="border-l-2 border-amber bg-surface-2 px-3 py-2 text-xs">
      <span className="font-condensed uppercase tracking-wide text-muted">Se exagerar: </span>
      {children}
    </p>
  );
}
