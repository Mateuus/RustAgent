'use client';

// ============================================================
//  inventory-grid.tsx  -  onde cada item do kit nasce, desenhado
//  como o inventário do jogo.
//
//  ####  O PROBLEMA QUE ELE RESOLVE  ####
//
//  O slot e a posição sempre existiram no cadastro — como um
//  `<select>` e um campo numérico numa linha de tabela. Funcionava
//  para gravar, e não para DECIDIR: "belt, posição 3" só quer dizer
//  alguma coisa para quem consegue montar a barra rápida de cabeça.
//
//  Duas consequências, e as duas apareciam no jogo:
//
//    1. ninguém via que dois itens tinham pedido a mesma casinha,
//       porque o conflito mora em duas linhas distantes da tabela;
//    2. ninguém via que a "posição 9" de uma barra rápida de seis
//       casinhas não existe — o campo aceita qualquer número.
//
//  Na grade as duas coisas são visíveis antes de gravar, porque a
//  grade é o mesmo desenho que o jogador vê ao apertar TAB.
//
//  ####  ELA É UM MAPA, E NÃO O FORMULÁRIO INTEIRO  ####
//
//  Aqui se decide ONDE. Quantidade, skin e qual item continuam na
//  lista abaixo — são campos de texto, e campo de texto dentro de
//  uma casinha de 48 px é pior nos dois lugares. Clicar numa
//  casinha seleciona a linha correspondente; é esse o vínculo.
//
//  ####  ARRASTAR É A OPERAÇÃO PRINCIPAL  ####
//
//  Mover um item de lugar é o que se faz o tempo todo aqui, e
//  fazê-lo por dois campos numéricos (mudar o slot, depois a
//  posição) é trabalhoso o bastante para as pessoas simplesmente
//  não mexerem. O teclado continua chegando a tudo: a casinha é um
//  botão, e as setas da lista abaixo movem item a item.
// ============================================================

import { useState } from 'react';

import { CustomItemIcon, ItemIcon } from '@/components/item-icon';
import { findOurItem } from '@/components/item-choice';
import type { LoadoutItem, LoadoutSlot } from '@/lib/api';
import { useCustomItems } from '@/lib/hooks/use-custom-items';
import { cn } from '@/lib/utils';

/**
 * O tamanho de cada contêiner do jogador.
 *
 * ####  ESTES NÚMEROS SÃO DO JOGO  ####
 *
 * `containerMain` tem 24 casinhas em 6 colunas, `containerWear` 7,
 * `containerBelt` 6. Eles estão repetidos em
 * `core/src/game/ui-inventory.ts` — de propósito: são dois
 * processos distintos (o navegador e o agente) e nenhum importa do
 * outro. O que os mantém iguais é o teste do lado do agente, que
 * mede a grade contra estes mesmos números.
 */
export const CONTAINERS: readonly {
  readonly slot: LoadoutSlot;
  readonly label: string;
  readonly hint: string;
  readonly capacity: number;
  readonly columns: number;
}[] = [
  {
    slot: 'main',
    label: 'Mochila',
    hint: 'O inventário principal. É para onde o jogo manda o que não couber nos outros.',
    capacity: 24,
    columns: 6,
  },
  {
    slot: 'wear',
    label: 'Vestimenta',
    hint: 'Só aceita roupa e armadura. Qualquer outra coisa aqui cai na mochila na hora da entrega.',
    capacity: 7,
    columns: 7,
  },
  {
    slot: 'belt',
    label: 'Barra rápida',
    hint: 'As seis casinhas de acesso rápido. É onde a arma do kit deve nascer.',
    capacity: 6,
    columns: 6,
  },
];

/**
 * Um item do kit com o índice dele na lista.
 *
 * O índice é o que identifica a linha — o kit não tem id por item,
 * e a posição na grade muda justamente porque alguém a arrastou.
 */
export interface GridEntry {
  readonly item: LoadoutItem;
  readonly index: number;
}

/**
 * Move um item para outra casinha, trocando com quem já estava lá.
 *
 * ####  A CASINHA OCUPADA TROCA, E NÃO SUBSTITUI  ####
 *
 * Soltar sobre um item ocupado poderia: recusar, empurrar, ou
 * trocar os dois de lugar. Recusar faria a operação mais comum
 * ("quero estes dois invertidos") exigir três passos. Empurrar
 * mexeria em itens que ninguém tocou.
 *
 * Trocar é o que o próprio inventário do Rust faz — e é o gesto que
 * quem arrasta já conhece.
 */
export function swapInto(
  items: readonly LoadoutItem[],
  index: number,
  slot: LoadoutSlot,
  position: number,
): LoadoutItem[] {
  const moving = items[index];

  if (moving === undefined) {
    return [...items];
  }

  const occupant = items.findIndex(
    (item, other) => other !== index && item.slot === slot && item.position === position,
  );

  return items.map((item, other) => {
    if (other === index) {
      return { ...item, slot, position };
    }

    // O antigo dono da casinha herda o lugar de onde o outro saiu.
    // Sem isso ele ficaria empilhado sob o recém-chegado, e a tela
    // mostraria um item só.
    if (other === occupant) {
      return { ...item, slot: moving.slot, position: moving.position };
    }

    return item;
  });
}

/**
 * Quem a grade desenha, e quem ela não tem onde pôr.
 *
 * ####  DUAS CAUSAS PARA O MESMO DESFECHO  ####
 *
 * As duas acontecem com cadastro que o formulário antigo aceitava
 * sem reclamar:
 *
 *   1. a casinha não existe. O campo de posição aceita qualquer
 *      inteiro, e um kit antigo pode ter "posição 9" numa barra
 *      rápida de seis;
 *   2. a casinha já é de outro item do MESMO kit. Dois itens na
 *      posição 0 desenhariam um sobre o outro, e a tela mostraria
 *      um só.
 *
 * Sumir com eles seria o pior desfecho possível: eles CONTINUAM
 * sendo entregues. O jogo os põe na primeira casinha livre, e o
 * admin ficaria com um kit que entrega mais do que a tela mostra.
 */
export function layoutOf(
  items: readonly LoadoutItem[],
  slot: LoadoutSlot,
  capacity: number,
): { readonly drawn: ReadonlyMap<number, GridEntry>; readonly stray: readonly GridEntry[] } {
  const drawn = new Map<number, GridEntry>();
  const stray: GridEntry[] = [];

  for (const [index, item] of items.entries()) {
    if (item.slot !== slot) {
      continue;
    }

    const wanted = item.position;

    if (wanted >= 0 && wanted < capacity && !drawn.has(wanted)) {
      drawn.set(wanted, { item, index });
      continue;
    }

    stray.push({ item, index });
  }

  return { drawn, stray };
}

interface InventoryGridProps {
  readonly items: readonly LoadoutItem[];
  readonly onChange: (items: LoadoutItem[]) => void;
  readonly disabled?: boolean;
  /** Qual linha da lista está aberta. `null` = nenhuma. */
  readonly selected: number | null;
  readonly onSelect: (index: number | null) => void;
}

export function InventoryGrid({
  items,
  onChange,
  disabled = false,
  selected,
  onSelect,
}: InventoryGridProps) {
  // Qual casinha está sob o item arrastado. Só visual — o que vale
  // é o `drop`.
  const [over, setOver] = useState<string | null>(null);
  const { items: customItems } = useCustomItems();

  function moveTo(index: number, slot: LoadoutSlot, position: number): void {
    if (items[index] === undefined) {
      return;
    }

    onChange(swapInto(items, index, slot, position));
    onSelect(index);
  }

  return (
    <div className="space-y-4">
      {CONTAINERS.map((container) => {
        const { drawn, stray } = layoutOf(items, container.slot, container.capacity);
        const total = items.filter((item) => item.slot === container.slot).length;

        return (
          <section key={container.slot}>
            <header className="mb-1.5 flex items-baseline justify-between gap-2">
              <h4 className="text-2xs font-semibold uppercase tracking-wide text-foreground">
                {container.label}
              </h4>
              <span className="text-2xs text-muted">
                {total} de {container.capacity}
              </span>
            </header>

            <p className="mb-2 text-2xs leading-relaxed text-muted">{container.hint}</p>

            <div
              className="grid gap-1"
              style={{ gridTemplateColumns: `repeat(${String(container.columns)}, minmax(0, 48px))` }}
            >
              {Array.from({ length: container.capacity }, (_unused, position) => {
                const key = `${container.slot}-${String(position)}`;
                // O primeiro que pediu esta casinha fica com ela; os
                // outros estão em `stray`, e o aviso abaixo os conta.
                const entry = drawn.get(position);
                const ours =
                  entry === undefined
                    ? null
                    : findOurItem(customItems, entry.item.shortname, entry.item.skinId);

                return (
                  <button
                    key={key}
                    type="button"
                    disabled={disabled}
                    // A casinha vazia também é um alvo de soltura: é
                    // ela que faz a grade servir para POSICIONAR, e
                    // não só para conferir.
                    onDragOver={(event) => {
                      if (disabled) {
                        return;
                      }

                      // Sem o preventDefault o navegador não
                      // considera este elemento uma área de soltura,
                      // e o `drop` nunca dispara.
                      event.preventDefault();
                      setOver(key);
                    }}
                    onDragLeave={() => setOver((current) => (current === key ? null : current))}
                    onDrop={(event) => {
                      event.preventDefault();
                      setOver(null);

                      const dragged = Number(event.dataTransfer.getData('text/plain'));

                      if (Number.isInteger(dragged)) {
                        moveTo(dragged, container.slot, position);
                      }
                    }}
                    draggable={!disabled && entry !== undefined}
                    onDragStart={(event) => {
                      if (entry === undefined) {
                        return;
                      }

                      event.dataTransfer.setData('text/plain', String(entry.index));
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={() => onSelect(entry?.index ?? null)}
                    title={
                      entry === undefined
                        ? `${container.label}, casinha ${String(position + 1)} — vazia`
                        : `${entry.item.shortname} (${String(entry.item.amount)}x) — ${container.label}, casinha ${String(position + 1)}`
                    }
                    aria-label={
                      entry === undefined
                        ? `${container.label}, casinha ${String(position + 1)}, vazia`
                        : `${entry.item.shortname}, ${container.label}, casinha ${String(position + 1)}`
                    }
                    className={cn(
                      'relative flex h-12 w-12 items-center justify-center border transition-colors',
                      entry === undefined
                        ? 'border-border bg-background'
                        : 'border-border bg-surface-2 cursor-grab active:cursor-grabbing',
                      over === key && 'border-amber',
                      // O selecionado ganha a barra de acento, como
                      // o item aberto da coluna do ranking: sobre
                      // fundo escuro, clarear se confundiria com o
                      // hover.
                      entry !== undefined && selected === entry.index && 'border-rust',
                      disabled && 'opacity-60',
                    )}
                  >
                    {entry !== undefined &&
                      (ours === null ? (
                        <ItemIcon shortname={entry.item.shortname} size="sm" />
                      ) : (
                        <CustomItemIcon
                          iconFile={ours.iconFile}
                          baseShortname={ours.baseShortname}
                          size="sm"
                        />
                      ))}

                    {entry !== undefined && entry.item.amount > 1 && (
                      <span className="pointer-events-none absolute bottom-0 right-0.5 text-[9px] font-semibold leading-none text-foreground drop-shadow">
                        {entry.item.amount > 9999
                          ? `${String(Math.round(entry.item.amount / 1000))}k`
                          : entry.item.amount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {stray.length > 0 && (
              <p className="mt-2 border border-amber bg-surface-2 px-2 py-1.5 text-2xs leading-relaxed">
                <strong>
                  {stray.length === 1
                    ? 'Um item sem casinha própria aqui'
                    : `${String(stray.length)} itens sem casinha própria aqui`}
                </strong>{' '}
                — a posição não existe (esta {container.label.toLowerCase()} tem{' '}
                {container.capacity}) ou já é de outro item do kit:{' '}
                {stray.map((entry) => entry.item.shortname || '(sem item)').join(', ')}. Eles
                continuam sendo entregues; o jogo os põe na primeira casinha livre. Arraste-os para
                um lugar de verdade se quiser decidir onde.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
