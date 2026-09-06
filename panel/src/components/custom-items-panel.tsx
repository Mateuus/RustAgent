'use client';

// ============================================================
//  custom-items-panel.tsx  -  a aba "Nossos" da tela de itens.
//
//  ####  ELA É ADMINISTRAÇÃO, E NÃO CONSULTA  ####
//
//  Por isso lista TUDO de uma vez, sem paginação e sem busca: o
//  catálogo do jogo tem 1259 itens e precisa de filtro; os nossos
//  são dezenas. Uma tela que precisasse de busca para achar um item
//  que a própria casa cadastrou seria uma tela mal desenhada.
//
//  ####  AS COLUNAS SÃO OUTRAS  ####
//
//  Item do jogo tem "empilha" e "tem condição". Item nosso tem
//  "corpo emprestado", "ação" e "servidores" — que são as coisas
//  que quem administra precisa varrer de cima a baixo. É por isso
//  que as duas naturezas não cabem numa tabela só.
// ============================================================

import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { CustomItemDialog } from '@/components/custom-item-dialog';
import { ItemIcon } from '@/components/item-icon';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import {
  agent,
  ApiError,
  type CustomItem,
  type CustomItemAction,
  type RankingDefinition,
} from '@/lib/api';
import { EM_DASH } from '@/lib/format';
import { forgetCustomItems } from '@/lib/hooks/use-custom-items';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * O que este item FAZ, numa linha de tabela.
 *
 * ####  A AÇÃO DE PONTOS PRECISA DIZER ONDE ELES CAEM  ####
 *
 * Ela mostrava travessão — o mesmo que "não faz nada" —, e é
 * justamente ela que faz o Troféu Bleik existir. "+1 em Troféu
 * Bleik Store" responde de relance a pergunta que se faz varrendo
 * esta coluna: em qual ranking este item pontua, e quanto.
 *
 * Quando o ranking não está no catálogo a célula diz isso: um item
 * que aponta para uma métrica sem ranking converte em NADA — o
 * jogador perde o item e não ganha ponto.
 */
function describeAction(
  action: CustomItemAction,
  rankings: readonly RankingDefinition[],
): string {
  if (action.kind === 'consume') {
    return `${String(action.effects.length)} efeito(s)`;
  }

  if (action.kind === 'points') {
    const ranking = rankings.find((entry) => entry.metric === action.metric);

    return ranking === undefined
      ? `+${String(action.perUnit)} em ${action.metric} (sem ranking)`
      : `+${String(action.perUnit)} em ${ranking.label}`;
  }

  return EM_DASH;
}

function HeaderCell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-left font-condensed text-2xs font-bold uppercase tracking-wide text-muted',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function CustomItemsPanel({ onCount }: { readonly onCount: (total: number) => void }) {
  const [items, setItems] = useState<CustomItem[] | null>(null);
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  /** Para a coluna "Ação" dizer o NOME do ranking, e não a métrica. */
  const [rankings, setRankings] = useState<readonly RankingDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [editando, setEditando] = useState<CustomItem | null>(null);
  const [aberto, setAberto] = useState(false);

  const load = useCallback(async () => {
    try {
      // O seletor de item guarda esta mesma lista por um minuto
      // (ver `use-custom-items`). Sem descartar aqui, cadastrar um
      // item e ir entregá-lo em seguida não o acharia — e o sintoma
      // seria exatamente o defeito que o seletor acabou de resolver.
      forgetCustomItems();

      const response = await agent.customItems();

      setItems(response.items);
      onCount(response.count);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onCount]);

  // Servidores e categorias alimentam o FORMULÁRIO, e não a lista.
  // São lidos uma vez: um servidor novo no meio de um cadastro é
  // raro o bastante para não valer uma consulta por abertura.
  const loadAux = useCallback(async () => {
    try {
      const [serverList, categoryList, rankingList] = await Promise.all([
        agent.servers(),
        agent.customItemCategories(),
        agent.rankingMetrics(),
      ]);

      setServers(serverList.servers.map((server) => ({ id: server.id, name: server.name })));
      setCategories(categoryList.categories.map((entry) => entry.category));
      setRankings(rankingList.rankings);
    } catch {
      // São auxiliares do formulário. Sem eles a lista continua
      // servindo, e o erro de verdade já aparece na listagem.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadAux();
  }, [loadAux]);

  const abrir = (item: CustomItem | null): void => {
    setEditando(item);
    setAberto(true);
  };

  const apagar = async (item: CustomItem): Promise<void> => {
    try {
      await agent.removeCustomItem(item.id);
      toast.success(`"${item.displayName}" apagado.`);
      await load();
    } catch (cause) {
      // A frase vem do CORE: ele sabe quais kits e ofertas apontam
      // para este item, e a nossa tela não.
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    }
  };

  const nomeDoServidor = (id: string): string =>
    servers.find((server) => server.id === id)?.name ?? id;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-2xs leading-relaxed text-muted">
          Um item custom <strong>não é um item novo</strong>: é um item do jogo com uma marca nossa.
          Ele empresta o modelo 3D e o slot, e ganha de nós o nome, o ícone e o que faz.
        </p>

        <Button size="sm" onClick={() => abrir(null)}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          Novo item
        </Button>
      </div>

      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler os itens" detail={error} />
      )}

      {items === null && error === null && <StateBlock variant="loading" title="Lendo…" />}

      {items !== null && items.length === 0 && (
        <StateBlock
          variant="empty"
          title="Nenhum item nosso ainda"
          detail="Comece por Novo item: escolha um item do jogo para emprestar o corpo, dê um nome e diga em quais servidores ele vale."
        />
      )}

      {items !== null && items.length > 0 && (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                <HeaderCell className="w-12">
                  <span className="sr-only">Ícone</span>
                </HeaderCell>
                <HeaderCell>Nome</HeaderCell>
                <HeaderCell>Categoria</HeaderCell>
                <HeaderCell>Corpo emprestado</HeaderCell>
                <HeaderCell>Ação</HeaderCell>
                <HeaderCell>Servidores</HeaderCell>
                <HeaderCell className="text-right">
                  <span className="sr-only">Ações</span>
                </HeaderCell>
              </tr>
            </thead>

            <tbody className="divide-y divide-border">
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={cn('hover:bg-surface-2', !item.enabled && 'opacity-60')}
                >
                  <td className="py-1 pl-3 pr-0">
                    {/* O ícone é o do CORPO emprestado: o nosso PNG
                        só existe dentro do jogo, no FileStorage do
                        servidor — o painel não tem como desenhá-lo. */}
                    <ItemIcon shortname={item.baseShortname} />
                  </td>

                  <td className="px-3 py-2">
                    <span className="text-foreground">{item.displayName}</span>

                    {!item.enabled && (
                      <span
                        className="ml-2 border border-muted px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
                        title="Desligado: não é entregue. Quem já tem continua com ele, e o plugin continua reconhecendo."
                      >
                        desligado
                      </span>
                    )}

                    <span className="ml-2 font-mono text-2xs text-muted">{item.id}</span>
                  </td>

                  <td className="px-3 py-2 text-muted">{item.category}</td>

                  <td className="px-3 py-2">
                    <span className="font-mono text-2xs text-muted">{item.baseShortname}</span>

                    {item.baseMissing && (
                      <span
                        className="ml-2 border border-rust px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-rust"
                        title="O jogo não tem mais este item. Enquanto ele não voltar, este item custom não pode ser entregue."
                      >
                        fora do jogo
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-muted">{describeAction(item.action, rankings)}</td>

                  <td className="px-3 py-2 text-2xs text-muted">
                    {item.servers.length === 0 ? (
                      <span
                        className="text-rust"
                        title="Sem servidor nenhum, este item não é entregue em lugar algum."
                      >
                        nenhum
                      </span>
                    ) : (
                      item.servers.map(nomeDoServidor).join(', ')
                    )}
                  </td>

                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => abrir(item)}>
                        Editar
                      </Button>

                      {/* Apagar é diferente de desligar, e o `hint`
                          é onde essa diferença aparece na hora em
                          que ela importa. */}
                      <ConfirmButton
                        variant="danger"
                        disabled={false}
                        icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
                        label="Apagar"
                        confirmLabel="Apagar mesmo"
                        hint="Some do cadastro. Para só tirar de circulação, use Editar e desligue."
                        onConfirm={() => void apagar(item)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-2xs leading-relaxed text-muted">
        O cadastro fica no agente e é empurrado para cada servidor quando ele sobe. Desligar tira o
        item de circulação <strong>sem deixar órfão</strong>: quem já o tem continua com ele, e o
        jogo continua reconhecendo a marca.
      </p>

      <CustomItemDialog
        open={aberto}
        item={editando}
        servers={servers}
        categories={categories}
        onClose={() => setAberto(false)}
        onSaved={() => void load()}
      />
    </div>
  );
}
