'use client';

// ============================================================
//  loadout-editor.tsx  -  os itens de um kit, num lugar só.
//
//  Usado por DOIS donos: o loadout de um grupo (Configurações →
//  Loadouts) e o kit da Loja. Um kit É um loadout com regras de
//  entrega, e escrever dois editores de item faria os dois
//  divergirem no primeiro ajuste — o de slot, o de skin, o da
//  ordem.
//
//  ------------------------------------------------------------
//  ####  O ITEM SE ESCOLHE PELO NOME  ####
//
//  O campo VALE o shortname — é o que a entrega no jogo exige —
//  mas ninguém decora `wall.frame.garagedoor`. A busca é por nome,
//  com o ícone ao lado, e vem de `GET /api/items`: o catálogo mora
//  no agente, então ela funciona com os servidores parados, que é
//  quando alguém monta um kit.
//
//  Ver components/item-combobox.tsx. Ele carrega VINTE itens por
//  busca, e não o catálogo inteiro: são ~1250, e trazê-los todos
//  para o navegador a cada abertura de tela seria pagar por uma
//  lista que ninguém lê.
//
//  ####  O SLOT VALE PARA O LOADOUT; A LOJA ENTREGA NO
//        INVENTÁRIO  ####
//
//  `wear`, `belt` e `main` são os contêineres que o OrigemZPlayer
//  monta no NASCIMENTO. O kit da loja sai pelo `origemz.give`, que
//  não recebe slot — o dado continua guardado, e a tela diz isso
//  onde importa (o editor do kit).
// ============================================================

import { Plus, Trash2 } from 'lucide-react';


import { Button } from '@/components/ui/button';
import { ItemCombobox } from '@/components/item-combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { LoadoutItem, LoadoutSlot } from '@/lib/api';

/** Os três contêineres do jogador, com o nome que quem monta usa. */
const SLOTS: readonly { value: LoadoutSlot; label: string }[] = [
  { value: 'belt', label: 'Barra rápida' },
  { value: 'wear', label: 'Roupa' },
  { value: 'main', label: 'Mochila' },
];

/** O teto do agente (core/src/loadouts/items.ts). */
export const MAX_ITEMS = 60;

interface LoadoutEditorProps {
  readonly items: readonly LoadoutItem[];
  readonly onChange: (items: LoadoutItem[]) => void;
  readonly disabled?: boolean;
  /**
   * O slot é aplicado de verdade?
   *
   * No loadout, sim: o plugin monta o inventário no nascimento. No
   * kit da loja, não — o `origemz.give` entrega no inventário, e a
   * tela precisa dizer isso em vez de sugerir que a barra rápida
   * virá montada.
   */
  readonly slotApplies?: boolean;
}

export function LoadoutEditor({
  items,
  onChange,
  disabled = false,
  slotApplies = true,
}: LoadoutEditorProps) {

  function update(index: number, patch: Partial<LoadoutItem>): void {
    onChange(items.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  }

  function add(): void {
    onChange([
      ...items,
      {
        slot: 'belt',
        shortname: '',
        amount: 1,
        // "0" é "sem skin" — o mesmo que o plugin entende por
        // ausente. String, sempre.
        skinId: '0',
        // A posição segue a contagem do slot: dois itens no mesmo
        // lugar fazem o jogo decidir, e ninguém quer isso.
        position: items.filter((item) => item.slot === 'belt').length,
      },
    ]);
  }

  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <p className="border border-border bg-surface-2 px-3 py-3 text-2xs leading-relaxed text-muted">
          Nenhum item. Um kit vazio é uma escolha válida — ele apenas não entrega nada.
        </p>
      )}

      {items.map((item, index) => (
        <div
          key={`item-${String(index)}`}
          className="grid grid-cols-[1fr_auto] gap-2 border border-border bg-surface-2 p-2"
        >
          <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.8fr)]">
            <div>
              <Label>Item</Label>
              {/* ####  BUSCA POR NOME, COM O ÍCONE AO LADO  ####

                  O campo continua VALENDO o shortname — é o que a
                  entrega no jogo exige. O que mudou é como se chega
                  nele: digitando "assault" em vez de decorar
                  `rifle.ak`, e vendo a figura da arma antes de
                  escolher.

                  Digitar de cabeça é como o item errado entra num
                  kit que só vai ser conferido quando chegar ao
                  jogador. */}
              <ItemCombobox
                value={item.shortname}
                disabled={disabled}
                onValueChange={(shortname) => update(index, { shortname: shortname.trim() })}
              />
            </div>

            <div>
              <Label>Quantidade</Label>
              <Input
                type="number"
                min={1}
                value={item.amount}
                disabled={disabled}
                onChange={(event) =>
                  update(index, { amount: Math.max(1, Number(event.target.value)) })
                }
              />
            </div>

            <div>
              <Label>Slot</Label>
              <select
                value={item.slot}
                disabled={disabled}
                onChange={(event) => update(index, { slot: event.target.value as LoadoutSlot })}
                className="h-9 w-full border border-border bg-surface px-2 text-sm text-foreground"
              >
                {SLOTS.map((slot) => (
                  <option key={slot.value} value={slot.value}>
                    {slot.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label>Skin</Label>
              {/* type="text", e não "number": a skin passa de 2^53 e
                  um campo numérico a devolveria arredondada. */}
              <Input
                type="text"
                inputMode="numeric"
                value={item.skinId}
                placeholder="0"
                disabled={disabled}
                onChange={(event) => update(index, { skinId: event.target.value.replace(/\D/g, '') })}
                className="font-mono"
              />
            </div>

            <div>
              <Label>Posição</Label>
              <Input
                type="number"
                min={0}
                value={item.position}
                disabled={disabled}
                onChange={(event) =>
                  update(index, { position: Math.max(0, Number(event.target.value)) })
                }
              />
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remover ${item.shortname === '' ? 'este item' : item.shortname}`}
            disabled={disabled}
            onClick={() => onChange(items.filter((_, position) => position !== index))}
            className="self-start text-muted"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || items.length >= MAX_ITEMS}
          onClick={add}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          Acrescentar item
        </Button>

        <span className="text-2xs text-muted">
          {items.length} de {MAX_ITEMS} itens
        </span>
      </div>

      <p className="border border-border bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-muted">
        Busque pelo <strong>nome do jogo</strong>, em inglês (&ldquo;assault&rdquo;,
        &ldquo;wood&rdquo;, &ldquo;medical&rdquo;) e escolha na lista — o ícone ao lado confirma que
        é o item certo. O que fica gravado é o <strong>shortname</strong> (<code>rifle.ak</code>),
        que é o que a entrega no jogo exige.
      </p>

      <p className="text-2xs leading-relaxed text-muted">
        O catálogo vem do jogo e mora no agente, então a busca funciona com os servidores parados.
        Um shortname digitado à mão continua valendo — o servidor recusa na entrega o que não
        existir.
      </p>

      {!slotApplies && (
        <p className="border border-amber bg-surface-2 px-3 py-2 text-2xs leading-relaxed">
          <strong>O slot não vale para a entrega da loja.</strong> O comando que entrega item a um
          jogador conectado põe tudo no inventário — quem monta roupa e barra rápida é o caminho do
          nascimento, que é o do loadout. O slot fica guardado do mesmo jeito.
        </p>
      )}
    </div>
  );
}

/**
 * O que a tela precisa recusar ANTES de mandar.
 *
 * O agente recusa também (é ele que conhece a regra), mas um
 * formulário que só descobre o item vazio depois do POST faz a
 * pessoa perder o que digitou nos outros campos.
 */
export function itemsProblem(items: readonly LoadoutItem[]): string | null {
  if (items.some((item) => item.shortname.trim() === '')) {
    return 'Há item sem shortname. Ele não viraria item nenhum no jogo — preencha ou remova a linha.';
  }

  if (items.length > MAX_ITEMS) {
    return `São no máximo ${String(MAX_ITEMS)} itens por kit.`;
  }

  return null;
}
