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
//  ####  O SLOT VALE NOS DOIS CAMINHOS DESDE 14/09/2026  ####
//
//  `wear`, `belt` e `main` são os contêineres que o OrigemZPlayer
//  monta no NASCIMENTO — e, desde que o `origemz.give` passou a
//  aceitar slot e casinha, também o que o resgate de um kit
//  respeita. Até então o editor guardava os dois campos e ninguém
//  os lia; a tela dizia isso num aviso, que saiu junto.
//
//  ####  A GRADE É O MAPA; A LISTA É O FORMULÁRIO  ####
//
//  Onde o item nasce se decide arrastando, na grade — "belt,
//  posição 3" só quer dizer alguma coisa para quem monta a barra
//  rápida de cabeça. O que ele É (qual item, quanto, qual skin)
//  continua na lista: são campos de texto, e campo de texto numa
//  casinha de 48 px é pior nos dois lugares.
// ============================================================

import { useState } from 'react';

import { Plus, Trash2 } from 'lucide-react';

import { InventoryGrid } from '@/components/inventory-grid';
import { findOurItem, NO_SKIN } from '@/components/item-choice';
import { Button } from '@/components/ui/button';
import { ItemCombobox } from '@/components/item-combobox';
import { SkinInput } from '@/components/skin-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { LoadoutItem, LoadoutSlot } from '@/lib/api';
import { useCustomItems } from '@/lib/hooks/use-custom-items';

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
  /**
   * Em qual servidor este kit vai nascer.
   *
   * O loadout de um grupo é DE um servidor e passa o id; o kit da
   * Loja é da rede e não passa. Sem ele, o seletor mostra os itens
   * nossos de todos os servidores — e diz isso.
   */
  readonly serverId?: string;
}

export function LoadoutEditor({
  items,
  onChange,
  disabled = false,
  slotApplies = true,
  serverId,
}: LoadoutEditorProps) {
  // Para reconhecer a marca de uma linha já gravada e travar a
  // skin dela. Ver `findOurItem`.
  const { items: customItems } = useCustomItems();

  // Qual linha a grade está apontando. É só destaque: o dado mora
  // em `items`, e recarregar a tela não perde nada de verdade.
  const [selected, setSelected] = useState<number | null>(null);

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

      {/* ####  O MAPA VEM ANTES DA LISTA  ####

          Quem abre este editor está montando um kit, e a primeira
          pergunta é "como ele fica". A lista responde "o que ele
          tem" — importante, e depois. */}
      {items.length > 0 && (
        <div className="border border-border bg-surface-2 p-3">
          <p className="mb-3 text-2xs leading-relaxed text-muted">
            Arraste para escolher onde cada item nasce. Soltar sobre uma casinha ocupada{' '}
            <strong>troca</strong> os dois de lugar, como no inventário do jogo. Clique numa
            casinha para abrir a linha dele abaixo.
          </p>

          <InventoryGrid
            items={items}
            onChange={onChange}
            disabled={disabled}
            selected={selected}
            onSelect={setSelected}
          />
        </div>
      )}

      {items.map((item, index) => (
        <div
          key={`item-${String(index)}`}
          className={`grid grid-cols-[1fr_auto] gap-2 border bg-surface-2 p-2 ${
            selected === index ? 'border-rust' : 'border-border'
          }`}
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
                {...(serverId === undefined ? {} : { serverId })}
                onValueChange={(shortname) => update(index, { shortname: shortname.trim() })}
                onChoiceChange={(choice) => {
                  // A skin vem JUNTO: um item nosso sem a marca é o
                  // corpo emprestado cru, e o kit nasceria com uma
                  // taça de discord no lugar do troféu.
                  if (choice !== null) {
                    update(index, { shortname: choice.shortname, skinId: choice.skinId });
                  }
                }}
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
              <SkinInput
                value={item.skinId}
                label="Skin"
                disabled={disabled}
                showHint={false}
                lockedBy={findOurItem(customItems, item.shortname, item.skinId)}
                onChange={(skinId) => update(index, { skinId: skinId || NO_SKIN })}
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
            onClick={() => {
              // A seleção é um ÍNDICE, e remover uma linha renumera
              // todas as seguintes. Sem isto, apagar a linha 2
              // deixaria a grade apontando para o que era a 3 —
              // destaque na casinha errada, sem nada explicando.
              setSelected(null);
              onChange(items.filter((_, position) => position !== index));
            }}
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
        <p className="border border-border bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-muted">
          A casinha é uma <strong>preferência</strong>, e não uma exigência: o inventário é do
          jogador, e ele pode ter enchido a barra rápida antes de resgatar. Ocupada a casinha, o
          jogo põe o item em outra do mesmo contêiner — e, se não houver nenhuma, na mochila.
          Ninguém perde item por causa disso.
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
