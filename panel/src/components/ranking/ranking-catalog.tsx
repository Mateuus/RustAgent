'use client';

// ============================================================
//  ranking-catalog.tsx  -  o cadastro: quais rankings existem.
//
//  ####  OS SEMEADOS NÃO TÊM BOTÃO DE APAGAR  ####
//
//  Ausente, e não desabilitado: um botão que nunca funciona é pior
//  que um botão que não existe. Apagar "abates" deixaria o número
//  já contado sem definição — as linhas continuariam em
//  `player_stats`, invisíveis, e a coleta seguinte voltaria a
//  somá-las sem que nada as mostrasse.
//
//  ####  MAS A JANELA DELES É EDITÁVEL  ####
//
//  Porque a `window` é CONFIGURAÇÃO, e não definição: "quero manter
//  o ranking de abates e zerar o de minério" é uma escolha do dono
//  da rede, não uma propriedade do agente. Ver Docs/Ranking/20 §10.
//
//  ####  A ORDEM SE ARRASTA, E TAMBÉM SE DIGITA  ####
//
//  Arrastar é a forma natural de dizer "este vem antes daquele" —
//  mas uma tela que SÓ funciona com mouse exclui quem navega por
//  teclado. Por isso cada linha tem também ↑ e ↓, que chamam
//  exatamente a mesma rota. Não é enfeite de acessibilidade: é o
//  mesmo recurso por outra porta.
//
//  A API nativa do HTML5 (`draggable`, `dragover`, `drop`) dá
//  conta de uma lista vertical de sete linhas. Uma biblioteca de
//  arrasto entraria aqui para resolver o que este caso não tem:
//  listas virtualizadas, arrasto entre colunas, toque em celular
//  com auto-scroll.
// ============================================================

import { ChevronDown, ChevronUp, EyeOff, GripVertical, Plus, Trash2, Trophy } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import {
  SOURCE_LABELS,
  VALUE_KIND_LABELS,
  WINDOW_HINTS,
  WINDOW_LABELS,
} from '@/components/ranking/labels';
import {
  rankingToInput,
  RankingDialog,
  TROPHY_BLEIK_PRESET,
} from '@/components/ranking/ranking-dialog';
import { moveInOrder, sameOrder } from '@/components/ranking/reorder';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { agent, type RankingDefinition, type RankingDefinitionInput } from '@/lib/api';
import { EM_DASH } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface RankingCatalogProps {
  readonly rankings: readonly RankingDefinition[];
  readonly error: string | null;
  readonly onChanged: () => void;
}

export function RankingCatalog({ rankings, error, onChanged }: RankingCatalogProps) {
  const [editing, setEditing] = useState<RankingDefinition | null>(null);
  const [preset, setPreset] = useState<Partial<RankingDefinitionInput> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * A ordem que a TELA está mostrando, quando ela adiantou o
   * servidor. `null` = a da prop, que é a última que o agente
   * confirmou.
   */
  const [order, setOrder] = useState<readonly RankingDefinition[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  /** O que o leitor de tela ouve depois de um ↑ ou ↓. */
  const [announcement, setAnnouncement] = useState('');
  /** Depois de mover pelo teclado, o foco volta para o mesmo botão. */
  const [focusAfterMove, setFocusAfterMove] = useState<{
    readonly id: string;
    readonly direction: 'up' | 'down';
  } | null>(null);

  /**
   * Qual gravação de ordem é a mais nova.
   *
   * Dois cliques rápidos no ↑ põem duas chamadas no ar. Sem este
   * contador, a resposta da primeira mandaria recarregar — e a
   * lista voltaria por um instante para a ordem intermediária,
   * como se o segundo clique não tivesse acontecido.
   */
  const orderSeq = useRef(0);
  /** Os botões ↑/↓, por `direção:id`, para devolver o foco. */
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());

  const rows = order ?? rankings;

  // O agente respondeu com uma lista nova: ela manda. O adiantamento
  // da tela existe só enquanto a gravação está no ar.
  useEffect(() => {
    setOrder(null);
  }, [rankings]);

  // ####  O FOCO NÃO PODE CAIR NO NADA  ####
  //
  // Quem apertou ↑ está com o dedo no teclado: se o foco sumir a
  // cada movimento, subir três posições vira três voltas de Tab.
  // Na ponta da lista aquele botão fica desabilitado — e aí o par
  // dele, que continua no lugar, recebe o foco.
  useEffect(() => {
    if (focusAfterMove === null) return;

    const preferred = moveButtons.current.get(`${focusAfterMove.direction}:${focusAfterMove.id}`);
    const other = moveButtons.current.get(
      `${focusAfterMove.direction === 'up' ? 'down' : 'up'}:${focusAfterMove.id}`,
    );

    (preferred?.disabled === false ? preferred : other)?.focus();
    setFocusAfterMove(null);
  }, [focusAfterMove, rows]);

  /** O Troféu Bleik já existe? Aí o atalho sai da tela. */
  const hasTrophy = rankings.some((entry) => entry.metric === TROPHY_BLEIK_PRESET.metric);

  /**
   * Grava a ordem inteira, com a tela já na frente.
   *
   * ####  E COM VOLTA ATRÁS SE O AGENTE RECUSAR  ####
   *
   * `setOrder(null)` devolve a lista da prop — que é, por
   * construção, a última ordem que o agente confirmou. Uma tela
   * parada numa ordem que o banco não tem é pior que uma tela que
   * demorou: no recarregamento seguinte ela mudaria sozinha, e
   * ninguém saberia dizer qual das duas valia.
   */
  const applyOrder = async (
    next: readonly RankingDefinition[],
    announce: string,
  ): Promise<void> => {
    setOrder(next);
    setAnnouncement(announce);
    setSavingOrder(true);

    const seq = orderSeq.current + 1;

    orderSeq.current = seq;

    try {
      // A rota quer a lista INTEIRA: uma parcial deixaria a posição
      // dos ausentes indefinida, e ela recusa com
      // RANKING_ORDER_MISMATCH em vez de adivinhar.
      const response = await agent.reorderRankings(next.map((entry) => entry.id));

      // Já saiu um pedido depois deste: quem manda na tela é o mais novo.
      if (orderSeq.current !== seq) return;

      // ####  A RESPOSTA JÁ TRAZ O `sortOrder` REESCRITO  ####
      //
      // Ficar com os objetos antigos até o recarregamento chegar
      // deixaria a tela com 10, 20, 30… velhos — e um "Desligar"
      // clicado nesse intervalo mandaria de volta, num PUT que
      // reescreve o ranking inteiro, a posição que acabou de sair.
      setOrder(response.rankings);
      setSavingOrder(false);
      onChanged();
    } catch (cause) {
      if (orderSeq.current !== seq) return;

      setSavingOrder(false);
      setOrder(null);
      setAnnouncement('Não deu para gravar: a ordem voltou para a anterior.');
      // A frase é do CORE — é ela que sabe quais ids faltaram ou
      // sobraram na lista recusada.
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Leva a linha de `from` para `to`, se isso mudar alguma coisa. */
  const moveTo = (from: number, to: number): void => {
    const moved = rows[from];

    if (moved === undefined) return;

    const next = moveInOrder(rows, from, to);

    // Soltou de volta no mesmo lugar: não se gasta uma gravação com
    // um arrasto que não moveu nada.
    if (sameOrder(next, rows)) return;

    void applyOrder(
      next,
      `${moved.label} agora é o ${String(to + 1)}º de ${String(rows.length)}.`,
    );
  };

  const moveByKeyboard = (index: number, direction: 'up' | 'down'): void => {
    const moved = rows[index];

    if (moved === undefined) return;

    moveTo(index, direction === 'up' ? index - 1 : index + 1);
    setFocusAfterMove({ id: moved.id, direction });
  };

  /** Quem está sendo arrastado, para saber de que lado a linha cai. */
  const draggingIndex = dragging === null ? -1 : rows.findIndex((entry) => entry.id === dragging);

  const openDialog = (
    ranking: RankingDefinition | null,
    withPreset?: Partial<RankingDefinitionInput>,
  ): void => {
    setEditing(ranking);
    setPreset(withPreset);
    setOpen(true);
  };

  const toggle = async (ranking: RankingDefinition): Promise<void> => {
    setBusy(ranking.id);

    try {
      // O PUT reescreve o ranking inteiro (é a regra da rota), então
      // ligar e desligar manda a definição de volta com um campo
      // trocado — e não um PATCH que a API não tem.
      await agent.updateRanking(ranking.id, {
        ...rankingToInput(ranking),
        enabled: !ranking.enabled,
      });

      toast.success(ranking.enabled ? `"${ranking.label}" desligado` : `"${ranking.label}" ligado`);
      onChanged();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (ranking: RankingDefinition): Promise<void> => {
    setBusy(ranking.id);

    try {
      await agent.removeRanking(ranking.id);
      toast.success(`"${ranking.label}" apagado.`);
      onChanged();
    } catch (cause) {
      // A frase vem do CORE: ele sabe qual item custom aponta para
      // esta métrica, e a nossa tela não.
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-2xs leading-relaxed text-muted">
          Um ranking <strong>é uma linha</strong>, e não código: os que vieram com o agente e os que
          o admin cria usam a mesma consulta, a mesma tela e o mesmo histórico. A única diferença é
          que os semeados não podem ser apagados.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {/* ####  O CAMINHO DO TROFÉU BLEIK, EM UM CLIQUE  ####

              É o primeiro ranking dinâmico do projeto, e a
              demonstração de que criar um não exige código. O botão
              some quando ele já existe. */}
          {!hasTrophy && (
            <Button variant="primary" onClick={() => openDialog(null, TROPHY_BLEIK_PRESET)}>
              <Trophy aria-hidden="true" className="h-4 w-4" />
              Criar o Troféu Bleik Store
            </Button>
          )}

          <Button onClick={() => openDialog(null)}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Novo ranking
          </Button>
        </div>
      </div>

      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler o cadastro" detail={error} />
      )}

      {rankings.length === 0 && error === null && (
        <StateBlock
          variant="empty"
          title="Nenhum ranking cadastrado"
          detail="O agente semeia os fixos na migração 034. Se a lista está vazia, o banco deste agente ainda não subiu a migração — ou alguém apagou tudo o que podia ser apagado."
        />
      )}

      {rankings.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-muted">
          <p>
            Arraste pela alça <GripVertical aria-hidden="true" className="inline h-3.5 w-3.5" /> —
            ou use ↑ e ↓ — para mudar a ordem. Ela vale nos dois lugares:{' '}
            <strong>a coluna do menu do jogo e esta lista</strong>.
          </p>

          {savingOrder && <span className="text-amber">gravando a ordem…</span>}
        </div>
      )}

      {/* O leitor de tela não vê a linha pular de lugar. Ele ouve
          isto — e é o único jeito de o ↑ significar alguma coisa
          para quem não está olhando. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {rankings.length > 0 && (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                <HeaderCell className="w-28">Ordem</HeaderCell>
                <HeaderCell>Ranking</HeaderCell>
                <HeaderCell>Janela</HeaderCell>
                <HeaderCell>De onde vem</HeaderCell>
                <HeaderCell>Valor</HeaderCell>
                <HeaderCell>Rede</HeaderCell>
                <HeaderCell className="text-right">
                  <span className="sr-only">Ações</span>
                </HeaderCell>
              </tr>
            </thead>

            <tbody className="divide-y divide-border">
              {rows.map((ranking, index) => (
                <tr
                  key={ranking.id}
                  // ####  A LINHA INTEIRA É O ALVO DO DROP  ####
                  //
                  // Só a alça começa o arrasto (senão selecionar a
                  // métrica com o mouse viraria um arrasto), mas
                  // soltar em qualquer ponto da linha vale: mirar
                  // numa alça de 16 px seria um teste de pontaria.
                  onDragOver={(event) => {
                    if (dragging === null) return;

                    // Sem este `preventDefault` o navegador RECUSA o
                    // drop — é assim que a API nativa pergunta "pode
                    // soltar aqui?".
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';

                    // Sobre si mesma não há marca: soltar ali não
                    // muda nada, e uma marca prometeria que muda.
                    //
                    // Não há `onDragLeave` de propósito: ele borbulha
                    // de cada `<td>` que o cursor cruza, e o realce
                    // piscaria a cada célula. Quem apaga a marca é o
                    // `dragover` da linha seguinte, ou o `dragend`.
                    setDropTarget(dragging === ranking.id ? null : ranking.id);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();

                    const from = rows.findIndex((entry) => entry.id === dragging);

                    setDragging(null);
                    setDropTarget(null);

                    if (from < 0) return;

                    moveTo(from, index);
                  }}
                  className={cn(
                    'hover:bg-surface-2',
                    !ranking.enabled && 'opacity-60',
                    dragging === ranking.id && 'opacity-40',
                    // De que LADO a linha vai cair: vindo de cima ela
                    // fica depois da alvo, vindo de baixo, antes. A
                    // borda no lado certo é a diferença entre "vai
                    // para aqui" e "vai para perto daqui".
                    dropTarget === ranking.id &&
                      (draggingIndex >= 0 && draggingIndex < index
                        ? 'border-b-2 border-amber'
                        : 'border-t-2 border-amber'),
                  )}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      {/* `aria-hidden` porque arrastar não é uma
                          ação de teclado: anunciar um controle que
                          o teclado não opera daria a quem não usa
                          mouse um beco sem saída. A saída dele são
                          os dois botões ao lado. */}
                      <span
                        aria-hidden="true"
                        draggable
                        title="Arraste para mudar a ordem"
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', ranking.id);
                          setDragging(ranking.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setDropTarget(null);
                        }}
                        className="cursor-grab text-muted hover:text-foreground active:cursor-grabbing"
                      >
                        <GripVertical className="h-4 w-4" />
                      </span>

                      <span className="w-4 text-right text-2xs text-muted">
                        {String(index + 1)}
                      </span>

                      <MoveButton
                        direction="up"
                        ranking={ranking}
                        disabled={index === 0}
                        registry={moveButtons}
                        onMove={() => moveByKeyboard(index, 'up')}
                      />

                      <MoveButton
                        direction="down"
                        ranking={ranking}
                        disabled={index === rows.length - 1}
                        registry={moveButtons}
                        onMove={() => moveByKeyboard(index, 'down')}
                      />
                    </div>
                  </td>

                  <td className="px-3 py-2">
                    <span className="text-foreground">{ranking.label}</span>

                    {ranking.builtin && (
                      <span
                        className="ml-2 border border-muted px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
                        title="Veio semeado com o agente: não pode ser apagado, e a métrica dele não troca. A janela continua editável."
                      >
                        do agente
                      </span>
                    )}

                    {!ranking.enabled && (
                      <span
                        className="ml-2 border border-muted px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
                        title="Desligado não é apagado: o número continua contado, só sai das telas."
                      >
                        desligado
                      </span>
                    )}

                    {/* Fora do menu do jogo, e ainda assim aqui: é
                        essa a diferença entre este interruptor e o
                        de desligar. A etiqueta só aparece quando o
                        padrão foi contrariado. */}
                    {!ranking.showInGame && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 border border-muted px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
                        title="Sai do menu do jogo e continua no painel, no site e na contagem."
                      >
                        <EyeOff aria-hidden="true" className="h-3 w-3" />
                        fora do jogo
                      </span>
                    )}

                    <span className="ml-2 font-mono text-2xs text-muted">{ranking.metric}</span>

                    {ranking.shortLabel !== null && (
                      <span className="block text-2xs text-muted">
                        no jogo: <span className="text-foreground">{ranking.shortLabel}</span>
                      </span>
                    )}

                    {ranking.description !== null && (
                      <span className="block text-2xs text-muted">{ranking.description}</span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-2xs text-muted" title={WINDOW_HINTS[ranking.window]}>
                    {WINDOW_LABELS[ranking.window]}
                  </td>

                  <td className="px-3 py-2 text-2xs text-muted">{SOURCE_LABELS[ranking.source]}</td>

                  <td className="px-3 py-2 text-2xs text-muted">
                    {VALUE_KIND_LABELS[ranking.valueKind]}
                    <span className="block">
                      {ranking.unit ?? EM_DASH} ·{' '}
                      {ranking.direction === 'desc' ? 'maior na frente' : 'menor na frente'}
                    </span>
                  </td>

                  <td className="px-3 py-2 text-2xs">
                    {ranking.globalEligible ? (
                      <span className="text-muted">soma</span>
                    ) : (
                      <span
                        className="text-amber"
                        title="Não soma entre servidores: as taxas são diferentes, e a lista sairia ordenada por em que servidor a pessoa jogou."
                      >
                        só por servidor
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === ranking.id || savingOrder}
                        onClick={() => openDialog(ranking)}
                      >
                        Editar
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === ranking.id || savingOrder}
                        onClick={() => void toggle(ranking)}
                      >
                        {ranking.enabled ? 'Desligar' : 'Ligar'}
                      </Button>

                      {/* Ausente no `builtin`, e não desabilitado.
                          Ver o cabeçalho. */}
                      {!ranking.builtin && (
                        <ConfirmButton
                          variant="danger"
                          disabled={busy === ranking.id || savingOrder}
                          icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
                          label="Apagar"
                          confirmLabel="Apagar mesmo"
                          hint="Some do cadastro. O número já contado continua no banco, mas sem definição ninguém o mostra. Para só tirar das telas, use Desligar."
                          onConfirm={() => void remove(ranking)}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-2xs leading-relaxed text-muted">
        A <strong>janela</strong> diz em qual período aquele ranking disputa — e é ela que a tela de
        wipe lê para dizer o que vai zerar. Mudá-la não apaga nada: o número continua somando nas
        três janelas abertas, e o que muda é qual delas a lista abre.
      </p>

      <RankingDialog
        open={open}
        ranking={editing}
        preset={preset}
        onClose={() => setOpen(false)}
        onSaved={() => onChanged()}
      />
    </div>
  );
}

/**
 * O ↑ e o ↓ de uma linha — a mesma reordenação, sem mouse.
 *
 * ####  ELE SE REGISTRA NUM MAPA, E ISSO TEM MOTIVO  ####
 *
 * Depois do movimento a lista é redesenhada e o botão que recebeu
 * o clique deixa de existir naquela posição. Sem o mapa, o foco
 * cairia no `<body>` e quem sobe três posições precisaria tabular
 * de volta três vezes.
 */
function MoveButton({
  direction,
  ranking,
  disabled,
  registry,
  onMove,
}: {
  readonly direction: 'up' | 'down';
  readonly ranking: RankingDefinition;
  readonly disabled: boolean;
  readonly registry: RefObject<Map<string, HTMLButtonElement>>;
  readonly onMove: () => void;
}) {
  const key = `${direction}:${ranking.id}`;
  const Icon = direction === 'up' ? ChevronUp : ChevronDown;

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled}
      className="h-6 w-6 px-0"
      aria-label={`Mover ${ranking.label} para ${direction === 'up' ? 'cima' : 'baixo'}`}
      ref={(node) => {
        // O React 19 chama a limpeza em vez de mandar `null`, mas o
        // tipo ainda admite os dois — e um `null` no mapa faria o
        // foco procurar um botão que não existe mais.
        if (node === null) {
          registry.current.delete(key);
          return;
        }

        registry.current.set(key, node);

        return () => {
          registry.current.delete(key);
        };
      }}
      onClick={onMove}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
    </Button>
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
