'use client';

// ============================================================
//  live-panel.tsx  -  o que está de pé agora.
//
//  ####  AQUI SE OLHA; EM CONFIGURAÇÕES SE MEXE  ####
//
//  O número de vagas mora na aba Configurações. Aqui ele aparece
//  só como MEDIDOR — quantas das que existem estão ocupadas —,
//  porque é o que explica o botão de erguer estar morto. Um campo
//  de digitar no meio de uma tela que se olha o dia inteiro é
//  convite para mexer sem querer.
//
//  ####  POR QUE O ESTADO VEM DO JOGO, E NÃO DO BANCO  ####
//
//  O banco sabe o que o agente MANDOU acontecer. Quem sabe o que
//  está acontecendo é o plugin: ele é quem conta quem está dentro
//  do círculo, quem contesta e quanto a barra andou. Uma tela que
//  lesse o banco mostraria evento de pé depois de um restart do
//  servidor de jogo — que é exatamente quando alguém vem olhar.
//
//  Por isso, com o servidor fora do ar, isto aqui diz "não sei" em
//  vez de mostrar números velhos com cara de vivos.
//
//  ####  O RELÓGIO ANDA SOZINHO ENTRE AS LEITURAS  ####
//
//  A leitura é de cinco em cinco segundos, mas o tempo restante do
//  card conta de segundo em segundo a partir dela. Sem isso o
//  número fica travado e a tela parece congelada; com isso, ele
//  anda e se corrige na leitura seguinte.
//
//  Ver Docs/KOTH/DECISOES-DO-DONO.md §9.
// ============================================================

import { Flag, Loader2, Play, Swords, Timer } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { agent, type KothArena, type KothLiveEvent, type KothStatus } from '@/lib/api';
import { clock, holderOf, phaseOf, remainingSeconds, type KothPhase } from '@/lib/koth/live';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface LivePanelProps {
  readonly serverId: string;
}

/** De quanto em quanto tempo perguntar ao jogo. */
const POLL_MS = 5_000;

export function LivePanel({ serverId }: LivePanelProps) {
  const [status, setStatus] = useState<KothStatus | null>(null);
  const [arenas, setArenas] = useState<readonly KothArena[]>([]);
  const [vagas, setVagas] = useState<number | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [arenaId, setArenaId] = useState('');

  // O instante da última leitura: é dele que o relógio de cada card
  // conta para a frente.
  const [readAt, setReadAt] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await agent.kothStatus(serverId);

      setStatus(response.status);
      setReadAt(Date.now());
      setOffline(null);
    } catch (cause) {
      // Servidor fora do ar não é erro desta tela: é a resposta.
      setOffline(cause instanceof Error ? cause.message : String(cause));
      setStatus(null);
    }
  }, [serverId]);

  useEffect(() => {
    void load();

    const timer = setInterval(() => {
      void load();
    }, POLL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [load]);

  // As vagas e os territórios vêm do BANCO: eles respondem com o
  // servidor parado, e é justamente parado que alguém configura.
  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const [settings, list] = await Promise.all([
          agent.kothSettings(serverId),
          agent.kothArenas(serverId),
        ]);

        if (!alive) return;

        setVagas(settings.settings.maxConcurrent);
        setArenas(list.arenas);
      } catch {
        if (alive) setVagas(null);
      }
    })();

    return () => {
      alive = false;
    };
  }, [serverId]);

  async function start(): Promise<void> {
    setBusy(true);

    try {
      const chosen = arenaId === '' ? undefined : Number(arenaId);
      const started = await agent.startKoth(serverId, chosen);

      toast.success('Território erguido', {
        description: `${started.arena.label} em ${started.grid}.`,
      });

      await load();
    } catch (cause) {
      toast.error('Não consegui erguer', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function stop(runId: string, name: string): Promise<void> {
    try {
      await agent.stopKoth(serverId, Number(runId));
      toast.success('Território derrubado', { description: name });
      await load();
    } catch (cause) {
      toast.error('Não consegui derrubar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const events = status?.events ?? [];
  const ocupadas = status?.count ?? events.length;
  const total = vagas ?? 1;
  const cheio = ocupadas >= total;

  return (
    <div className="space-y-4">
      {/* ####  A BARRA DE AÇÃO  ####

          Erguer e o medidor de vagas na mesma linha, de propósito: o
          motivo de o botão estar morto é o medidor ao lado dele. */}
      <section className="flex flex-wrap items-end justify-between gap-3 border border-border bg-surface p-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
          {/* Largura de campo, e não de tela: um select de 1900 px
              para escolher entre três nomes é difícil de ler. */}
          <label className="block min-w-0 max-w-sm flex-1">
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Erguer um território agora
            </span>
            <select
              value={arenaId}
              onChange={(event) => setArenaId(event.target.value)}
              className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
            >
              <option value="">Sorteado entre os ligados</option>
              {arenas
                .filter((arena) => arena.enabled)
                .map((arena) => (
                  <option key={arena.id} value={String(arena.id)}>
                    {arena.label}
                  </option>
                ))}
            </select>
          </label>

          <Button
            size="sm"
            variant="primary"
            className="mb-0.5"
            disabled={busy || offline !== null || cheio || arenas.length === 0}
            onClick={() => void start()}
          >
            {busy && <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {!busy && <Play aria-hidden="true" className="mr-1 h-3.5 w-3.5" />}
            Erguer
          </Button>
        </div>

        {/* O MEDIDOR. Quem muda o número é a aba Configurações; aqui
            ele só explica o botão. */}
        {vagas !== null && offline === null && (
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="flex gap-1" aria-hidden="true">
              {Array.from({ length: total }, (_, index) => (
                <span
                  key={index}
                  className={cn(
                    'h-3 w-6 border',
                    index < ocupadas ? 'border-rust bg-rust' : 'border-border',
                  )}
                />
              ))}
            </span>
            <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
              {ocupadas} de {total} vaga(s) ocupada(s)
            </span>
          </div>
        )}

        {cheio && offline === null && (
          <p className="w-full text-2xs text-muted">
            Todas as vagas estão ocupadas. Derrube um dos que estão de pé, ou aumente o máximo na
            aba Configurações.
          </p>
        )}
      </section>

      {/* ####  O QUE ESTÁ DE PÉ  #### */}
      {offline !== null ? (
        <StateBlock
          variant="offline"
          title="O servidor não respondeu"
          detail={`Sem ele não há como saber o que está de pé. ${offline}`}
        />
      ) : status === null ? (
        <StateBlock variant="loading" title="Perguntando ao servidor…" />
      ) : events.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Nenhum território de pé agora"
          detail="Quando um nascer — pelo relógio ou pelo botão acima — ele aparece aqui com a barra andando."
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {events.map((event) => (
            <LiveCard
              key={event.runId}
              event={event}
              readAt={readAt}
              onStop={() => void stop(event.runId, event.name)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Como cada fase se chama e se pinta na tela. */
const PHASES: Record<KothPhase, { readonly label: string; readonly tone: string }> = {
  contested: { label: 'contestado', tone: 'text-amber' },
  holding: { label: 'dominando', tone: 'text-olive' },
  paused: { label: 'parado', tone: 'text-muted' },
  idle: { label: 'sem ninguém', tone: 'text-muted' },
};

function LiveCard({
  event,
  readAt,
  onStop,
}: {
  readonly event: KothLiveEvent;
  readonly readAt: number;
  readonly onStop: () => void;
}) {
  const since = useTicker(readAt);
  const phase = phaseOf(event);
  const holder = holderOf(event);
  const left = Math.max(0, remainingSeconds(event) - since);
  const percent = Math.max(0, Math.min(100, Math.round(event.percent)));

  return (
    <li className="border border-border bg-surface p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="flex min-w-0 items-center gap-2 font-condensed text-sm font-bold">
          <Flag aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-rust" />
          <span className="truncate">{event.name}</span>
          <span className="font-mono text-2xs font-normal text-muted">{event.grid}</span>
        </h4>

        <span className="flex items-center gap-1 font-mono text-2xs text-muted">
          <Timer aria-hidden="true" className="h-3 w-3" />
          {clock(left)}
        </span>
      </header>

      {/* A barra. É a mesma que o jogador vê na tela dele. */}
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Domínio de ${event.name}`}
        className="mt-2 h-2 w-full bg-surface-2"
      >
        <div
          className={cn(
            'h-full transition-[width] duration-500',
            phase === 'contested' ? 'bg-amber' : 'bg-rust',
          )}
          style={{ width: `${String(percent)}%` }}
        />
      </div>

      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
        <span className="font-condensed text-sm font-bold">{percent}%</span>

        <span className={cn('font-condensed uppercase tracking-wide', PHASES[phase].tone)}>
          {phase === 'contested' && (
            <Swords aria-hidden="true" className="mr-1 inline h-3 w-3 align-[-1px]" />
          )}
          {PHASES[phase].label}
        </span>

        {holder !== null && (
          <span className="min-w-0 truncate text-muted">
            {/* Só quem está avançando "domina". Parado ou contestado,
                o nome é de quem GUARDA o que já conquistou — e o
                progresso é dele até alguém tomar. */}
            {phase === 'holding' ? '' : 'guardado por '}
            <strong className="text-foreground">{holder}</strong>
          </span>
        )}

        <span className="text-muted">
          {event.inside === 1 ? '1 dentro' : `${String(event.inside)} dentro`}
        </span>

        <span className="text-muted">raio {event.radius} m</span>
      </p>

      <div className="mt-2 flex justify-end">
        <ConfirmButton
          variant="danger"
          disabled={false}
          icon={<Flag aria-hidden="true" className="h-3.5 w-3.5" />}
          label="Derrubar"
          confirmLabel="Derrubar mesmo"
          hint="O evento acaba SEM vencedor: ninguém leva a caixa, e o progresso conquistado se perde."
          onConfirm={onStop}
        />
      </div>
    </li>
  );
}

/**
 * Quantos segundos se passaram desde a última leitura.
 *
 * É o que faz o relógio do card andar entre uma leitura e outra.
 */
function useTicker(readAt: number): number {
  const [since, setSince] = useState(0);
  const base = useRef(readAt);

  useEffect(() => {
    base.current = readAt;
    setSince(0);

    const timer = setInterval(() => {
      setSince(Math.round((Date.now() - base.current) / 1000));
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [readAt]);

  return since;
}
