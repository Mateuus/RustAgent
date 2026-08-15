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
//  ####  O CATÁLOGO DE ITENS AINDA PODE NÃO EXISTIR  ####
//
//  A busca por nome ("Assault Rifle") vem de `GET /api/items`, que
//  outra frente está construindo. Enquanto ela não existir, o campo
//  aceita o SHORTNAME digitado e a tela DIZ por quê — em vez de
//  mostrar um seletor vazio que parece defeito.
//
//  O catálogo é consumido por HTTP, aqui na tela, e nunca por
//  import: uma dependência de código entre duas branches em
//  paralelo é o que impede as duas de compilar sozinhas.
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
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, type LoadoutItem, type LoadoutSlot } from '@/lib/api';

/** Os três contêineres do jogador, com o nome que quem monta usa. */
const SLOTS: readonly { value: LoadoutSlot; label: string }[] = [
  { value: 'belt', label: 'Barra rápida' },
  { value: 'wear', label: 'Roupa' },
  { value: 'main', label: 'Mochila' },
];

/** O teto do agente (core/src/loadouts/items.ts). */
export const MAX_ITEMS = 60;

/**
 * Um item do catálogo, como esta tela precisa vê-lo.
 *
 * Deliberadamente mínimo: o formato completo é da outra frente, e
 * depender de mais campos do que estes faria a tela quebrar a cada
 * ajuste no catálogo dela.
 */
interface CatalogItem {
  readonly shortname: string;
  readonly name?: string;
}

/**
 * O catálogo, se ele já existir.
 *
 * `available` nasce `null` (ninguém perguntou ainda), vira `true`
 * quando a rota responde no formato esperado e `false` quando ela
 * não existe — e é esse último estado que faz a tela EXPLICAR em
 * vez de parecer quebrada.
 */
function useItemCatalog(): { items: CatalogItem[]; available: boolean | null } {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await api<{ items?: CatalogItem[] }>('/api/items?limit=2000');

        if (cancelled) {
          return;
        }

        // A rota é da outra frente: se o formato não for o que
        // esperamos, a tela cai para o campo digitado em vez de
        // quebrar.
        if (!Array.isArray(response.items)) {
          setAvailable(false);
          return;
        }

        setItems(response.items.filter((item) => typeof item.shortname === 'string'));
        setAvailable(true);
      } catch {
        // 404 enquanto o catálogo não existe. Não é erro da tela.
        if (!cancelled) {
          setAvailable(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { items, available };
}

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
  const catalog = useItemCatalog();

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
              <Input
                // O `list` só tem efeito quando o catálogo existe;
                // sem ele, o campo continua sendo texto livre.
                list={catalog.available === true ? 'catalogo-de-itens' : undefined}
                value={item.shortname}
                placeholder="rifle.ak"
                disabled={disabled}
                onChange={(event) => update(index, { shortname: event.target.value.trim() })}
                className="font-mono"
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

      {catalog.available === true && (
        <datalist id="catalogo-de-itens">
          {catalog.items.map((option) => (
            <option key={option.shortname} value={option.shortname}>
              {option.name ?? option.shortname}
            </option>
          ))}
        </datalist>
      )}

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

      {catalog.available === false && (
        <p className="border border-border bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-muted">
          O campo aceita o <strong>shortname</strong> do item, como o jogo o conhece (
          <code>rifle.ak</code>, <code>wood</code>, <code>metal.refined</code>). A busca por nome
          chega junto com o catálogo de itens, que está sendo construído — até lá, o shortname
          digitado é o que vale, e o servidor recusa na entrega o que não existir.
        </p>
      )}

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
