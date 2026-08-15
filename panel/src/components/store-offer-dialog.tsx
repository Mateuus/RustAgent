'use client';

// ============================================================
//  store-offer-dialog.tsx  -  criar e editar uma oferta da loja.
//
//  ####  O FORMULÁRIO MUDA COM O FORMATO  ####
//
//    item     um item do jogo, com quantidade por compra
//    bundle   um kit: a lista do que vem dentro
//    vip      o nível, o prazo e as vantagens em texto
//    vehicle  o prefab e o combustível
//
//  Mostrar os campos dos quatro ao mesmo tempo faria o admin
//  preencher "dias de VIP" numa oferta de sucata — e o agente
//  aceitaria, porque as colunas são anuláveis. O formulário some com
//  o que não se aplica; a API recusa o resto.
//
//  ####  O ÍCONE VEM DO CATÁLOGO, NÃO DA DIGITAÇÃO  ####
//
//  O CUI desenha o ícone a partir do `itemId`, que ninguém decora.
//  Escolher pelo nome no catálogo é o que garante que o número
//  esteja certo — digitado à mão, o erro só aparece como quadrado
//  vazio na tela do jogador.
//
//  ####  O PREÇO É EM OZCOIN INTEIRO  ####
//
//  A moeda não tem centavo. O campo recusa decimal em vez de
//  arredondar em silêncio: 19,90 viraria 19 ou 20, e as duas
//  respostas estão erradas para quem definiu o preço.
// ============================================================

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { ItemCombobox } from '@/components/item-combobox';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import {
  agent,
  type CatalogItem,
  type OfferBadge,
  type OfferItem,
  type OfferKind,
  type StoreCategory,
  type StoreOffer,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const KINDS: readonly { value: OfferKind; label: string; hint: string }[] = [
  { value: 'item', label: 'Item', hint: 'um item do jogo; o jogador escolhe quantos leva' },
  { value: 'bundle', label: 'Kit', hint: 'vários itens numa compra; o modal lista o que vem' },
  { value: 'vip', label: 'VIP', hint: 'um nível com prazo, mais as vantagens que você listar' },
  { value: 'vehicle', label: 'Veículo', hint: 'nasce ao lado do jogador, se houver espaço' },
];

const BADGES: readonly { value: OfferBadge | ''; label: string }[] = [
  { value: '', label: 'sem etiqueta' },
  { value: 'promo', label: 'PROMO' },
  { value: 'novo', label: 'NOVO' },
  { value: 'destaque', label: 'DESTAQUE' },
];

interface StoreOfferDialogProps {
  readonly open: boolean;
  /** `null` = criar. Preenchido = editar aquela oferta. */
  readonly offer: StoreOffer | null;
  readonly categories: readonly StoreCategory[];
  /** A categoria aberta na tela, quando se está criando. */
  readonly categoryId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function StoreOfferDialog({
  open,
  offer,
  categories,
  categoryId,
  onClose,
  onDone,
}: StoreOfferDialogProps) {
  const [kind, setKind] = useState<OfferKind>(offer?.kind ?? 'item');
  const [category, setCategory] = useState(offer?.categoryId ?? categoryId);
  const [name, setName] = useState(offer?.name ?? '');
  const [price, setPrice] = useState(String(offer?.price ?? 100));
  const [oldPrice, setOldPrice] = useState(
    offer?.oldPrice === null || offer?.oldPrice === undefined ? '' : String(offer.oldPrice),
  );
  const [badge, setBadge] = useState<OfferBadge | ''>(offer?.badge ?? '');
  const [position, setPosition] = useState(offer?.position ?? 0);
  const [enabled, setEnabled] = useState(offer?.enabled ?? true);

  const [icon, setIcon] = useState(offer?.icon ?? { shortname: '', itemId: 0, skinId: '0' });

  const [items, setItems] = useState<OfferItem[]>(offer === null ? [] : [...offer.items]);
  const [perks, setPerks] = useState<string[]>(offer === null ? [] : [...offer.perks]);

  const [tier, setTier] = useState(offer?.vip?.tier ?? '');
  const [days, setDays] = useState(
    offer?.vip?.days === null || offer?.vip?.days === undefined ? '30' : String(offer.vip.days),
  );
  const [prefab, setPrefab] = useState(offer?.vehicle?.prefab ?? '');
  const [fuel, setFuel] = useState(offer?.vehicle?.fuel ?? 0);

  const [busy, setBusy] = useState(false);

  /**
   * Escolher o ícone também preenche o primeiro item.
   *
   * Numa oferta de ITEM os dois são a mesma coisa em quase todo caso,
   * e fazer o admin escolher a AK duas vezes é o tipo de repetição
   * que termina com os dois campos apontando para coisas diferentes.
   */
  function chooseIcon(item: CatalogItem | null): void {
    if (item === null) {
      return;
    }

    setIcon({ shortname: item.shortname, itemId: item.itemId, skinId: '0' });

    if (kind === 'item' && items.length === 0) {
      setItems([{ shortname: item.shortname, itemId: item.itemId, skinId: '0', amount: 1 }]);
    }
  }

  function updateItem(index: number, patch: Partial<OfferItem>): void {
    setItems((current) =>
      current.map((item, current2) => (current2 === index ? { ...item, ...patch } : item)),
    );
  }

  async function submit(): Promise<void> {
    const problem = offerProblem({ kind, name, icon, items, tier, prefab, price, oldPrice });

    if (problem !== null) {
      toast.error('Confira a oferta', { description: problem });

      return;
    }

    const body = {
      categoryId: category,
      kind,
      name: name.trim(),
      price: Number(price),
      oldPrice: oldPrice.trim() === '' ? null : Number(oldPrice),
      position,
      enabled,
      badge: badge === '' ? null : badge,
      icon,
      items,
      perks: kind === 'vip' ? perks.filter((perk) => perk.trim() !== '') : [],
      vip:
        kind === 'vip'
          ? { tier: tier.trim(), days: days.trim() === '' ? null : Number(days) }
          : null,
      vehicle: kind === 'vehicle' ? { prefab: prefab.trim(), fuel } : null,
    };

    setBusy(true);

    try {
      if (offer === null) {
        await agent.createStoreOffer(body);
      } else {
        await agent.updateStoreOffer(offer.id, body);
      }

      toast.success(offer === null ? 'Oferta criada' : 'Oferta gravada', {
        description: `"${body.name}" está em ${categoryName(categories, category)}.`,
      });

      onDone();
      onClose();
    } catch (cause) {
      toast.error('Não consegui gravar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={offer === null ? 'Nova oferta' : `Oferta ${offer.name}`}
      busy={busy}
      onClose={onClose}
      className="w-[min(54rem,94vw)]"
    >
      <div className="space-y-3">
        {/* ---- o formato ---- */}
        <div>
          <Label>O que esta oferta entrega</Label>

          <div className="flex flex-wrap items-stretch border border-border">
            {KINDS.map((option, index) => (
              <div key={option.value} className="flex items-stretch">
                {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                <button
                  type="button"
                  aria-pressed={kind === option.value}
                  disabled={busy}
                  onClick={() => setKind(option.value)}
                  className={cn(
                    'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                    kind === option.value
                      ? 'bg-surface-2 text-foreground'
                      : 'text-muted hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              </div>
            ))}
          </div>

          <p className="mt-1 text-2xs text-muted">
            {KINDS.find((option) => option.value === kind)?.hint}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Nome na vitrine</Label>
            <Input
              value={name}
              placeholder={kind === 'vip' ? 'VIP Ouro · 30 dias' : 'Assault Rifle'}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div>
            <Label>Categoria</Label>
            <select
              value={category}
              disabled={busy}
              onChange={(event) => setCategory(event.target.value)}
              className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
            >
              {categories.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* ---- o ícone ---- */}
        <div>
          <Label>Ícone na vitrine</Label>

          <ItemCombobox
            value={icon.shortname}
            disabled={busy}
            onValueChange={(shortname) => setIcon((current) => ({ ...current, shortname }))}
            onItemChange={chooseIcon}
          />

          <p className="mt-1 text-2xs leading-relaxed text-muted">
            É o desenho que o jogo mostra no card. Um kit não tem &ldquo;o item&rdquo; — escolha o
            que representa melhor o pacote.
          </p>
        </div>

        {/* ---- preço ---- */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>Preço em OZ</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={price}
              disabled={busy}
              onChange={(event) => setPrice(event.target.value)}
              className="font-mono"
            />
          </div>

          <div>
            <Label>Preço antigo</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={oldPrice}
              placeholder="—"
              disabled={busy}
              onChange={(event) => setOldPrice(event.target.value)}
              className="font-mono"
            />
            <p className="mt-1 text-2xs text-muted">Riscado ao lado. Precisa ser MAIOR.</p>
          </div>

          <div>
            <Label>Etiqueta</Label>
            <select
              value={badge}
              disabled={busy}
              onChange={(event) => setBadge(event.target.value as OfferBadge | '')}
              className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
            >
              {BADGES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* ---- VIP ---- */}
        {kind === 'vip' && (
          <div className="space-y-3 border-l-2 border-l-amber pl-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Nível concedido</Label>
                <Input
                  value={tier}
                  placeholder="gold"
                  disabled={busy}
                  onChange={(event) => setTier(event.target.value.toLowerCase())}
                  className="font-mono"
                />
                <p className="mt-1 text-2xs text-muted">
                  O mesmo nome do <code>OrigemZVip.json</code> daquele servidor.
                </p>
              </div>

              <div>
                <Label>Dias</Label>
                <Input
                  type="number"
                  min={1}
                  value={days}
                  placeholder="vitalício"
                  disabled={busy}
                  onChange={(event) => setDays(event.target.value)}
                />
                <p className="mt-1 text-2xs text-muted">
                  Em branco = vitalício. Comprar duas vezes SOMA o tempo.
                </p>
              </div>
            </div>

            <div>
              <Label>O que o jogador ganha</Label>

              <ul className="space-y-1">
                {perks.map((perk, index) => (
                  <li key={index} className="flex items-center gap-2">
                    <Input
                      value={perk}
                      placeholder="fila prioritária"
                      disabled={busy}
                      onChange={(event) =>
                        setPerks((current) =>
                          current.map((item, current2) =>
                            current2 === index ? event.target.value : item,
                          ),
                        )
                      }
                    />

                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Remover vantagem"
                      disabled={busy}
                      onClick={() =>
                        setPerks((current) => current.filter((_unused, i) => i !== index))
                      }
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>

              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                className="mt-2"
                onClick={() => setPerks((current) => [...current, ''])}
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                Vantagem
              </Button>

              <p className="mt-1 text-2xs leading-relaxed text-muted">
                Elas aparecem no modal, antes dos itens. São <strong>texto</strong>: o agente não as
                aplica — quem faz isso é a configuração do nível no servidor.
              </p>
            </div>
          </div>
        )}

        {/* ---- veículo ---- */}
        {kind === 'vehicle' && (
          <div className="grid gap-3 border-l-2 border-l-amber pl-3 sm:grid-cols-2">
            <div>
              <Label>Prefab</Label>
              <Input
                value={prefab}
                placeholder="minicopter"
                disabled={busy}
                onChange={(event) => setPrefab(event.target.value.toLowerCase())}
                className="font-mono"
              />
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                O nome CURTO (minicopter, rowboat, sedan). O jogo resolve o caminho — o completo
                muda quando a Facepunch move um arquivo.
              </p>
            </div>

            <div>
              <Label>Combustível no tanque</Label>
              <Input
                type="number"
                min={0}
                max={1000}
                value={fuel}
                disabled={busy}
                onChange={(event) => setFuel(Math.max(0, Number(event.target.value)))}
              />
              <p className="mt-1 text-2xs text-muted">0 = sai seco.</p>
            </div>
          </div>
        )}

        {/* ---- itens ---- */}
        {kind !== 'vehicle' && (
          <div>
            <Label>{kind === 'item' ? 'O item entregue' : 'O que vem dentro'}</Label>

            <ul className="space-y-2">
              {items.map((item, index) => (
                <li key={index} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <ItemCombobox
                      value={item.shortname}
                      disabled={busy}
                      onValueChange={(shortname) => updateItem(index, { shortname })}
                      onItemChange={(chosen) => {
                        if (chosen !== null) {
                          updateItem(index, { shortname: chosen.shortname, itemId: chosen.itemId });
                        }
                      }}
                    />
                  </div>

                  <div className="w-20 shrink-0">
                    <Input
                      type="number"
                      min={1}
                      value={item.amount}
                      aria-label="Quantidade"
                      disabled={busy}
                      onChange={(event) =>
                        updateItem(index, { amount: Math.max(1, Number(event.target.value)) })
                      }
                    />
                  </div>

                  <div className="w-28 shrink-0">
                    <Input
                      value={item.skinId}
                      aria-label="Skin"
                      placeholder="0"
                      disabled={busy}
                      onChange={(event) =>
                        updateItem(index, { skinId: event.target.value.replace(/\D/g, '') || '0' })
                      }
                      className="font-mono text-2xs"
                    />
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Remover item"
                    disabled={busy}
                    onClick={() => setItems((current) => current.filter((_unused, i) => i !== index))}
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>

            {(kind !== 'item' || items.length === 0) && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                className="mt-2"
                onClick={() =>
                  setItems((current) => [
                    ...current,
                    { shortname: '', itemId: 0, skinId: '0', amount: 1 },
                  ])
                }
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                Item
              </Button>
            )}

            <p className="mt-1 text-2xs leading-relaxed text-muted">
              {kind === 'item'
                ? 'Uma oferta de item entrega exatamente um. A quantidade acima é o que vem por compra.'
                : 'O modal do jogo mostra esta lista antes de o jogador confirmar — é o que justifica pagar por um pacote.'}
              {kind === 'vip' && ' Num VIP, os itens são o extra que vem junto do nível.'}
            </p>
          </div>
        )}

        {/* ---- estado ---- */}
        <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
          <Toggle
            on={enabled}
            busy={busy}
            onChange={setEnabled}
            labels={['Na vitrine', 'Fora do ar']}
            label="A oferta aparece na loja do jogo"
          />

          <div className="flex items-center gap-2">
            <Label className="mb-0">Ordem</Label>
            <Input
              type="number"
              min={0}
              value={position}
              disabled={busy}
              onChange={(event) => setPosition(Math.max(0, Number(event.target.value)))}
              className="w-20"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>

          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {offer === null ? 'Criar oferta' : 'Gravar'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * O que impede esta oferta de existir. `null` = pode gravar.
 *
 * A API recusa de novo — este aqui existe para a recusa chegar ANTES
 * do clique, com a frase que diz o que consertar.
 */
function offerProblem(input: {
  readonly kind: OfferKind;
  readonly name: string;
  readonly icon: { readonly shortname: string; readonly itemId: number };
  readonly items: readonly OfferItem[];
  readonly tier: string;
  readonly prefab: string;
  readonly price: string;
  readonly oldPrice: string;
}): string | null {
  if (input.name.trim() === '') {
    return 'a oferta precisa de um nome — é o que aparece no card.';
  }

  if (input.icon.shortname.trim() === '' || input.icon.itemId === 0) {
    return (
      'escolha o ícone na lista: o jogo desenha o card pelo itemId, e digitado à mão ele sai como ' +
      'um quadrado vazio.'
    );
  }

  if (!Number.isInteger(Number(input.price)) || Number(input.price) < 0) {
    return 'o preço é em OZCoin INTEIRO — a moeda não tem centavo.';
  }

  if (input.oldPrice.trim() !== '' && Number(input.oldPrice) <= Number(input.price)) {
    return 'o preço antigo precisa ser MAIOR que o atual: ele é riscado ao lado para mostrar o desconto.';
  }

  if (input.kind === 'vip' && input.tier.trim() === '') {
    return 'uma oferta de VIP precisa dizer qual nível ela concede, senão ela cobra e não dá nada.';
  }

  if (input.kind === 'vehicle' && input.prefab.trim() === '') {
    return 'uma oferta de veículo precisa do prefab (minicopter, rowboat, sedan).';
  }

  if (input.kind === 'item' && input.items.length !== 1) {
    return 'uma oferta de item entrega exatamente um item. Para vender vários numa compra, use o formato Kit.';
  }

  if (input.kind === 'bundle' && input.items.length === 0) {
    return 'um kit sem itens seria comprável, cobrado, e entregaria nada.';
  }

  if (input.items.some((item) => item.shortname.trim() === '' || item.itemId === 0)) {
    return 'há item sem escolha na lista: escolha-o no catálogo para o itemId vir junto.';
  }

  return null;
}

function categoryName(categories: readonly StoreCategory[], id: string): string {
  return categories.find((entry) => entry.id === id)?.name ?? 'sem categoria';
}
