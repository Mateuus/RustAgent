'use client';

// ============================================================
//  betterloot-multiplier-menu.tsx  -  um botão que abre os
//  atalhos de multiplicador.
//
//  ####  UM COMPONENTE, DOIS ALCANCES, E CONFUNDI-LOS É O ERRO
//  ####  CARO
//
//  Ele aparece em dois lugares desta página, e as duas operações
//  não têm nada a ver uma com a outra:
//
//    · na faixa de topo, ele DEFINE o multiplicador do servidor
//      inteiro (`Loot Multiplier`, `Scrap Multipler`);
//    · dentro de uma caixa, ele MULTIPLICA a quantidade de cada
//      item daquela caixa — e não sai dela.
//
//  Aplicar o segundo achando que é o primeiro reescreve 145
//  entradas; aplicar o primeiro achando que é o segundo muda o
//  loot de 111 contêineres de uma vez. Por isso `scope` é uma prop
//  OBRIGATÓRIA e aparece em negrito no topo do menu: não dá para
//  montar este controle sem dizer até onde ele vai.
//
//  ####  POR QUE UM MENU, E NÃO TRÊS BOTÕES NA TELA  ####
//
//  Pedido do dono, e ele tem razão: a faixa de topo já carrega
//  quatro indicadores, e `2x` `5x` `10x` `outro` soltos ao lado de
//  cada um seriam doze botões numa faixa que existe para ser lida.
//
//  ####  E O CAMPO LIVRE FICA DENTRO  ####
//
//  Os atalhos cobrem o comum, não o que o admin quer: um servidor
//  3x não está entre 2, 5 e 10. Sem o campo, ele clicaria em 2 e
//  corrigiria à mão — que é o caminho mais longo para o mesmo
//  lugar.
//
//  É por causa dele que isto é `role="dialog"` e não `role="menu"`:
//  um `menuitem` não comporta campo de digitação, e um leitor de
//  tela anunciaria um menu em que a tecla de seta não anda.
// ============================================================

import { ChevronDown, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface MultiplierMenuProps {
  /** O texto do botão. Ex.: "Multiplicar…". */
  readonly text: string;
  /** Para o leitor de tela: qual dos dois menus é este. */
  readonly label: string;
  /**
   * Até onde isto vai, em uma frase curta.
   *
   * Aparece em negrito no topo do menu. Ver o cabeçalho: é a prop
   * que impede os dois usos de virarem o mesmo controle.
   */
  readonly scope: string;
  /** O que acontece ao escolher. Uma frase, abaixo do escopo. */
  readonly hint: string;
  readonly shortcuts: readonly number[];
  /** Como cada atalho se lê. Ex.: `(n) => "2× em itens e scrap"`. */
  readonly shortcutLabel: (factor: number) => string;
  readonly customLabel: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly busy: boolean;
  readonly onApply: (factor: number) => void;
}

export function BetterLootMultiplierMenu({
  text,
  label,
  scope,
  hint,
  shortcuts,
  shortcutLabel,
  customLabel,
  min,
  max,
  step,
  busy,
  onApply,
}: MultiplierMenuProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // ####  ELE NASCE DENTRO DE UMA COLUNA QUE ROLA  ####
  //
  // O editor de caixa tem `overflow-y-auto` próprio, e este menu é
  // alto: aberto com a lista de 145 itens rolada, ele é CORTADO
  // pela borda de baixo — e some justamente o campo livre, que é o
  // último. `block: 'nearest'` rola o mínimo para ele caber, e não
  // faz nada quando já cabe. É o mesmo remédio do `ActionMenu`.
  useEffect(() => {
    if (open) {
      panelRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [open]);

  // ####  FECHAR É PARTE DO CONTRATO  ####
  //
  // Um menu que fica aberto depois do clique fora vira lixo na tela
  // e rouba o clique seguinte. O foco volta para o botão no Escape,
  // senão quem navega por teclado é jogado para o começo da página.
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const apply = (factor: number): void => {
    setOpen(false);
    setCustom('');
    onApply(factor);
  };

  const parsedCustom = Number.parseFloat(custom.replace(',', '.'));
  // O campo vazio não é um valor inválido — é um campo vazio. Sem
  // esta separação, abrir o menu já mostraria o botão de aplicar
  // desligado, como se algo estivesse errado.
  const customUsable =
    custom.trim() !== '' &&
    Number.isFinite(parsedCustom) &&
    parsedCustom >= min &&
    parsedCustom <= max;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={busy}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className={cn(
          'flex h-7 items-center justify-center gap-1.5 border border-border px-3',
          'font-condensed text-2xs font-bold uppercase tracking-wide text-muted transition',
          'hover:border-foreground hover:text-foreground',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1',
          open && 'border-foreground text-foreground',
          busy && 'cursor-not-allowed opacity-50',
        )}
      >
        {text}
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          className="absolute right-0 z-20 mt-1 w-72 border border-border bg-surface p-3 shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-2xs font-bold leading-snug text-foreground">{scope}</p>
            <button
              type="button"
              aria-label="Fechar"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
              className="shrink-0 text-muted hover:text-foreground"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>

          <p className="mt-1 text-[10px] leading-relaxed text-muted">{hint}</p>

          <div className="mt-2 space-y-1">
            {shortcuts.map((factor) => (
              <button
                key={factor}
                type="button"
                onClick={() => {
                  apply(factor);
                }}
                className={cn(
                  'flex w-full items-center gap-2 border border-border px-2 py-1.5',
                  'text-left text-xs text-foreground transition',
                  'hover:border-foreground hover:bg-surface-2',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1',
                )}
              >
                <span className="font-condensed font-bold tabular-nums">{factor}×</span>
                <span className="min-w-0 flex-1 truncate text-2xs text-muted">
                  {shortcutLabel(factor)}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-2 border-t border-border pt-2">
            <label className="block text-[10px] uppercase tracking-wider text-muted">
              {customLabel}
            </label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                type="number"
                min={min}
                max={max}
                step={step}
                value={custom}
                aria-label={customLabel}
                placeholder={String(min)}
                onChange={(event) => {
                  setCustom(event.target.value);
                }}
                onKeyDown={(event) => {
                  // Enter aplica: o campo é o último controle do
                  // menu, e obrigar o mouse depois de digitar é o
                  // tipo de atrito que faz voltar ao campo à mão.
                  if (event.key === 'Enter' && customUsable) {
                    event.preventDefault();
                    apply(parsedCustom);
                  }
                }}
                className="h-7 w-20 px-1 text-center text-2xs"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!customUsable}
                onClick={() => {
                  apply(parsedCustom);
                }}
              >
                Aplicar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
