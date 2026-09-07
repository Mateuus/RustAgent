'use client';

// ============================================================
//  betterloot-panel.tsx  -  a aba Tabelas: o editor de loot.
//
//  ####  TRÊS COLUNAS, COMO O LOOTY  ####
//
//  Caixas à esquerda, a caixa aberta no meio, o catálogo e a prévia
//  à direita. Copiar o desenho é decisão, não preguiça: os admins
//  de Rust já conhecem esse mapa, e o vocabulário que eles vão
//  procurar no YouTube e no Discord é o do BetterLoot. Inventar um
//  terceiro layout é fazer o nosso painel competir com a
//  documentação alheia.
//
//  ####  A CONFIGURAÇÃO É DE UM SERVIDOR, E NÃO DA REDE  ####
//
//  Ao contrário de tudo o mais nesta página, isto NÃO é cadastro do
//  agente: é um arquivo no disco de UM servidor, lido de lá e
//  escrito de volta lá. Por isso o seletor de servidor não é um
//  filtro — é o que decide qual arquivo está aberto, e trocá-lo
//  troca a tela inteira.
//
//  ####  SALVAR SUBSTITUI O ARQUIVO INTEIRO  ####
//
//  O plugin serializa o dicionário todo; não existe merge. Duas
//  telas abertas na mesma caixa fariam a segunda apagar a primeira
//  em silêncio — e "em silêncio" é o problema, não "apagar".
//
//  A defesa é a `revision`: a tela guarda a que leu e a devolve no
//  PUT. Quando o disco mudou por baixo, o agente recusa, e a tela
//  diz o que aconteceu em vez de sobrescrever. É o mesmo papel do
//  `appliedSha` da biblioteca de plugins.
//
//  ####  O QUE VOLTA NÃO É O QUE FOI ENVIADO  ####
//
//  O plugin reescreve o arquivo depois de ler: preenche
//  durabilidade, remove acessório incompatível e decide sozinho o
//  "pode virar blueprint" (`scanEntry`). Por isso a tela adota a
//  RESPOSTA como novo estado, e não o rascunho que ela mandou —
//  senão mostraria ao admin o que ele pediu, e não o que o servidor
//  tem.
// ============================================================

import { RotateCcw, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BetterLootAddItem } from '@/components/loot/betterloot-add-item';
import { BetterLootPreview } from '@/components/loot/betterloot-preview';
import { BetterLootTableEditor } from '@/components/loot/betterloot-table-editor';
import { BetterLootTableList } from '@/components/loot/betterloot-table-list';
import {
  isLatest,
  joinRequest,
  openRequest,
  readTableInto,
} from '@/components/loot/betterloot-sequence';
import { BetterLootGlobalsBar } from '@/components/loot/betterloot-globals-bar';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import {
  agent,
  type BetterLootGlobalsInput,
  type BetterLootStatusResponse,
  type BetterLootTable,
} from '@/lib/api';

interface BetterLootPanelProps {
  readonly servers: readonly { id: string; name: string }[];
}

export function BetterLootPanel({ servers }: BetterLootPanelProps) {
  const [serverId, setServerId] = useState('');
  const [status, setStatus] = useState<BetterLootStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  /** O que o disco tinha quando a caixa abriu. É o alvo do "descartar". */
  const [saved, setSaved] = useState<BetterLootTable | null>(null);
  /** O que o admin mexeu. */
  const [draft, setDraft] = useState<BetterLootTable | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [loadingTable, setLoadingTable] = useState(false);
  const [saving, setSaving] = useState(false);

  /**
   * Qual leitura de CAIXA é a que vale — e quem pode repovoar o rascunho.
   *
   * ####  DUAS CAIXAS CLICADAS RÁPIDO TROCAM DE LUGAR  ####
   *
   * Uma tabela de 211 entradas demora mais que uma de 3. Clicar na
   * grande e depois na pequena faz a resposta da GRANDE chegar por
   * último — e ela sobrescreveria a pequena, deixando a tela
   * mostrando uma caixa com o nome de outra selecionado ao lado.
   *
   * Trocar de SERVIDOR no meio é a mesma doença com a consequência
   * grave: a caixa do disco anterior volta para um rascunho que o
   * "Gravar" mandaria para o servidor de agora.
   *
   * A gravação divide este contador com a leitura porque as duas
   * escrevem em `saved`/`draft` — mas ela ENTRA NA FILA em vez de
   * abrir pedido; ver `betterloot-sequence.ts`.
   */
  const tableSeq = useRef(0);
  /**
   * Qual leitura de ESTADO é a que vale.
   *
   * Contador separado de propósito: um recarregamento de estado não
   * pode invalidar a leitura de caixa que estiver no ar — ela ficaria
   * com o "Lendo a caixa…" preso, porque quem o apaga confere o
   * contador antes.
   *
   * Ele não precisa ser tocado na troca de servidor: a própria troca
   * dispara um `loadStatus` novo, e é esse pedido que passa a valer.
   */
  const statusSeq = useRef(0);

  // Um servidor só não é escolha: escolher por quem não tem opção é
  // uma tela a mais entre o admin e o trabalho dele.
  useEffect(() => {
    if (serverId === '' && servers.length > 0) {
      setServerId(servers[0]?.id ?? '');
    }
  }, [servers, serverId]);

  const loadStatus = useCallback(async () => {
    if (serverId === '') {
      return;
    }

    const ticket = openRequest(statusSeq);

    try {
      const response = await agent.betterLootStatus(serverId);

      // O estado de OUTRO servidor não pode entrar aqui: é dele que
      // sai a `revision` que o próximo PUT devolve, e gravar com a
      // revisão do disco errado é exatamente o que a `revision`
      // existe para impedir.
      if (!isLatest(statusSeq, ticket)) {
        return;
      }

      setStatus(response);
      setStatusError(null);
    } catch (cause) {
      if (!isLatest(statusSeq, ticket)) {
        return;
      }

      setStatus(null);
      setStatusError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Trocar de servidor troca o arquivo: o que estava aberto era de
  // outro disco, e mantê-lo na tela ofereceria salvar a caixa de um
  // servidor por cima do outro.
  useEffect(() => {
    // Invalida o que estiver no ar: sem isto, a caixa do servidor
    // ANTERIOR chegaria depois da troca e abriria na tela do novo,
    // com o nome certo e o conteúdo de outro disco.
    openRequest(tableSeq);
    setSelected(null);
    setSaved(null);
    setDraft(null);
    setTableError(null);
    setLoadingTable(false);
  }, [serverId]);

  const openTable = useCallback(
    async (prefab: string) => {
      setSelected(prefab);

      // O `serverId` fica preso na função que lê: a resposta pode
      // demorar, mas ela pergunta pelo disco que o admin escolheu no
      // clique, e não pelo que estiver escolhido quando ela voltar.
      await readTableInto(
        tableSeq,
        async () => (await agent.betterLootTable(serverId, prefab)).table,
        {
          setSaved,
          setDraft,
          setError: setTableError,
          setLoading: setLoadingTable,
        },
      );
    },
    [serverId],
  );

  const dirty = useMemo(
    () => draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  const save = async (): Promise<void> => {
    if (draft === null || status === null) {
      return;
    }

    // Entra na fila sem invalidar ninguém: se uma leitura de caixa
    // estiver no ar, ela é que manda no `saved`/`draft` quando voltar
    // — e cortá-la aqui deixaria o "Lendo a caixa…" preso.
    const ticket = joinRequest(tableSeq);

    setSaving(true);

    try {
      // O `serverId` e a `revision` são os do clique: o PUT vai para
      // o disco que o admin estava vendo, mesmo que ele troque de
      // servidor enquanto a gravação está no ar.
      const response = await agent.saveBetterLootTable(serverId, {
        baseRevision: status.revision,
        table: draft,
      });

      // ####  GRAVOU, MAS A TELA JÁ É DE OUTRA  ####
      //
      // A gravação valeu — o servidor tem o arquivo novo. O que não
      // pode é a resposta voltar para uma tela que já mudou de caixa
      // ou de servidor: ela repovoaria o rascunho com a caixa errada,
      // e o próximo "Gravar" a mandaria para o disco de agora.
      //
      // Recarregar o estado daqui também não serve: este `loadStatus`
      // é o do servidor de antes, e ele venceria o que a troca
      // acabou de disparar.
      if (!isLatest(tableSeq, ticket)) {
        toast.success('Caixa gravada e plugin recarregado.');

        return;
      }

      // A resposta manda, e não o rascunho — ver o cabeçalho.
      setSaved(response.table);
      setDraft(response.table);
      toast.success('Caixa gravada e plugin recarregado.');

      // A lista traz contagens que acabaram de mudar, e a revisão
      // nova precisa valer para o próximo salvamento.
      await loadStatus();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // Sem guarda: `saving` trava a tela inteira, e deixá-lo ligado
      // por causa de uma corrida seria trocar um estado errado por
      // uma tela morta.
      setSaving(false);
    }
  };

  /**
   * Grava o que vale no servidor inteiro.
   *
   * ####  OUTRO ARQUIVO, OUTRA REVISÃO  ####
   *
   * O `baseRevision` daqui é o `configRevision` — o sha do
   * `BetterLoot.json` —, e não o da tabela. Mandar o da tabela
   * faria toda gravação de multiplicador ser recusada, porque
   * recarregar o plugin reescreve o `LootTables.json` sozinho.
   *
   * ####  E POR ISSO O ESTADO É RECARREGADO NO FIM  ####
   *
   * O `oxide.reload` reescreve a TABELA no disco. Sem a releitura,
   * a `revision` que a tela guarda envelhece e o próximo "Gravar"
   * de uma caixa seria recusado com um conflito que não existiu.
   */
  const saveGlobals = async (input: BetterLootGlobalsInput): Promise<void> => {
    if (status === null) {
      return;
    }

    // Entra na fila sem invalidar ninguém: uma leitura de estado no
    // ar continua valendo, e cortá-la aqui não traria nada.
    const ticket = joinRequest(statusSeq);

    try {
      const response = await agent.saveBetterLootGlobals(serverId, {
        baseRevision: status.configRevision,
        globals: input,
      });

      toast.success(
        response.reloaded
          ? 'Multiplicadores gravados e plugin recarregado.'
          : 'Multiplicadores gravados. O plugin não pôde ser recarregado agora — eles valem no próximo carregamento.',
      );

      // A tela pode já ser de outro servidor: recarregar o estado
      // daqui traria o disco de antes para a tela de agora.
      if (!isLatest(statusSeq, ticket)) {
        return;
      }

      await loadStatus();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (servers.length === 0) {
    return (
      <StateBlock
        variant="empty"
        title="Nenhum servidor cadastrado"
        detail="A tabela de loot é um arquivo no disco de um servidor. Sem servidor não há arquivo para abrir."
      />
    );
  }

  return (
    <div className="space-y-3">
      <BetterLootHeader
        servers={servers}
        serverId={serverId}
        onServerChange={setServerId}
        status={status}
        error={statusError}
        busy={saving}
        onSaveGlobals={saveGlobals}
      />

      {status !== null && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_minmax(0,22rem)]">
          <div className="h-[38rem]">
            <BetterLootTableList
              tables={status.tables}
              selected={selected}
              onSelect={(prefab) => void openTable(prefab)}
            />
          </div>

          <div className="flex h-[38rem] min-w-0 flex-col gap-2">
            {draft !== null && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {dirty && (
                  <span className="mr-auto text-2xs text-amber">
                    Mudanças não gravadas nesta caixa.
                  </span>
                )}
                <Button
                  size="sm"
                  disabled={!dirty || saving}
                  onClick={() => setDraft(saved)}
                  className="flex items-center gap-1"
                >
                  <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                  Descartar
                </Button>
                <Button
                  variant="confirm"
                  size="sm"
                  disabled={!dirty || saving}
                  onClick={() => void save()}
                  className="flex items-center gap-1"
                >
                  <Save aria-hidden="true" className="h-3.5 w-3.5" />
                  {saving ? 'Gravando…' : 'Gravar e recarregar'}
                </Button>
              </div>
            )}

            <div className="min-h-0 flex-1">
              <BetterLootTableBody
                selected={selected}
                loading={loadingTable}
                error={tableError}
                table={draft}
                onChange={setDraft}
                busy={saving}
              />
            </div>
          </div>

          <div className="flex h-[38rem] min-w-0 flex-col gap-3">
            {/* ####  A `key` ZERA O ITEM ESCOLHIDO AO TROCAR DE CAIXA  ####
                Sem ela o React reaproveita o componente, e o item que
                o admin escolheu para a caixa A continua no campo
                quando a B abre — o "Acrescentar" o poria na B.
                A prévia ao lado NÃO leva `key` de propósito: manter
                "quantas caixas abrir" entre as trocas é o desejado. */}
            {draft !== null && (
              <BetterLootAddItem
                key={draft.prefab}
                table={draft}
                serverId={serverId}
                busy={saving}
                onAdd={(entry) =>
                  setDraft({
                    ...draft,
                    items: [...draft.items, entry],
                    itemCount: draft.items.length + 1,
                  })
                }
              />
            )}

            {draft !== null && <BetterLootPreview table={draft} globals={status.globals} />}
          </div>
        </div>
      )}
    </div>
  );
}

function BetterLootTableBody({
  selected,
  loading,
  error,
  table,
  onChange,
  busy,
}: {
  readonly selected: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly table: BetterLootTable | null;
  readonly onChange: (next: BetterLootTable) => void;
  readonly busy: boolean;
}) {
  if (selected === null) {
    return (
      <StateBlock
        variant="empty"
        title="Escolha uma caixa"
        detail="A lista ao lado é a do arquivo daquele servidor: só aparece o que o plugin realmente gerencia ali."
      />
    );
  }

  if (loading) {
    return <StateBlock variant="loading" title="Lendo a caixa…" />;
  }

  if (error !== null) {
    return <StateBlock variant="error" title="Não consegui ler esta caixa" detail={error} />;
  }

  if (table === null) {
    return <StateBlock variant="empty" title="Esta caixa veio vazia" />;
  }

  // ####  A `key` ZERA O AVISO DE MULTIPLICAÇÃO AO TROCAR DE CAIXA  ####
  //
  // O editor guarda um fator escolhido e ainda não aplicado. Sem
  // remontar, esse aviso atravessaria a troca: o admin escolhe 10x
  // na caixa de elite, clica no barril, e o "Aplicar 10x" continua
  // ali — mirando o barril. É a mesma razão da `key` do
  // `BetterLootAddItem` ao lado.
  return <BetterLootTableEditor key={table.prefab} table={table} onChange={onChange} busy={busy} />;
}

/**
 * A faixa do topo: o servidor, o plugin e o que vale para o mundo todo.
 *
 * ####  O MULTIPLICADOR MORA AQUI, E NÃO NA CAIXA  ####
 *
 * `Loot Multiplier` e `Scrap Multipler` são do servidor INTEIRO, e
 * inteiros — não existe 2x só nos barris nem 1,5x em lugar nenhum.
 * Um controle de multiplicador dentro da caixa mentiria sobre o
 * alcance; aqui em cima ele diz a verdade sobre o próprio.
 *
 * O menu de "2x nesta caixa" que existe dentro do editor é OUTRA
 * operação, e não este campo com outro nome: ele reescreve o
 * mín./máx. de cada entrada daquela caixa, e não sai dela.
 *
 * E eles multiplicam a QUANTIDADE, não a chance: 5x não dá cinco
 * vezes mais itens, dá os mesmos itens com quantidade cinco vezes
 * maior. Quem controla "quantos itens saem" é o mín./máx. de itens
 * de cada caixa.
 */
function BetterLootHeader({
  servers,
  serverId,
  onServerChange,
  status,
  error,
  busy,
  onSaveGlobals,
}: {
  readonly servers: readonly { id: string; name: string }[];
  readonly serverId: string;
  readonly onServerChange: (id: string) => void;
  readonly status: BetterLootStatusResponse | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly onSaveGlobals: (input: BetterLootGlobalsInput) => Promise<void>;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-2xs leading-relaxed text-muted">
          A configuração de loot que o servidor realmente carregou. O painel a lê do disco dele, e
          o que for gravado aqui substitui o arquivo e recarrega o plugin — sem baixar nem subir
          nada.
        </p>

        <label className="flex items-center gap-2 text-2xs text-muted">
          Servidor
          <select
            value={serverId}
            onChange={(event) => onServerChange(event.target.value)}
            className="h-8 border border-border bg-surface-2 px-2 text-2xs text-foreground"
          >
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error !== null && (
        <StateBlock
          variant="error"
          title="Não consegui ler a configuração de loot deste servidor"
          detail={
            <>
              {error} — se o agente ainda não tem a rota{' '}
              <span className="font-mono">/api/servers/:id/betterloot</span>, ou se o BetterLoot não
              está instalado ali, esta aba fica assim até isso mudar.
            </>
          }
        />
      )}

      {status !== null && status.loaded === false && (
        <StateBlock
          variant="offline"
          title="O BetterLoot não está carregado neste servidor"
          detail="O arquivo abaixo pode ser lido e editado, mas nada do que for gravado vale enquanto o plugin não subir."
        />
      )}

      {/* ####  A `key` REFAZ O RASCUNHO QUANDO O DISCO MUDA  ####
          Gravou, a revisão do BetterLoot.json muda e a faixa
          remonta a partir do que o servidor tem — em vez de
          continuar mostrando o que foi enviado. Trocar de servidor
          faz o mesmo, e é o que impede o multiplicador de um disco
          de ficar na tela do outro. */}
      {status !== null && (
        <BetterLootGlobalsBar
          key={`${serverId}:${status.configRevision ?? 'sem-config'}`}
          globals={status.globals}
          managed={{
            enabled: status.tables.filter((table) => table.enabled).length,
            total: status.count,
          }}
          busy={busy}
          onSave={onSaveGlobals}
        />
      )}

      {status !== null && status.blacklist.length > 0 && (
        <p className="text-2xs leading-relaxed text-muted">
          <strong className="text-foreground">Lixo removido do servidor inteiro:</strong>{' '}
          {status.blacklist.join(', ')} — a lista é global, e não desta caixa. Para tirar um item de
          uma caixa só, tire-o da lista dela.
        </p>
      )}
    </div>
  );
}
