'use client';

// ============================================================
//  /itens  -  o catálogo do jogo, guardado no agente.
//
//  ####  ESTA TELA RESPONDE COM OS SERVIDORES DESLIGADOS  ####
//
//  E é essa a razão de ela existir. A lista de itens vem do jogo
//  (`origemz.items`), mas mora no banco do agente — montar um kit
//  ou uma entrega é trabalho de madrugada, com tudo parado.
//
//  ####  TABELA, E NÃO CARTÃO  ####
//
//  Mesma razão da lista de jogadores e da de plugins: é uma tela
//  de COMPARAÇÃO — varrer a coluna de empilhamento de cima a baixo
//  para achar o que cabe num slot.
//
//  ####  O TOPO DIZ DE QUANDO É  ####
//
//  Protocolo, hora e origem, sempre. Uma tela que mostra 1252
//  itens sem dizer que eles são de três versões atrás é uma tela
//  que mente — e a diferença entre "isto está sendo conferido
//  agora" e "isto é a última leitura que deu certo" muda o que
//  quem administra faz em seguida.
// ============================================================

import { Package, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agent, ApiError, type CatalogItem, type ItemCatalogInfo } from '@/lib/api';
import { EM_DASH, formatInteger, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** Uma página. O agente aceita até 200. */
const PAGE_SIZE = 50;

export default function ItensPage() {
  return (
    <RequireSession>
      <Itens />
    </RequireSession>
  );
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

function Itens() {
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [catalog, setCatalog] = useState<ItemCatalogInfo | null>(null);
  const [categories, setCategories] = useState<{ category: string; total: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [busca, setBusca] = useState('');
  const [categoria, setCategoria] = useState('');
  const [offset, setOffset] = useState(0);
  const [atualizando, setAtualizando] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.items({
        query: busca,
        category: categoria,
        limit: PAGE_SIZE,
        offset,
      });

      setItems(response.items);
      setTotal(response.total);
      setCatalog(response.catalog);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [busca, categoria, offset]);

  // As categorias mudam quando o catálogo é relido, e só então —
  // relê-las junto de cada busca seria uma consulta por tecla
  // digitada para receber sempre a mesma lista.
  const loadCategories = useCallback(async () => {
    try {
      setCategories([...(await agent.itemCategories()).categories]);
    } catch {
      // A lista de categorias é um filtro, não o conteúdo. Sem ela
      // a tela continua servindo — e o erro de verdade, se houver,
      // já aparece na listagem.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  // Trocar de filtro com a página 3 aberta deixaria a tela vazia
  // sem explicação: o resultado novo pode nem ter três páginas.
  useEffect(() => {
    setOffset(0);
  }, [busca, categoria]);

  const atualizar = async (): Promise<void> => {
    setAtualizando(true);

    try {
      const response = await agent.refreshItems();

      toast.success(
        `Catálogo relido: ${formatInteger(response.scan.present)} itens no jogo` +
          (response.scan.added > 0 ? `, ${formatInteger(response.scan.added)} novos` : '') +
          (response.scan.removed > 0
            ? `, ${formatInteger(response.scan.removed)} que não existem mais`
            : ''),
      );

      await Promise.all([load(), loadCategories()]);
    } catch (cause) {
      // A frase vem do CORE, inteira: ela conhece a regra (nenhum
      // servidor no ar, plugin fora do contrato) e a nossa não.
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setAtualizando(false);
    }
  };

  const online = catalog?.source === 'servidor';
  const inicio = total === 0 ? 0 : offset + 1;
  const fim = Math.min(offset + PAGE_SIZE, total);

  return (
    <div>
      <PageHeader
        title="Itens"
        description="O catálogo do jogo, guardado no agente. Ele responde com os servidores parados."
        aside={
          <span className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted">
            <Package aria-hidden="true" className="h-4 w-4" />
            {total === 0 ? 'nenhum' : `${formatInteger(total)} no total`}
          </span>
        }
      />

      <div className="mt-4 space-y-4">
        {/* De quando é o catálogo, e de onde ele veio. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-2xs">
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  online ? 'bg-olive' : 'border border-muted',
                )}
              />
              <span className="font-condensed font-bold uppercase tracking-wide text-foreground">
                {online ? 'conferido com o servidor' : 'do banco do agente'}
              </span>
            </span>

            <span className="text-muted">
              Protocolo do jogo:{' '}
              <span className="font-mono text-foreground">{catalog?.protocol ?? EM_DASH}</span>
            </span>

            <span className="text-muted">Lido {formatWhen(catalog?.updatedAt)}</span>
          </div>

          <Button
            size="sm"
            variant="outline"
            disabled={!online || atualizando}
            onClick={() => void atualizar()}
            // O motivo no `title`: um botão desabilitado sem
            // explicação é um botão que parece quebrado.
            title={
              online
                ? 'Relê o catálogo do servidor que está no ar'
                : 'Nenhum servidor está no ar. A lista de itens vem do jogo, e só um servidor ' +
                  'ligado sabe dizer quais existem.'
            }
          >
            <RefreshCw aria-hidden="true" className={cn('h-4 w-4', atualizando && 'animate-spin')} />
            Atualizar agora
          </Button>
        </div>

        {catalog?.note !== null && catalog?.note !== undefined && (
          <p className="text-2xs leading-relaxed text-muted">{catalog.note}</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-w-64 flex-1 items-center gap-2 border border-border bg-surface-2 px-2">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
            <Input
              value={busca}
              placeholder="Nome ou shortname"
              aria-label="Buscar por nome ou shortname"
              className="border-0 bg-transparent px-0 hover:border-0"
              onChange={(event) => setBusca(event.target.value)}
            />
          </label>

          <label className="flex items-center gap-2">
            <span className="sr-only">Categoria</span>
            <select
              value={categoria}
              onChange={(event) => setCategoria(event.target.value)}
              className="border border-border bg-surface-2 px-2 py-2 font-condensed text-2xs font-bold uppercase tracking-wide text-foreground"
            >
              <option value="">Todas as categorias</option>
              {categories.map((entry) => (
                <option key={entry.category} value={entry.category}>
                  {entry.category} ({String(entry.total)})
                </option>
              ))}
            </select>
          </label>
        </div>

        {error !== null && (
          <StateBlock variant="error" title="Não consegui ler o catálogo" detail={error} />
        )}

        {items === null && error === null && <StateBlock variant="loading" title="Lendo…" />}

        {items !== null && items.length === 0 && (
          <StateBlock
            variant="empty"
            title={total === 0 && busca === '' ? 'O catálogo está vazio' : 'Nada com esses filtros'}
            detail={
              total === 0 && busca === ''
                ? (catalog?.note ?? 'O catálogo é preenchido quando o primeiro servidor subir.')
                : 'Tente parte do nome em inglês ("rifle"), o shortname, ou outra categoria.'
            }
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
                  <HeaderCell>Shortname</HeaderCell>
                  <HeaderCell>Nome</HeaderCell>
                  <HeaderCell>Categoria</HeaderCell>
                  <HeaderCell className="text-right">Empilha</HeaderCell>
                  <HeaderCell>Tem condição</HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {items.map((item) => (
                  <tr key={item.shortname} className="hover:bg-surface-2">
                    {/* O ícone vem do PACOTE do painel, e não do
                        agente: ele só existe na instalação do
                        cliente do Rust. Ver components/item-icon.tsx. */}
                    <td className="py-1 pl-3 pr-0">
                      <ItemIcon shortname={item.shortname} />
                    </td>

                    <td className="px-3 py-2">
                      <span className="font-mono text-2xs text-foreground">{item.shortname}</span>
                      {item.removed && (
                        // O item continua no agente porque um kit
                        // do mês passado aponta para ele — mas o
                        // jogo não o tem mais, e isso precisa
                        // aparecer.
                        <span
                          className="ml-2 border border-rust px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-rust"
                          title="O jogo não lista mais este item nesta versão. Ele fica aqui porque kits e entregas antigos podem apontar para ele."
                        >
                          fora do jogo
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{item.displayName || EM_DASH}</td>
                    <td className="px-3 py-2 text-muted">{item.category || EM_DASH}</td>
                    <td className="px-3 py-2 text-right text-muted">
                      {formatInteger(item.maxStack)}
                    </td>
                    <td className="px-3 py-2 text-muted">{item.hasCondition ? 'sim' : EM_DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {items !== null && total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-2xs text-muted">
              {String(inicio)}–{String(fim)} de {formatInteger(total)}
            </p>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Anterior
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={fim >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Próxima
              </Button>
            </div>
          </div>
        )}

        <p className="text-2xs leading-relaxed text-muted">
          O <strong>shortname</strong> é o que todo comando do jogo recebe —{' '}
          <code>inventory.give</code>, o kit, a entrega — e ele não muda entre wipes. O catálogo é
          relido sozinho quando a <strong>versão do jogo</strong> muda, e não de tempos em tempos:
          item não envelhece com o relógio, envelhece com o update.
        </p>
      </div>
    </div>
  );
}
