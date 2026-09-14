'use client';

// ============================================================
//  /kits  -  os kits da rede.
//
//  ####  KIT NÃO É OFERTA DA LOJA  ####
//
//  Um kit é entrega com REGRA: uma vez por jogador, de N em N horas.
//  Ele NÃO tem preço — kit não se compra.
//
//  A LOJA (`/loja`) é o outro sistema, e é lá que se vende: ela tem
//  vitrine, carteira, débito, estorno e extrato. Os dois aparecem no
//  mesmo menu do jogo, em abas diferentes. Ver
//  core/src/game/ui-store-bridge.ts.
//
//  ####  O KIT É DA REDE; CADA SERVIDOR DECIDE SE O OFERECE  ####
//
//  Mesma razão da biblioteca de plugins: um kit por servidor faria
//  cinco cópias do mesmo kit, e a sexta mudança entraria em quatro
//  delas. Por isso esta tela é de rede, e a coluna "onde" mostra os
//  NOMES — "2 servidores" obrigaria a ir procurar quais.
//
//  ####  TIRAR DO AR NÃO É APAGAR  ####
//
//  Desligar mantém o kit e o histórico de resgates; apagar leva os
//  dois. A confirmação diz quantos resgates vão junto, porque é
//  esse número que faz alguém mudar de ideia.
//
//  ####  E QUEM JÁ PEGOU É UMA PERGUNTA DA TELA  ####
//
//  As entregas que FALHARAM aparecem ali também, com o motivo: uma
//  entrega que não aconteceu é a pergunta que o suporte recebe.
// ============================================================

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { KitDialog } from '@/components/kit-dialog';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { agent, type Kit, type KitClaim } from '@/lib/api';
import { EM_DASH, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export default function KitsPage() {
  return (
    <RequireSession>
      <Kits />
    </RequireSession>
  );
}

function HeaderCell({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-3 py-2 text-left font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
    >
      {children}
    </th>
  );
}

/**
 * Quantos kits por página.
 *
 * ####  A PAGINAÇÃO É DO CLIENTE, E NÃO DO AGENTE  ####
 *
 * `GET /api/kits` devolve a rede inteira numa resposta — é a mesma
 * lista que a tela do jogo consome para montar as categorias, e
 * parti-la em páginas no agente obrigaria as duas a paginar igual.
 *
 * Kits são dezenas, não milhares: a resposta inteira é barata, e
 * paginar aqui dá busca INSTANTÂNEA, sem uma ida ao servidor por
 * letra digitada. Se um dia forem milhares, a conta muda e a
 * paginação desce para a rota — como em `/jogadores`.
 */
const PAGE_SIZE = 20;

/** O valor do filtro que quer dizer "todas". */
const ALL = '';

/**
 * O grupo dos kits sem categoria, no filtro.
 *
 * Um texto comum, e não um sentinela exótico: a categoria de um kit
 * é escrita por gente, e nenhuma pessoa batiza uma categoria de
 * "(sem categoria)". Um caractere de controle no lugar seria
 * infalível e ilegível no `value` do `<option>`.
 */
const NO_CATEGORY = '(sem categoria)';

/** As categorias que existem, em ordem, com "sem categoria" junto. */
export function categoriesOf(kits: readonly Kit[]): string[] {
  return [...new Set(kits.map((kit) => kit.category ?? NO_CATEGORY))].sort((a, b) =>
    a.localeCompare(b, 'pt-BR'),
  );
}

export interface KitsPage {
  /** Tudo o que passou no filtro. */
  readonly filtered: readonly Kit[];
  /** Só o pedaço desta página. */
  readonly shown: readonly Kit[];
  readonly pages: number;
  /** A página de fato mostrada — pode não ser a pedida. Ver abaixo. */
  readonly current: number;
  readonly inicio: number;
  readonly fim: number;
}

/**
 * Filtra e pagina, num lugar só.
 *
 * ####  A PÁGINA PEDIDA PODE NÃO EXISTIR MAIS  ####
 *
 * Alguém apaga um kit, ou digita mais uma letra na busca, e a lista
 * encolhe sob os pés — a página 3 de uma lista que agora tem uma.
 * Aparar para a última é melhor que mostrar uma tela vazia, que
 * pareceria a lista ter sumido.
 */
export function pageOf(
  kits: readonly Kit[],
  search: string,
  category: string,
  page: number,
): KitsPage {
  const needle = search.trim().toLowerCase();

  const filtered = kits.filter((kit) => {
    if (category !== ALL && (kit.category ?? NO_CATEGORY) !== category) {
      return false;
    }

    if (needle === '') {
      return true;
    }

    // O slug entra na busca porque é o que aparece no log e no
    // suporte — quem chega com "kit-inicial" na mão precisa achá-lo
    // por ele.
    return (
      kit.name.toLowerCase().includes(needle) ||
      kit.slug.toLowerCase().includes(needle) ||
      (kit.category ?? '').toLowerCase().includes(needle)
    );
  });

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);

  return {
    filtered,
    shown: filtered.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE),
    pages,
    current,
    inicio: filtered.length === 0 ? 0 : current * PAGE_SIZE + 1,
    fim: Math.min((current + 1) * PAGE_SIZE, filtered.length),
  };
}

function Kits() {
  const [kits, setKits] = useState<Kit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>(ALL);
  const [page, setPage] = useState(0);

  /** `undefined` = fechado; `null` = criando; um kit = editando. */
  const [editing, setEditing] = useState<Kit | null | undefined>(undefined);

  /** Qual kit teve os resgates abertos. */
  const [claimsOf, setClaimsOf] = useState<number | null>(null);
  const [claims, setClaims] = useState<KitClaim[] | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await agent.kits();

      setKits(response.kits);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openClaims(kit: Kit): Promise<void> {
    if (claimsOf === kit.id) {
      setClaimsOf(null);
      return;
    }

    setClaimsOf(kit.id);
    setClaims(null);

    try {
      setClaims((await agent.kitClaims(kit.id, { limit: 50, offset: 0 })).claims);
    } catch (cause) {
      toast.error('Não consegui ler os resgates', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
      setClaimsOf(null);
    }
  }

  async function remove(kit: Kit): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.removeKit(kit.id);

      toast.success('Kit removido', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui remover', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  // ####  O FILTRO ZERA A PÁGINA  ####
  //
  // Buscar com a página 3 aberta deixaria a tela vazia sem
  // explicação: o resultado novo pode nem ter três páginas. É a
  // mesma regra de /jogadores.
  useEffect(() => {
    setPage(0);
  }, [search, category]);

  const categories = categoriesOf(kits ?? []);
  const { filtered, shown, pages, current, inicio, fim } = pageOf(
    kits ?? [],
    search,
    category,
    page,
  );

  return (
    <div>
      <PageHeader
        title="Kits"
        description="Os kits da rede: resgate único, uso e cooldown. Kit não se vende — quem cobra em OZCoin é a Loja."
        aside={
          <Button variant="primary" disabled={busy} onClick={() => setEditing(null)}>
            Novo kit
          </Button>
        }
      />

      <div className="mt-4 space-y-4">
        {error !== null && (
          <StateBlock variant="error" title="Não consegui ler os kits" detail={error} />
        )}

        {kits === null && error === null && <StateBlock variant="loading" title="Lendo a loja…" />}

        {kits !== null && kits.length === 0 && (
          <StateBlock
            variant="empty"
            title="Nenhum kit ainda"
            detail="Um kit é um loadout com regra de entrega: pago, uma vez por jogador, ou de tempos em tempos. Ele é da rede, e cada servidor decide se o oferece."
          />
        )}

        {/* ####  A BARRA DE FILTROS  ####

            Ela só aparece com kits na tela: um campo de busca sobre
            uma lista vazia é um controle que não controla nada. */}
        {kits !== null && kits.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              value={search}
              placeholder="Buscar por nome, slug ou categoria"
              aria-label="Buscar kits"
              onChange={(event) => setSearch(event.target.value)}
              className="w-full sm:w-80"
            />

            {/* Uma categoria só não é escolha: o seletor diria o que
                a lista inteira já diz. */}
            {categories.length > 1 && (
              <select
                value={category}
                aria-label="Filtrar por categoria"
                onChange={(event) => setCategory(event.target.value)}
                className="h-9 border border-border bg-surface px-2 text-sm text-foreground"
              >
                <option value={ALL}>Todas as categorias</option>
                {categories.map((name) => (
                  <option key={name} value={name}>
                    {name === NO_CATEGORY ? 'Sem categoria' : name}
                  </option>
                ))}
              </select>
            )}

            <span className="text-2xs text-muted">
              {filtered.length === kits.length
                ? `${String(kits.length)} ${kits.length === 1 ? 'kit' : 'kits'}`
                : `${String(filtered.length)} de ${String(kits.length)}`}
            </span>
          </div>
        )}

        {/* Busca sem resultado NÃO é o mesmo que não haver kit
            nenhum — e o bloco de "nenhum kit ainda" convidaria a
            criar um que já existe, escondido pelo filtro. */}
        {kits !== null && kits.length > 0 && filtered.length === 0 && (
          <StateBlock
            variant="empty"
            title="Nenhum kit com esse filtro"
            detail="Os kits continuam lá — o que não bateu foi a busca. Limpe o campo ou escolha outra categoria."
          />
        )}

        {kits !== null && filtered.length > 0 && (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>Kit</HeaderCell>
                  {/* A aba do jogo. Sem ela, "por que este kit não
                      aparece junto dos outros?" só tem resposta
                      abrindo o formulário de cada um. */}
                  <HeaderCell>Categoria</HeaderCell>
                  <HeaderCell>Como recebe</HeaderCell>
                  <HeaderCell>Exige VIP</HeaderCell>
                  <HeaderCell>Onde</HeaderCell>
                  <HeaderCell>Itens</HeaderCell>
                  <HeaderCell>Resgates</HeaderCell>
                  <HeaderCell>
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {shown.map((kit) => (
                  <tr key={kit.id} className={cn(!kit.enabled && 'text-muted')}>
                    <td className="px-3 py-2">
                      <p className="truncate">{kit.name}</p>
                      <p className="truncate font-mono text-2xs text-muted">{kit.slug}</p>
                    </td>

                    <td className="px-3 py-2 text-muted">
                      {kit.category ?? <span className="text-2xs uppercase">geral</span>}
                    </td>

                    <td className="px-3 py-2">
                      {ruleOf(kit)}

                      {/* O bloqueio pós-wipe vale para os três tipos,
                          e é a regra que mais surpreende quem não a
                          configurou: sem ele à vista, "por que o kit
                          não aparece?" vira uma caçada. */}
                      {kit.wipeDelaySeconds !== null && (
                        <span className="block text-2xs text-amber">
                          só {String(Math.round(kit.wipeDelaySeconds / 3600))} h após o wipe
                        </span>
                      )}
                    </td>

                    {/* "só ouro" e "ouro" são regras diferentes, e a
                        diferença aparece justamente quando o VIP mais
                        caro reclama que não pega o kit de baixo. */}
                    <td className="px-3 py-2 text-muted">
                      {kit.requiredTier === null ? (
                        EM_DASH
                      ) : kit.requiredTierExact ? (
                        <span className="text-amber">só {kit.requiredTier}</span>
                      ) : (
                        kit.requiredTier
                      )}
                    </td>

                    {/* Os NOMES, e não a contagem: "2 servidores"
                        obriga a ir procurar quais. */}
                    <td className="px-3 py-2 text-muted">
                      {kit.servers.length === 0 ? (
                        <span className="text-amber">nenhum</span>
                      ) : (
                        kit.servers.join(', ')
                      )}
                    </td>

                    <td className="px-3 py-2 text-muted">{kit.items.length}</td>

                    <td className="px-3 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void openClaims(kit)}
                      >
                        {kit.claimCount}
                      </Button>
                    </td>

                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {!kit.enabled && <span className="text-2xs text-amber">fora do ar</span>}

                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setEditing(kit)}
                        >
                          Editar
                        </Button>

                        <ConfirmButton
                          variant="danger"
                          disabled={busy}
                          icon={null}
                          label="Remover"
                          confirmLabel="Remover mesmo"
                          hint={
                            kit.claimCount === 0
                              ? `"${kit.name}" some da loja.`
                              : `"${kit.name}" some da loja e leva ${String(kit.claimCount)} resgate(s) de histórico. Para preservá-los, desligue o kit.`
                          }
                          onConfirm={() => void remove(kit)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ####  A PAGINAÇÃO SÓ APARECE QUANDO PAGINA  ####

            Dois botões desligados sob uma lista de três kits são
            dois controles dizendo "não há para onde ir" — ruído com
            aparência de defeito. */}
        {kits !== null && pages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-2xs text-muted">
              {String(inicio)}–{String(fim)} de {String(filtered.length)}
              <span className="ml-2">
                (página {String(current + 1)} de {String(pages)})
              </span>
            </p>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={current === 0}
                onClick={() => setPage(Math.max(0, current - 1))}
              >
                Anterior
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={current >= pages - 1}
                onClick={() => setPage(current + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        )}

        {claimsOf !== null && (
          <div className="border border-border bg-surface">
            <div className="border-b border-border px-3 py-2">
              <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
                <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
                Quem já pegou
              </h2>
            </div>

            <div className="p-3">
              {claims === null && <StateBlock variant="loading" title="Lendo…" />}

              {claims !== null && claims.length === 0 && (
                <StateBlock variant="empty" title="Ninguém pegou este kit ainda" />
              )}

              {claims !== null && claims.length > 0 && (
                <ul className="divide-y divide-border">
                  {claims.map((claim) => (
                    <li key={claim.id} className="flex flex-wrap gap-x-3 gap-y-1 py-2 text-sm">
                      <span className="min-w-40">{claim.playerName ?? claim.steamId}</span>
                      <span className="text-2xs text-muted">{claim.serverId}</span>
                      <span className="text-2xs text-muted">{formatWhen(claim.claimedAt)}</span>
                      <span
                        className={cn(
                          'text-2xs',
                          claim.status === 'entregue' ? 'text-muted' : 'text-amber',
                        )}
                      >
                        {claim.status}
                        {claim.detail === null ? '' : ` — ${claim.detail}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <p className="text-2xs leading-relaxed text-muted">
          A entrega exige o jogador <strong>dentro do servidor</strong>: item entra em inventário, e
          inventário só existe para quem está conectado. Uma tentativa que falha fica no histórico,
          com o motivo — e não queima o resgate de quem não recebeu nada.
        </p>
      </div>

      {editing !== undefined && (
        <KitDialog
          open
          kit={editing}
          onClose={() => setEditing(undefined)}
          onDone={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

/** "uma vez por jogador", "10 usos por jogador" ou "a cada 24 h". */
function ruleOf(kit: Kit): string {
  if (kit.kind === 'cooldown') {
    return kit.cooldownSeconds === null
      ? EM_DASH
      : `a cada ${String(Math.round(kit.cooldownSeconds / 3600))} h`;
  }

  const limit = kit.useLimit ?? 1;
  const reset =
    kit.useResetOn === 'wipe'
      ? ', zera no wipe'
      : kit.useResetOn === 'full-wipe'
        ? ', zera no full wipe'
        : '';

  return limit === 1 ? `uma vez por jogador${reset}` : `${String(limit)} usos por jogador${reset}`;
}
