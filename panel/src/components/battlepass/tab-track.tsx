'use client';

// ============================================================
//  tab-track.tsx  -  os níveis da temporada, faixa grátis e faixa
//  paga lado a lado. É a tela onde o admin monta o mês.
//
//  ####  O EDITOR DE RECOMPENSA NÃO É NOVO  ####
//
//  É o `RewardList` (components/rewards/reward-list.tsx:70), o
//  mesmo das missões e do KOTH — e ele já edita item, OZCoin, kit,
//  pontos, VIP e skin. O cabeçalho dele explica por que foi
//  extraído: duas telas para a mesma pergunta divergiriam no
//  primeiro tipo novo, e "a que ficasse para trás ofereceria menos,
//  sem avisar ninguém".
//
//  ####  NÍVEL VAZIO É LEGÍTIMO  ####
//
//  Nem todo nível precisa dar alguma coisa nas duas faixas. O `—`
//  é uma resposta, e esta tela não pede que ninguém preencha 60
//  células antes de publicar.
//
//  ####  A TELA DIZ QUANTO TEMPO LEVA  ####
//
//  É a linha do topo, e ela existe porque a falha nº 1 dos passes
//  — medida nos sete jogos de referência (05 §4.4) — é a temporada
//  que NÃO DÁ PARA TERMINAR. A conta sai da curva desta temporada
//  contra os tetos diários da aba XP; o alvo é ser completável uma
//  semana antes do fim.
//
//  A leitura das regras de XP é SECUNDÁRIA: sem ela a trilha
//  continua editável, e o que some é a estimativa — que diz isso em
//  vez de sumir calada.
// ============================================================

import { Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  LANE_LABELS,
  cellKey,
  describeReward,
  estimateTrack,
  isKnownRewardKind,
  messageOf,
  periodLabel,
  safeTrackCells,
  safeXpRules,
  xpToReach,
} from '@/components/battlepass/normalize';
import { SeasonPicker } from '@/components/battlepass/season-picker';
import { StateBadge } from '@/components/battlepass/state-badge';
import { RewardAddMenu, RewardList } from '@/components/rewards/reward-list';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { HelpTip } from '@/components/ui/help-tip';
import { Toggle } from '@/components/ui/toggle';
import { BATTLEPASS_HELP } from '@/lib/help/battlepass';
import {
  agent,
  type BattlePassLane,
  type BattlePassSeason,
  type BattlePassTrackCell,
  type BattlePassXpRule,
  type QuestReward,
} from '@/lib/api';
import { formatInteger } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** A casa aberta no editor. */
interface Editing {
  readonly level: number;
  readonly lane: BattlePassLane;
}

export function TabTrack({
  seasons,
  season,
  onPickSeason,
}: {
  readonly seasons: readonly BattlePassSeason[];
  readonly season: BattlePassSeason | null;
  readonly onPickSeason: (seasonId: number) => void;
}) {
  const [cells, setCells] = useState<readonly BattlePassTrackCell[] | null>(null);
  const [rules, setRules] = useState<readonly BattlePassXpRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);

  const seasonId = season?.id ?? null;

  const load = useCallback(async () => {
    if (seasonId === null) {
      setCells(null);
      setLoading(false);

      return;
    }

    setLoading(true);

    try {
      setCells(safeTrackCells((await agent.battlePassTrack(seasonId)).cells));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
      setCells(null);
    }

    try {
      // Secundária: ela alimenta só a estimativa.
      setRules(safeXpRules((await agent.battlePassXpRules(seasonId)).rules));
    } catch {
      setRules(null);
    }

    setLoading(false);
  }, [seasonId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(level: number, lane: BattlePassLane, rewards: QuestReward[], milestone: boolean) {
    if (seasonId === null) return;

    setBusy(true);

    try {
      await agent.setBattlePassTrackCell(seasonId, level, lane, { rewards, milestone });
      toast.success(`Nível ${String(level)} · ${LANE_LABELS[lane]} salvo`);
      setEditing(null);
      await load();
    } catch (cause) {
      toast.error('Não consegui salvar a casa', { description: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function clear(level: number, lane: BattlePassLane) {
    if (seasonId === null) return;

    setBusy(true);

    try {
      await agent.clearBattlePassTrackCell(seasonId, level, lane);
      toast.success(`Nível ${String(level)} · ${LANE_LABELS[lane]} esvaziado`);
      setEditing(null);
      await load();
    } catch (cause) {
      toast.error('Não consegui esvaziar a casa', { description: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  const byKey = new Map((cells ?? []).map((cell) => [cellKey(cell.level, cell.lane), cell]));
  const opened = editing === null ? null : byKey.get(cellKey(editing.level, editing.lane)) ?? null;

  return (
    <div className="space-y-4">
      <SeasonPicker seasons={seasons} value={seasonId} busy={busy} onChange={onPickSeason} />

      {season !== null && (
        <>
          <Estimate season={season} rules={rules} />

          <Section
            title={`Trilha · ${periodLabel(season.period)}`}
            aside={
              <div className="flex items-center gap-2">
                <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
                  {formatInteger(season.levels)} níveis
                </span>
                <StateBadge state={season.state} />
              </div>
            }
            contentClassName="p-0"
          >
            {error !== null && (
              <div className="p-3">
                <StateBlock variant="error" title="Não consegui ler a trilha." detail={error} />
              </div>
            )}

            {loading && cells === null && error === null && (
              <div className="p-3">
                <StateBlock variant="loading" title="Lendo a trilha…" />
              </div>
            )}

            {cells !== null && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[48rem] text-left text-xs">
                  <thead className="border-b border-border font-condensed text-2xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="w-20 px-3 py-2">Nível</th>
                      <th className="w-28 px-3 py-2">XP</th>
                      <th className="px-3 py-2">
                        Grátis
                        {!season.freeLane && <LaneOff />}
                      </th>
                      <th className="px-3 py-2">
                        Pago
                        {!season.paidLane && <LaneOff />}
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {Array.from({ length: season.levels }, (_, index) => index + 1).map((level) => (
                      <tr key={level} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 font-condensed text-sm font-bold text-foreground">
                          {level}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted">
                          {/* O XP ACUMULADO que alcança este nível —
                              a mesma conta que o jogo mostra no card. */}
                          {formatInteger(xpToReach(season.xpCurve, level))}
                        </td>

                        {(['free', 'paid'] as const).map((lane) => (
                          <td key={lane} className="px-3 py-1">
                            <CellButton
                              cell={byKey.get(cellKey(level, lane)) ?? null}
                              busy={busy}
                              onOpen={() => setEditing({ level, lane })}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}

      {editing !== null && (
        <CellDialog
          level={editing.level}
          lane={editing.lane}
          cell={opened}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(rewards, milestone) => void save(editing.level, editing.lane, rewards, milestone)}
          onClear={() => void clear(editing.level, editing.lane)}
        />
      )}
    </div>
  );
}

/** A faixa está desligada: a coluna continua editável, e diz isso. */
function LaneOff() {
  return (
    <span className="ml-2 border border-amber px-1.5 py-0.5 text-2xs normal-case text-foreground">
      desligada nesta temporada
    </span>
  );
}

/**
 * Quanto tempo leva para terminar a trilha, no ritmo configurado.
 *
 * Ver o cabeçalho: é a linha que evita a temporada que ninguém
 * consegue terminar. Ela nunca esconde o número — quando não dá
 * para calcular, diz por que não dá.
 */
function Estimate({
  season,
  rules,
}: {
  readonly season: BattlePassSeason;
  readonly rules: readonly BattlePassXpRule[] | null;
}) {
  if (rules === null) {
    return (
      <StateBlock
        variant="empty"
        title="Não consegui ler as regras de XP deste mês."
        detail="A trilha abaixo continua editável; o que falta é a estimativa de quanto tempo ela leva. Abra a aba XP para ver o que aconteceu."
      />
    );
  }

  const estimate = estimateTrack({
    curve: season.xpCurve,
    levels: season.levels,
    rules,
    period: season.period,
  });

  if (estimate.paying === 0) {
    return (
      <StateBlock
        variant="error"
        title="Nenhuma fonte de XP ligada nesta temporada."
        detail={`A trilha custa ${formatInteger(estimate.totalXp)} XP e ninguém ganha XP nenhum: o jogador fica no nível 1 o mês inteiro. Ligue as fontes na aba XP.`}
      />
    );
  }

  const ritmo =
    estimate.days === null
      ? 'nenhuma das fontes ligadas tem teto diário, então não há ritmo para medir — a trilha depende só de quanto cada um jogar'
      : `no ritmo configurado (${formatInteger(estimate.dailyXp)} XP/dia somando os tetos), a trilha leva ~${String(estimate.days)} dias`;

  const detail = (
    <>
      {`A trilha inteira custa ${formatInteger(estimate.totalXp)} XP, e o mês tem ${
        estimate.monthDays === null ? '—' : String(estimate.monthDays)
      } dias. `}
      {estimate.uncapped > 0 &&
        `${String(estimate.uncapped)} fonte(s) ligada(s) sem teto diário não entram nesta conta: elas só encurtam o prazo. `}
      O alvo é terminar cerca de uma semana antes do fim.
    </>
  );

  if (estimate.verdict === 'overrun') {
    return (
      <StateBlock
        variant="error"
        title={`Não dá para terminar esta trilha dentro do mês: ${ritmo}.`}
        detail={detail}
      />
    );
  }

  return (
    <div
      className={cn(
        'flex items-start gap-2 border-l-2 bg-surface-2 px-3 py-2 text-xs',
        estimate.verdict === 'tight' ? 'border-amber' : 'border-olive',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-foreground">
          {estimate.verdict === 'tight' ? 'Aperta: ' : ''}
          {ritmo}.
        </p>
        <p className="mt-1 text-muted">{detail}</p>
      </div>

      <HelpTip topic={BATTLEPASS_HELP.estimate} />
    </div>
  );
}

/** Uma casa da grade: o que ela dá, ou o convite para preencher. */
function CellButton({
  cell,
  busy,
  onOpen,
}: {
  readonly cell: BattlePassTrackCell | null;
  readonly busy: boolean;
  readonly onOpen: () => void;
}) {
  const rewards = cell?.rewards ?? [];

  return (
    <button
      type="button"
      disabled={busy}
      onClick={onOpen}
      className={cn(
        'w-full border px-2 py-1.5 text-left text-xs',
        'disabled:cursor-not-allowed disabled:opacity-50',
        rewards.length === 0
          ? 'border-dashed border-border text-muted hover:border-muted'
          : 'border-border bg-surface-2 text-foreground hover:border-muted',
      )}
    >
      {rewards.length === 0 ? (
        // Ausente é travessão, e o convite fica ao lado dele.
        <span>— &nbsp;adicionar recompensa</span>
      ) : (
        <span className="flex flex-wrap items-center gap-1">
          {rewards.map((reward, index) => (
            <span key={index} className="truncate">
              {describeReward(reward)}
              {index < rewards.length - 1 ? ' ·' : ''}
            </span>
          ))}

          {cell?.milestone === true && (
            <span className="border border-amber px-1 text-2xs uppercase text-foreground">
              marco
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/**
 * O editor de uma casa.
 *
 * ####  RECOMPENSA DE TIPO DESCONHECIDO NÃO SE PERDE AQUI  ####
 *
 * O PUT manda a lista INTEIRA. Um `kind` que este painel não sabe
 * editar (a frente B traz `xp`) sumiria no primeiro salvamento —
 * em silêncio, porque o que foi enviado é exatamente o que a tela
 * tinha. Elas ficam de fora do `RewardList`, aparecem listadas, e
 * voltam para o corpo no fim.
 */
function CellDialog({
  level,
  lane,
  cell,
  busy,
  onClose,
  onSave,
  onClear,
}: {
  readonly level: number;
  readonly lane: BattlePassLane;
  readonly cell: BattlePassTrackCell | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (rewards: QuestReward[], milestone: boolean) => void;
  readonly onClear: () => void;
}) {
  const initial = cell?.rewards ?? [];
  const untouchable = initial.filter((reward) => !isKnownRewardKind(reward.kind));

  const [rewards, setRewards] = useState<readonly QuestReward[]>(
    initial.filter((reward) => isKnownRewardKind(reward.kind)),
  );
  const [milestone, setMilestone] = useState(cell?.milestone === true);

  return (
    <Dialog
      open
      title={`Nível ${String(level)} · faixa ${LANE_LABELS[lane].toLowerCase()}`}
      busy={busy}
      guarded
      escapable
      onClose={onClose}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Marco</span>
            <HelpTip topic={BATTLEPASS_HELP.milestone} />
          </div>

          <Toggle
            on={milestone}
            busy={busy}
            label="Marco"
            labels={['É marco', 'Comum']}
            onChange={setMilestone}
          />
        </div>

        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              O que esta casa dá
            </span>
            <RewardAddMenu
              value={rewards}
              onChange={(next) => setRewards(next)}
            />
          </div>

          <RewardList
            value={rewards}
            onChange={(next) => setRewards(next)}
            emptyHint="Nada aqui — e isso é uma resposta: nem todo nível precisa dar alguma coisa nas duas faixas."
          />

          {untouchable.length > 0 && (
            <StateBlock
              variant="empty"
              title={`${String(untouchable.length)} recompensa(s) que este painel não sabe editar.`}
              detail={
                <>
                  {untouchable.map((reward) => describeReward(reward)).join(', ')}. Elas ficam como
                  estão e são salvas junto — um painel mais velho que o agente não apaga o que ainda
                  não entende.
                </>
              }
            />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" disabled={busy || cell === null} onClick={onClear}>
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            Esvaziar a casa
          </Button>

          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => onSave([...rewards, ...untouchable], milestone)}
            >
              {busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
              Salvar
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
