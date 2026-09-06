'use client';

// ============================================================
//  server-ranking-panel.tsx  -  a JANELA daquele servidor.
//
//  ####  A TEMPORADA É POR SERVIDOR  ####
//
//  Mesma regra dos kits, do VIP e dos itens custom: o que vale num
//  servidor não vale nos outros por padrão. Um servidor sem linha
//  em `ranking_settings` usa os padrões do código — e é por isso
//  que a tela mostra "nunca configurado" em vez de fingir que
//  alguém escolheu aquilo.
//
//  ####  "QUANDO ELA VIRA" NÃO SAI DA CONFIGURAÇÃO  ####
//
//  A conta de fuso mora no agente (`rankings/periods.ts`) e chega
//  aqui pelo `period.turnsAt` de `GET /rankings`. Refazer a conta
//  no navegador seria a segunda conta de fuso do projeto — e a
//  segunda é a que diverge no primeiro ajuste.
// ============================================================

import { CalendarClock, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  formatUntil,
  periodTitle,
  SEASON_MODE_LABELS,
  WINDOW_LABELS,
} from '@/components/ranking/labels';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  agent,
  type RankingDefinition,
  type RankingSeasonMode,
  type RankingSettingsInput,
  type RankingSettingsResponse,
} from '@/lib/api';
import { EM_DASH, formatDateTime, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';

const SEASON_MODES: readonly RankingSeasonMode[] = [
  'wipe',
  'biweekly',
  'monthly',
  'quarterly',
  'days',
  'manual',
];

export function ServerRankingPanel({ serverId }: { readonly serverId: string }) {
  const [data, setData] = useState<RankingSettingsResponse | null>(null);
  const [form, setForm] = useState<RankingSettingsInput | null>(null);
  const [rankings, setRankings] = useState<readonly RankingDefinition[]>([]);
  const [turnsAt, setTurnsAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [turning, setTurning] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.rankingSettings(serverId);

      setData(response);
      setForm({
        seasonMode: response.settings.seasonMode,
        seasonDays: response.settings.seasonDays,
        // A âncora viaja de volta como veio: não mandá-la apagaria
        // de onde `biweekly` e `days` contam, só porque a tela não
        // tem campo para ela.
        seasonAnchorAt: response.settings.seasonAnchorAt,
        seasonOnWipe: response.settings.seasonOnWipe,
        snapshotSize: response.settings.snapshotSize,
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const catalog = await agent.rankingMetrics({ enabledOnly: true });

        if (!alive) return;

        setRankings(catalog.rankings);

        const first = catalog.rankings[0];

        if (first === undefined) return;

        // Qualquer ranking serve para perguntar QUANDO a temporada
        // vira: o `period=season` decide a janela, e a conta é a
        // mesma para todos.
        const page = await agent.ranking({
          metric: first.metric,
          scope: 'server',
          serverId,
          period: 'season',
          limit: 1,
          offset: 0,
        });

        if (alive) setTurnsAt(page.period.turnsAt);
      } catch {
        // Sem janela aberta o agente recusa com nome, e a tela
        // mostra travessão: "não sei" é resposta honesta, e a
        // configuração ao lado continua editável.
        if (alive) setTurnsAt(null);
      }
    })();

    return () => {
      alive = false;
    };
  }, [serverId]);

  const save = async (): Promise<void> => {
    if (form === null) return;

    setSaving(true);

    try {
      await agent.saveRankingSettings(serverId, form);
      toast.success('Janela do ranking salva');
      await load();
    } catch (cause) {
      toast.error('Não deu para salvar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSaving(false);
    }
  };

  if (error !== null) {
    return <StateBlock variant="error" title="Não consegui ler a janela deste servidor" detail={error} />;
  }

  if (data === null || form === null) {
    return <StateBlock variant="loading" title="Lendo a janela…" />;
  }

  const season = data.season;
  const open = season !== null && season.endedAt === null;
  /** Os que a virada da temporada zera aos olhos de quem joga. */
  const seasonal = rankings.filter((ranking) => ranking.window === 'season');

  return (
    <div className="space-y-4">
      <Section
        title="A temporada de agora"
        aside={
          <span className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted">
            <CalendarClock aria-hidden="true" className="h-4 w-4" />
            {open ? 'aberta' : 'nenhuma aberta'}
          </span>
        }
      >
        <div className="space-y-3">
          <dl className="grid gap-x-6 gap-y-1 text-2xs sm:grid-cols-2 lg:grid-cols-4">
            <Fact
              label="Temporada"
              value={season === null ? EM_DASH : periodTitle(season)}
              hint={season === null ? 'nenhuma janela ainda' : `#${String(season.id)}`}
            />
            <Fact
              label="Começou"
              value={season === null ? EM_DASH : formatDateTime(season.startedAt)}
              hint={season === null ? undefined : formatWhen(season.startedAt)}
            />
            <Fact
              label="Vira em"
              value={turnsAt === null ? 'sem data' : formatDateTime(turnsAt)}
              hint={
                turnsAt === null
                  ? 'no modo "só na mão" ela só fecha pelo botão'
                  : formatUntil(turnsAt)
              }
            />
            <Fact
              label="Configuração"
              value={SEASON_MODE_LABELS[data.settings.seasonMode]}
              hint={
                data.settings.updatedAt === null
                  ? 'nunca configurada: valem os padrões'
                  : `salva ${formatWhen(data.settings.updatedAt)}`
              }
            />
          </dl>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="danger" disabled={!open} onClick={() => setTurning(true)}>
              <RotateCcw aria-hidden="true" className="h-4 w-4" />
              Fechar e abrir nova agora
            </Button>

            <p className="max-w-xl text-2xs leading-relaxed text-muted">
              {open ? (
                <>
                  Fecha a temporada aberta e abre a seguinte na <strong>mesma transação</strong>: o
                  pódio das {String(data.settings.snapshotSize)} primeiras posições é congelado
                  antes, e continua consultável no histórico.
                </>
              ) : (
                <>
                  Este servidor não tem temporada aberta: ela nasce quando o coletor aplica o
                  primeiro lote. Antes disso não há o que fechar.
                </>
              )}
            </p>
          </div>
        </div>
      </Section>

      <Section title="Como a temporada vira">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="rs-mode">De quanto em quanto tempo</Label>
              <select
                id="rs-mode"
                value={form.seasonMode}
                onChange={(event) =>
                  setForm({ ...form, seasonMode: event.target.value as RankingSeasonMode })
                }
                className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
              >
                {SEASON_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {SEASON_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="rs-days">De quantos dias</Label>
              <Input
                id="rs-days"
                type="number"
                min={1}
                max={365}
                disabled={form.seasonMode !== 'days'}
                value={form.seasonDays ?? ''}
                onChange={(event) =>
                  setForm({
                    ...form,
                    seasonDays: event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              />
              <p className="mt-1 text-2xs text-muted">
                {form.seasonMode === 'days'
                  ? 'Obrigatório neste modo: uma temporada de N dias sem N nunca vence.'
                  : 'Só vale no modo "a cada N dias".'}
              </p>
            </div>

            <div>
              <Label htmlFor="rs-snapshot">Tamanho do pódio</Label>
              <Input
                id="rs-snapshot"
                type="number"
                min={1}
                max={500}
                value={form.snapshotSize}
                onChange={(event) =>
                  setForm({ ...form, snapshotSize: Number(event.target.value) || 1 })
                }
              />
              <p className="mt-1 text-2xs text-muted">
                Quantas posições são congeladas no fechamento. O resto continua no banco, mas fora do
                histórico.
              </p>
            </div>

            <div>
              <Label htmlFor="rs-anchor">Âncora</Label>
              <p
                id="rs-anchor"
                className="flex h-9 items-center border border-border bg-surface px-2 text-sm text-muted"
              >
                {form.seasonAnchorAt === null ? EM_DASH : formatDateTime(form.seasonAnchorAt)}
              </p>
              <p className="mt-1 text-2xs text-muted">
                De onde os modos por dias contam. Vazio = a abertura da temporada atual.
              </p>
            </div>
          </div>

          {/* ####  ISTO NÃO É O MESMO QUE `season_mode = wipe`  ####

              O modo diz que a temporada É o wipe (uma por mundo).
              Esta caixa diz que a temporada — mensal, de 15 dias, o
              que for — TAMBÉM vira quando o mundo vira. */}
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={form.seasonOnWipe}
              onChange={(event) => setForm({ ...form, seasonOnWipe: event.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-rust"
            />
            <span className="text-2xs leading-relaxed">
              <span className="font-condensed font-bold uppercase tracking-wide text-foreground">
                A temporada também vira quando o mundo vira
              </span>
              <span className="block text-muted">
                Vale para os dois tipos de wipe: o que o agente executa e o que alguém fez à mão com
                o servidor na unha — a âncora é o mundo, e não o painel. Cada execução de wipe pode
                abrir uma exceção a isto.
              </span>
            </span>
          </label>

          <div className="flex items-center gap-3">
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Salvando…' : 'Salvar a janela'}
            </Button>

            <p className="text-2xs text-muted">
              Trocar o modo <strong>não reabre</strong> a temporada em curso: ela termina como
              estava, e o modo novo vale para a seguinte.
            </p>
          </div>
        </div>
      </Section>

      <Section title="O que a virada da temporada zera">
        {seasonal.length === 0 ? (
          <p className="text-2xs text-muted">
            Nenhum ranking ligado disputa na temporada — a virada não muda nenhuma lista.
          </p>
        ) : (
          <p className="text-2xs leading-relaxed text-muted">
            <strong className="text-foreground">
              {seasonal.map((ranking) => ranking.label).join(', ')}
            </strong>{' '}
            {seasonal.length === 1 ? 'disputa' : 'disputam'} na janela{' '}
            {WINDOW_LABELS.season.toLowerCase()}: a virada os zera aos olhos de quem joga. Zerar aqui{' '}
            <strong>não é apagar</strong> — o número antigo fica no período fechado, congelado no
            pódio e consultável no histórico.
          </p>
        )}
      </Section>

      {season !== null && (
        <TurnSeasonDialog
          open={turning}
          serverId={serverId}
          periodId={season.id}
          seasonLabel={periodTitle(season)}
          snapshotSize={data.settings.snapshotSize}
          affected={seasonal}
          onClose={() => setTurning(false)}
          onDone={() => void load()}
        />
      )}
    </div>
  );
}

/**
 * A virada na mão, com motivo.
 *
 * O motivo é obrigatório no agente, e não é burocracia: ele vai
 * para o log junto com quem clicou. Uma temporada que virou fora da
 * data e ninguém sabe por quê é o tipo de coisa que vira discussão
 * no Discord uma semana depois.
 */
function TurnSeasonDialog({
  open,
  serverId,
  periodId,
  seasonLabel,
  snapshotSize,
  affected,
  onClose,
  onDone,
}: {
  readonly open: boolean;
  readonly serverId: string;
  readonly periodId: number;
  readonly seasonLabel: string;
  readonly snapshotSize: number;
  readonly affected: readonly RankingDefinition[];
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    setReason('');
    setLabel('');
    setError(null);
  }, [open]);

  const turn = async (): Promise<void> => {
    setBusy(true);
    setError(null);

    try {
      const response = await agent.openRankingSeason(serverId, {
        label: label.trim() === '' ? null : label.trim(),
        // A trava do clique duplo: é a temporada que quem clicou
        // estava vendo. Sem ela, o segundo clique abriria uma
        // terceira temporada com o pódio vazio.
        periodId,
        reason: reason.trim(),
      });

      toast.success('Temporada virada', {
        description: `${String(response.frozen)} linha(s) congeladas no pódio.`,
      });
      onDone();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} busy={busy} onClose={onClose} title="Fechar a temporada e abrir a seguinte">
      <div className="space-y-3">
        {error !== null && <StateBlock variant="error" title="O agente recusou" detail={error} />}

        <p className="text-2xs leading-relaxed text-muted">
          A <strong>{seasonLabel}</strong> fecha e a seguinte abre na mesma transação. As{' '}
          {String(snapshotSize)} primeiras posições de cada ranking são congeladas antes —{' '}
          {affected.length === 0
            ? 'nenhum ranking ligado disputa nesta janela.'
            : `${affected.map((ranking) => ranking.label).join(', ')}.`}
        </p>

        <div>
          <Label htmlFor="turn-reason">Por que está virando</Label>
          <Input
            id="turn-reason"
            value={reason}
            maxLength={200}
            placeholder="Premiação de setembro entregue"
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="mt-1 text-2xs text-muted">
            Vai para o log do agente com o seu nome. É o que responde à pergunta uma semana depois.
          </p>
        </div>

        <div>
          <Label htmlFor="turn-label">Nome da temporada que fecha</Label>
          <Input
            id="turn-label"
            value={label}
            maxLength={120}
            placeholder="Temporada de setembro"
            onChange={(event) => setLabel(event.target.value)}
          />
          <p className="mt-1 text-2xs text-muted">
            Opcional. Vazio deixa o agente calcular o nome.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            disabled={busy || reason.trim() === ''}
            onClick={() => void turn()}
          >
            {busy ? 'Virando…' : 'Fechar e abrir nova'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Fact({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string | undefined;
}) {
  return (
    <div className="flex flex-col py-1">
      <dt className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="text-foreground">
        {value}
        {hint !== undefined && <span className="ml-2 text-muted">{hint}</span>}
      </dd>
    </div>
  );
}
