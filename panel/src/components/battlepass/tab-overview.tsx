'use client';

// ============================================================
//  tab-overview.tsx  -  a temporada de hoje está no ar? quantos
//  compraram? quantos dias restam? o mês que vem tem passe?
//
//  ####  ELA É A ABA DO SILÊNCIO  ####
//
//  O 01 §7 diz o que acontece na virada do mês: a temporada do mês
//  fecha, o XP zera, e a `scheduled` daquele mês entra no lugar —
//  "se não houver nenhuma, o passe não aparece, e esse silêncio é
//  ruim, então o painel avisa o admin ANTES de acontecer".
//
//  É o que esta aba faz. Os dois avisos — "não há nada no ar" e "o
//  mês que vem está vazio (ou parado em rascunho)" — são o motivo
//  de ela existir; o resto é contagem.
//
//  ####  A CONTAGEM É POR SERVIDOR  ####
//
//  `owners` e `players` são daquele servidor, porque o direito
//  comprado e o XP são dele (01 §1.4). A temporada é a mesma da
//  rede; quem muda de servidor muda de números, não de trilha.
// ============================================================

import { CalendarDays, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  daysLeftInPeriod,
  messageOf,
  periodLabel,
  safeOverview,
} from '@/components/battlepass/normalize';
import {
  ServerChoice,
  type BattlePassServerOption,
} from '@/components/battlepass/server-choice';
import { StateBadge } from '@/components/battlepass/state-badge';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { agent, type BattlePassOverview, type BattlePassSeason } from '@/lib/api';
import { EM_DASH, formatInteger, formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';

export function TabOverview({
  servers,
  serverId,
  onPickServer,
}: {
  readonly servers: readonly BattlePassServerOption[];
  readonly serverId: string;
  readonly onPickServer: (serverId: string) => void;
}) {
  const [overview, setOverview] = useState<BattlePassOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (serverId === '') {
      setOverview(null);
      setLoading(false);

      return;
    }

    setLoading(true);

    try {
      // Esta leitura é ESSENCIAL para esta aba: sem ela não há o
      // que mostrar, e uma tela com zeros mentiria.
      setOverview(safeOverview(await agent.battlePassOverview(serverId)));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <ServerChoice servers={servers} value={serverId} busy={loading} onChange={onPickServer} />

      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler o passe deste servidor." detail={error} />
      )}

      {loading && overview === null && error === null && (
        <StateBlock variant="loading" title="Consultando o agente…" />
      )}

      {overview !== null && (
        <>
          <Section
            title="A temporada no ar"
            aside={
              <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
                mês do agente: {periodLabel(overview.period)}
              </span>
            }
          >
            {overview.season === null ? (
              <StateBlock
                variant="empty"
                title="Nenhuma temporada no ar neste servidor."
                detail="O card do passe não aparece na home do jogo, o comando responde que não há passe, e nenhum XP é contado. Publique a temporada do mês na aba Temporadas."
              />
            ) : (
              <SeasonSummary
                season={overview.season}
                owners={overview.owners}
                players={overview.players}
              />
            )}
          </Section>

          <Section title="O mês que vem">
            <NextSeason season={overview.next} period={overview.period} />
          </Section>
        </>
      )}
    </div>
  );
}

/** A temporada no ar, com os números daquele servidor. */
function SeasonSummary({
  season,
  owners,
  players,
}: {
  readonly season: BattlePassSeason;
  readonly owners: number;
  readonly players: number;
}) {
  const daysLeft = daysLeftInPeriod(season.period);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={season.state} />
        <span className="truncate font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
          {season.label}
        </span>
        <span className="text-2xs text-muted">{periodLabel(season.period)}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Dias até fechar"
          value={daysLeft === null ? EM_DASH : `~${String(daysLeft)}`}
          hint="o fuso que manda é o do agente"
          Icon={CalendarDays}
        />
        <Stat
          label="Compraram o passe"
          value={formatInteger(owners)}
          hint="direitos vivos deste mês, neste servidor"
          Icon={Users}
        />
        <Stat
          label="Jogadores com XP"
          value={formatInteger(players)}
          hint="quem já pontuou nesta temporada"
          Icon={Users}
        />
        <Stat
          label="Níveis"
          value={formatInteger(season.levels)}
          hint={`atualizada ${formatWhen(season.updatedAt)}`}
          Icon={CalendarDays}
        />
      </div>

      <dl className="grid gap-2 text-xs sm:grid-cols-3">
        <Flag label="Faixa grátis" on={season.freeLane} />
        <Flag label="Faixa paga" on={season.paidLane} />
        <Flag label="Compra retroativa" on={season.retroactive} />
      </dl>

      {!season.freeLane && !season.paidLane && (
        <StateBlock
          variant="error"
          title="As duas faixas estão desligadas."
          detail="A trilha não tem o que mostrar: o jogador abre o passe e não vê recompensa nenhuma. Ligue pelo menos uma na aba Configuração."
        />
      )}

      {season.description !== null && <p className="text-xs text-muted">{season.description}</p>}
    </div>
  );
}

/**
 * O aviso do 01 §7, antes de acontecer.
 *
 * "Sem passe no mês que vem" é uma falha que só aparece no dia 1, e
 * aí já é tarde: o card some da home sem ninguém ter decidido isso.
 */
function NextSeason({
  season,
  period,
}: {
  readonly season: BattlePassSeason | null;
  readonly period: string;
}) {
  if (season === null) {
    return (
      <StateBlock
        variant="error"
        title="O mês que vem não tem passe montado."
        detail={`Na virada, a temporada de ${periodLabel(period)} fecha, o XP zera e nenhuma entra no lugar — o passe simplesmente some da tela do jogo. Crie a próxima na aba Temporadas.`}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={season.state} />
        <span className="truncate font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
          {season.label}
        </span>
        <span className="text-2xs text-muted">
          {periodLabel(season.period)} · {formatInteger(season.levels)} níveis
        </span>
      </div>

      {season.state === 'draft' && (
        <StateBlock
          variant="error"
          title="Ela está em rascunho, e rascunho não entra no ar."
          detail="Publicar é botão, e não efeito do calendário: uma temporada esquecida em rascunho no dia 1 não sobe. Publique-a na aba Temporadas assim que ela estiver montada."
        />
      )}

      {season.servers.length === 0 && (
        <StateBlock
          variant="error"
          title="Ela não vale em servidor nenhum."
          detail="Nenhum servidor marcado quer dizer em nenhum — e não em todos. Marque onde ela entra na aba Temporadas."
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  Icon,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly Icon: typeof CalendarDays;
}) {
  return (
    <div className="min-w-0 border border-border bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-rust" />
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">{label}</span>
      </div>
      <p className="mt-1 truncate font-condensed text-xl font-bold text-foreground">{value}</p>
      <p className="truncate text-2xs text-muted">{hint}</p>
    </div>
  );
}

/** Uma chave ligada/desligada, em palavras — cor sozinha não fala. */
function Flag({ label, on }: { readonly label: string; readonly on: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 border border-border bg-surface-2 px-3 py-2">
      <dt className="font-condensed text-2xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className={cn('font-condensed text-2xs font-bold uppercase', on ? 'text-olive' : 'text-muted')}>
        {on ? 'ligada' : 'desligada'}
      </dd>
    </div>
  );
}
