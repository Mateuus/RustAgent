'use client';

// ============================================================
//  /loja  -  a vitrine em OZCoin.
//
//  ####  ESTA É A LOJA QUE COBRA  ####
//
//  Ela debita da carteira, entrega no jogo e estorna quando a
//  entrega falha. Os KITS (`/kits`) são o outro sistema: entrega com
//  REGRA, sem dinheiro.
//
//  ------------------------------------------------------------
//  ####  TRÊS ABAS, TRÊS PERGUNTAS  ####
//
//    Visão geral   como a loja está indo, e o que precisa de gente
//    Vitrine       o que está à venda, e por quanto
//    Histórico     o que aconteceu — as compras e as mexidas
//
//  A ordem é a do uso, como na página de um servidor: quem abre a
//  loja quer primeiro saber se está tudo certo; mexer no preço é o
//  segundo gesto, e olhar o passado é o que se faz quando alguém
//  pergunta.
//
//  ####  A VITRINE É A GRADE DO JOGO  ####
//
//  Categorias como abas, ofertas como cards, com o mesmo ícone, o
//  mesmo preço em âmbar e a mesma etiqueta que o jogador vê. Uma
//  tabela de linhas seria mais fácil de montar e esconderia
//  justamente o que o admin precisa julgar: se a vitrine ficou boa.
// ============================================================

import { History, LayoutList, Plus, ShoppingBag } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { StoreOfferDialog } from '@/components/store-offer-dialog';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import {
  agent,
  type OfferBadge,
  type PurchaseState,
  type StoreAuditEntry,
  type StoreCategory,
  type StoreOffer,
  type StorePurchase,
  type StoreStats,
} from '@/lib/api';
import { formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type Tab = 'visao' | 'vitrine' | 'historico';

/**
 * As abas, com ícone.
 *
 * O ícone não decora: ele é o que a vista pega antes de ler, e é o
 * que permite achar "Histórico" de relance numa tela que se abre
 * várias vezes por dia.
 */
const TABS = [
  { key: 'visao', label: 'Visão geral', Icon: LayoutList },
  { key: 'vitrine', label: 'Vitrine', Icon: ShoppingBag },
  { key: 'historico', label: 'Histórico', Icon: History },
] as const;

/** As mesmas cores do jogo. Ver core/src/game/ui-store-screens.ts. */
const BADGE_CLASS: Record<OfferBadge, string> = {
  promo: 'bg-rust text-white',
  novo: 'bg-olive text-background',
  destaque: 'bg-amber text-background',
};

const KIND_LABEL: Record<StoreOffer['kind'], string> = {
  item: 'item',
  bundle: 'kit',
  vip: 'VIP',
  vehicle: 'veículo',
};

/**
 * O que cada estado significa para quem lê o histórico.
 *
 * `failed` é o único que exige ação — e por isso é o único em
 * vermelho.
 */
const STATE_LABEL: Record<PurchaseState, { readonly text: string; readonly className: string }> = {
  pending: { text: 'começou', className: 'text-muted' },
  debited: { text: 'debitado, entregando', className: 'text-amber' },
  delivered: { text: 'entregue', className: 'text-muted' },
  refunded: { text: 'estornado', className: 'text-amber' },
  failed: { text: 'PRESA — pagou e não recebeu', className: 'text-rust' },
};

/**
 * O que cada ação da auditoria significa, em português.
 *
 * O código (`offer.update`) é o que fica no banco; ele não é o que
 * se lê. Uma ação desconhecida cai no próprio código em vez de
 * sumir: um registro sem rótulo é melhor que um registro escondido.
 */
const ACTION_LABEL: Record<string, string> = {
  'category.create': 'criou a categoria',
  'category.update': 'editou a categoria',
  'category.remove': 'removeu a categoria',
  'offer.create': 'criou a oferta',
  'offer.update': 'editou a oferta',
  'offer.remove': 'removeu a oferta',
  'wallet.credit': 'creditou saldo a',
  'wallet.debit': 'debitou saldo de',
};

export default function LojaPage() {
  return (
    <RequireSession>
      <Loja />
    </RequireSession>
  );
}

function Loja() {
  const [tab, setTab] = useState<Tab>('visao');

  const [categories, setCategories] = useState<StoreCategory[] | null>(null);
  const [offers, setOffers] = useState<StoreOffer[]>([]);
  const [purchases, setPurchases] = useState<StorePurchase[]>([]);
  const [audit, setAudit] = useState<StoreAuditEntry[]>([]);
  const [stats, setStats] = useState<StoreStats | null>(null);
  const [source, setSource] = useState<'local' | 'remote'>('local');
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** `undefined` = fechado; `null` = criando; um item = editando. */
  const [editing, setEditing] = useState<StoreOffer | null | undefined>(undefined);
  const [editingCategory, setEditingCategory] = useState<StoreCategory | null | undefined>(
    undefined,
  );

  const load = useCallback(async () => {
    try {
      const [categoryResponse, offerResponse] = await Promise.all([
        agent.storeCategories(),
        agent.storeOffers(),
      ]);

      setCategories(categoryResponse.categories);
      setOffers(offerResponse.offers);
      setError(null);

      setActive((current) =>
        current !== null && categoryResponse.categories.some((entry) => entry.id === current)
          ? current
          : (categoryResponse.categories[0]?.id ?? null),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }

    // O resto é secundário: a vitrine continua editável sem ele, e
    // insistir num erro aqui esconderia a tela inteira.
    try {
      const response = await agent.storeStats(7);

      setStats(response.stats);
      setSource(response.source);
    } catch {
      setStats(null);
    }

    try {
      setPurchases((await agent.storePurchases({ limit: 100 })).purchases);
    } catch {
      setPurchases([]);
    }

    try {
      setAudit((await agent.storeAudit(100)).entries);
    } catch {
      setAudit([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function removeOffer(offer: StoreOffer): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.removeStoreOffer(offer.id);

      toast.success('Oferta removida', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui remover', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeCategory(category: StoreCategory): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.removeStoreCategory(category.id);

      toast.success('Categoria removida', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui remover', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  const shown = offers.filter((offer) => offer.categoryId === active);
  const stuck = purchases.filter((purchase) => purchase.state === 'failed');
  const activeCategory = categories?.find((entry) => entry.id === active) ?? null;

  return (
    <div>
      <PageHeader
        title="Loja"
        description="A vitrine que o jogador abre no menu: categorias, ofertas, VIP e veículos — cobrados em OZCoin."
        aside={
          tab === 'vitrine' ? (
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setEditingCategory(null)}>
                Nova categoria
              </Button>

              <Button
                variant="primary"
                disabled={busy || active === null}
                onClick={() => setEditing(null)}
              >
                Nova oferta
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* ---- as abas ---- */}
      <div className="mt-4 flex flex-wrap items-stretch border border-border bg-surface">
        {TABS.map((item, index) => {
          const { Icon } = item;

          return (
            <div key={item.key} className="flex items-stretch">
              {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

              <button
                type="button"
                onClick={() => setTab(item.key)}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                  tab === item.key
                    ? 'bg-surface-2 text-foreground'
                    : 'text-muted hover:text-foreground',
                )}
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
                {item.label}

                {/* O número das presas viaja com a aba: ele é a única
                    coisa desta tela que pede ação de gente. */}
                {item.key === 'historico' && stuck.length > 0 && (
                  <span className="bg-rust px-1 text-3xs text-white">{stuck.length}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-4 space-y-4">
        {error !== null && (
          <StateBlock variant="error" title="Não consegui ler a loja" detail={error} />
        )}

        {categories === null && error === null && (
          <StateBlock variant="loading" title="Lendo a vitrine…" />
        )}

        {/* ####  AS COMPRAS PRESAS APARECEM EM QUALQUER ABA  ####
            Alguém pagou, não recebeu, e o estorno também falhou. */}
        {stuck.length > 0 && (
          <StateBlock
            variant="error"
            title={`${String(stuck.length)} compra(s) presa(s)`}
            detail={
              'Foram debitadas, não entregues e não estornadas. Confira o extrato do jogador e ' +
              'devolva o valor à mão, na ficha dele.'
            }
          />
        )}

        {tab === 'visao' && (
          <VisaoGeral stats={stats} source={source} purchases={purchases} audit={audit} />
        )}

        {tab === 'historico' && <Historico purchases={purchases} audit={audit} />}

        {tab === 'vitrine' && categories !== null && (
          <>
            {categories.length === 0 && (
              <StateBlock
                variant="empty"
                title="A loja está fechada"
                detail="Sem categoria, quem clicar em LOJA no jogo vê um aviso de que não há nada publicado. Crie a primeira aba — Armas, Recursos, VIP."
              />
            )}

            {categories.length > 0 && (
              <div className="flex flex-wrap items-center gap-px border-b border-border">
                {categories.map((category) => {
                  const count = offers.filter((offer) => offer.categoryId === category.id).length;

                  return (
                    <button
                      key={category.id}
                      type="button"
                      aria-pressed={active === category.id}
                      onClick={() => setActive(category.id)}
                      className={cn(
                        'flex items-center gap-2 border-b-2 px-4 py-2',
                        'font-condensed text-2xs font-bold uppercase tracking-wide',
                        active === category.id
                          ? 'border-b-rust text-foreground'
                          : 'border-b-transparent text-muted hover:text-foreground',
                      )}
                    >
                      {category.name}
                      <span className="text-muted">{count}</span>

                      {/* Desligada some do jogo INTEIRA, com as
                          ofertas dela — e quem administra precisa ver
                          isso na aba, não descobrir no jogo. */}
                      {!category.enabled && <span className="text-amber">fora do ar</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {activeCategory !== null && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setEditingCategory(activeCategory)}
                >
                  Editar categoria
                </Button>

                <ConfirmButton
                  variant="danger"
                  disabled={busy}
                  icon={null}
                  label="Remover categoria"
                  confirmLabel="Remover mesmo"
                  hint={
                    shown.length === 0
                      ? `"${activeCategory.name}" some da loja.`
                      : `"${activeCategory.name}" some da loja e leva ${String(shown.length)} oferta(s) junto. Para tirar do ar sem perder nada, desligue a categoria.`
                  }
                  onConfirm={() => void removeCategory(activeCategory)}
                />
              </div>
            )}

            {activeCategory !== null && shown.length === 0 && (
              <StateBlock
                variant="empty"
                title="Categoria vazia"
                detail="No jogo, ela aparece com um aviso de que nada foi publicado aqui ainda."
              />
            )}

            {shown.length > 0 && (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {shown.map((offer) => (
                  <li
                    key={offer.id}
                    className={cn(
                      'flex flex-col border border-border bg-surface',
                      !offer.enabled && 'opacity-60',
                    )}
                  >
                    <div className="relative flex flex-col items-center gap-2 p-3">
                      {offer.badge !== null && (
                        <span
                          className={cn(
                            'absolute right-2 top-2 px-1.5 py-0.5',
                            'font-condensed text-3xs font-bold uppercase tracking-wide',
                            BADGE_CLASS[offer.badge],
                          )}
                        >
                          {offer.badge}
                        </span>
                      )}

                      <ItemIcon shortname={offer.icon.shortname} size="lg" />

                      <p className="line-clamp-2 text-center text-sm text-foreground">
                        {offer.name}
                      </p>

                      <p className="text-2xs uppercase text-muted">
                        {KIND_LABEL[offer.kind]}
                        {offer.kind === 'bundle' && ` · ${String(offer.items.length)} itens`}
                        {offer.kind === 'vip' &&
                          offer.vip !== null &&
                          ` · ${offer.vip.days === null ? 'vitalício' : `${String(offer.vip.days)} dias`}`}
                      </p>

                      <p className="flex items-baseline gap-2">
                        {offer.oldPrice !== null && (
                          <span className="text-2xs text-muted line-through">
                            {offer.oldPrice.toLocaleString('pt-BR')}
                          </span>
                        )}

                        <span className="font-mono text-base text-amber">
                          {offer.price.toLocaleString('pt-BR')} OZ
                        </span>
                      </p>
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-2 py-1.5">
                      {offer.enabled ? (
                        <span className="text-3xs uppercase text-muted">na vitrine</span>
                      ) : (
                        <span className="text-3xs uppercase text-amber">fora do ar</span>
                      )}

                      <span className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setEditing(offer)}
                        >
                          Editar
                        </Button>

                        <ConfirmButton
                          variant="danger"
                          disabled={busy}
                          icon={null}
                          label="Remover"
                          confirmLabel="Remover mesmo"
                          hint={`"${offer.name}" sai da loja. As compras já feitas continuam no histórico.`}
                          onConfirm={() => void removeOffer(offer)}
                        />
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-2xs leading-relaxed text-muted">
              A compra <strong>debita antes de entregar</strong>: quebrar no meio deixa um estorno
              possível, e o contrário deixaria o item no mundo sem ninguém ter pago.
            </p>
          </>
        )}
      </div>

      {editing !== undefined && categories !== null && active !== null && (
        <StoreOfferDialog
          open
          offer={editing}
          categories={categories}
          categoryId={active}
          onClose={() => setEditing(undefined)}
          onDone={() => {
            void load();
          }}
        />
      )}

      {editingCategory !== undefined && (
        <CategoryDialog
          category={editingCategory}
          onClose={() => setEditingCategory(undefined)}
          onDone={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  Visão geral
// ------------------------------------------------------------

interface VisaoGeralProps {
  readonly stats: StoreStats | null;
  readonly source: 'local' | 'remote';
  readonly purchases: readonly StorePurchase[];
  readonly audit: readonly StoreAuditEntry[];
}

/**
 * Como a loja está indo, em números dos últimos sete dias.
 *
 * ####  SÓ O ENTREGUE CONTA COMO RECEITA  ####
 *
 * Uma compra estornada não é venda, e uma presa é problema. Somá-las
 * faria o número mais visível da tela ser o mais errado — e é
 * justamente por ele que alguém decide se a loja está funcionando.
 */
function VisaoGeral({ stats, source, purchases, audit }: VisaoGeralProps) {
  if (stats === null) {
    return <StateBlock variant="loading" title="Somando os números…" />;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          label="Receita · 7 dias"
          value={`${stats.revenue.toLocaleString('pt-BR')} OZ`}
          hint={`${String(stats.delivered)} compra(s) entregue(s)`}
          tone="amber"
        />

        <Card
          label="Compradores · 7 dias"
          value={String(stats.buyers)}
          hint="jogadores diferentes"
        />

        <Card
          label="Estornadas · 7 dias"
          value={String(stats.refunded)}
          hint="a entrega falhou e o valor voltou"
          tone={stats.refunded > 0 ? 'amber' : undefined}
        />

        {/* As presas ficam FORA da janela de dias: uma que travou há
            um mês continua sendo alguém que pagou e não recebeu. */}
        <Card
          label="Presas"
          value={String(stats.stuck)}
          hint={stats.stuck === 0 ? 'nada travado' : 'pagou, não recebeu e não estornou'}
          tone={stats.stuck > 0 ? 'rust' : undefined}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Ofertas na vitrine" value={String(stats.offers)} />
        <Card label="Categorias ligadas" value={String(stats.categories)} />
        <Card
          label="Carteira"
          value={source === 'local' ? 'local' : 'site externo'}
          hint={
            source === 'local'
              ? 'o saldo mora no banco do agente'
              : 'o site é o dono do saldo; lançamentos à mão são recusados'
          }
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="border border-border bg-surface">
          <SectionTitle>Mais vendidos · 7 dias</SectionTitle>

          {stats.top.length === 0 ? (
            <div className="p-3">
              <StateBlock variant="empty" title="Nenhuma venda ainda" />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {stats.top.map((entry) => (
                <li
                  key={entry.name}
                  className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="text-2xs text-muted">{entry.count}x</span>
                  <span className="font-mono text-2xs text-amber">
                    {entry.total.toLocaleString('pt-BR')} OZ
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="border border-border bg-surface">
          <SectionTitle>Últimas compras</SectionTitle>

          {purchases.length === 0 ? (
            <div className="p-3">
              <StateBlock variant="empty" title="Ninguém comprou ainda" />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {purchases.slice(0, 6).map((purchase) => (
                <li key={purchase.id} className="flex flex-wrap gap-x-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{purchase.offerName}</span>
                  <span className="font-mono text-2xs text-amber">
                    {purchase.totalPrice.toLocaleString('pt-BR')} OZ
                  </span>
                  <span className={cn('text-2xs', STATE_LABEL[purchase.state].className)}>
                    {STATE_LABEL[purchase.state].text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {audit.length > 0 && (
        <section className="border border-border bg-surface">
          <SectionTitle>Mexidas recentes</SectionTitle>

          <ul className="divide-y divide-border">
            {audit.slice(0, 5).map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface CardProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly tone?: 'amber' | 'rust';
}

function Card({ label, value, hint, tone }: CardProps) {
  return (
    <div className="border border-border bg-surface p-3">
      <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
        {label}
      </p>

      <p
        className={cn(
          'mt-1 font-mono text-2xl',
          tone === 'rust' ? 'text-rust' : tone === 'amber' ? 'text-amber' : 'text-foreground',
        )}
      >
        {value}
      </p>

      {hint !== undefined && <p className="mt-1 text-2xs leading-relaxed text-muted">{hint}</p>}
    </div>
  );
}

function SectionTitle({ children }: { readonly children: ReactNode }) {
  return (
    <div className="border-b border-border px-3 py-2">
      <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
        <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
        {children}
      </h2>
    </div>
  );
}

// ------------------------------------------------------------
//  Histórico
// ------------------------------------------------------------

/**
 * O que aconteceu: as compras e as mexidas.
 *
 * ####  OS DOIS JUNTOS RESPONDEM O QUE UM SÓ NÃO RESPONDE  ####
 *
 * "Por que este item custou 500 ontem e 900 hoje?" precisa da compra
 * E da edição de preço, lado a lado. Separá-los em telas diferentes
 * obrigaria a abrir as duas e comparar horários na mão.
 */
function Historico({
  purchases,
  audit,
}: {
  readonly purchases: readonly StorePurchase[];
  readonly audit: readonly StoreAuditEntry[];
}) {
  return (
    <div className="space-y-4">
      <section className="border border-border bg-surface">
        <SectionTitle>Compras dos jogadores</SectionTitle>

        {purchases.length === 0 ? (
          <div className="p-3">
            <StateBlock variant="empty" title="Ninguém comprou ainda" />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {purchases.map((purchase) => (
              <li key={purchase.id} className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="min-w-40 truncate">{purchase.offerName}</span>

                <span className="font-mono text-2xs text-muted">{purchase.steamId}</span>

                <span className="font-mono text-2xs text-amber">
                  {purchase.totalPrice.toLocaleString('pt-BR')} OZ
                </span>

                <span className="text-2xs text-muted">{purchase.serverId}</span>

                <span className="text-2xs text-muted">{formatWhen(purchase.createdAt)}</span>

                <span className={cn('text-2xs', STATE_LABEL[purchase.state].className)}>
                  {STATE_LABEL[purchase.state].text}
                  {purchase.error === null ? '' : ` — ${purchase.error}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="border border-border bg-surface">
        <SectionTitle>Mexidas do admin</SectionTitle>

        {audit.length === 0 ? (
          <div className="p-3">
            <StateBlock
              variant="empty"
              title="Nenhuma mexida registrada"
              detail="Criar, editar e remover categorias e ofertas — e lançamentos à mão na carteira — aparecem aqui, com quem fez."
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {audit.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>

      <p className="text-2xs leading-relaxed text-muted">
        O histórico de compras guarda uma <strong>cópia</strong> do que a oferta era: ela pode ter
        sido editada ou apagada depois, e o que importa é o que a pessoa pagou — não o preço de
        hoje.
      </p>
    </div>
  );
}

function AuditRow({ entry }: { readonly entry: StoreAuditEntry }) {
  return (
    <li className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <span className="text-2xs text-muted">{formatWhen(entry.at)}</span>

      {/* `null` = veio pelo token de integração, e não de uma sessão
          do painel. Dizer "site" é mais honesto que deixar em branco. */}
      <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
        {entry.actor ?? 'site'}
      </span>

      <span className="text-2xs text-muted">{ACTION_LABEL[entry.action] ?? entry.action}</span>

      <span className="min-w-0 flex-1 truncate">{entry.target}</span>

      {entry.detail !== null && <span className="text-2xs text-amber">{entry.detail}</span>}
    </li>
  );
}

// ------------------------------------------------------------
//  A categoria
// ------------------------------------------------------------

interface CategoryDialogProps {
  /** `null` = criar. */
  readonly category: StoreCategory | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

/**
 * A aba da loja.
 *
 * Três campos só: ela é um agrupamento, e tudo o que decide a
 * aparência está na oferta.
 */
function CategoryDialog({ category, onClose, onDone }: CategoryDialogProps) {
  const [name, setName] = useState(category?.name ?? '');
  const [position, setPosition] = useState(category?.position ?? 0);
  const [enabled, setEnabled] = useState(category?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (name.trim() === '') {
      toast.error('Confira a categoria', { description: 'ela precisa de um nome.' });

      return;
    }

    const body = { name: name.trim(), position, enabled };

    setBusy(true);

    try {
      if (category === null) {
        await agent.createStoreCategory(body);
      } else {
        await agent.updateStoreCategory(category.id, body);
      }

      toast.success(category === null ? 'Categoria criada' : 'Categoria gravada', {
        description: `"${body.name}" ${enabled ? 'aparece' : 'não aparece'} na loja do jogo.`,
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
      open
      title={category === null ? 'Nova categoria' : `Categoria ${category.name}`}
      busy={busy}
      onClose={onClose}
      className="w-[min(32rem,94vw)]"
    >
      <div className="space-y-3">
        <div>
          <Label>Nome</Label>
          <Input
            value={name}
            placeholder="Armas"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="mt-1 text-2xs text-muted">
            Aparece em MAIÚSCULAS na barra de abas, dentro do jogo.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <Toggle
            on={enabled}
            busy={busy}
            onChange={setEnabled}
            labels={['Na loja', 'Fora do ar']}
            label="A categoria aparece na loja do jogo"
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

        <p className="text-2xs leading-relaxed text-muted">
          Desligar a categoria tira <strong>as ofertas dela junto</strong> da loja do jogo, sem
          apagar nada. É o caminho para tirar do ar sem perder o que foi montado.
        </p>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>

          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {category === null ? (
              <>
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                Criar
              </>
            ) : (
              'Gravar'
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
