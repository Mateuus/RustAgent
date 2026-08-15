'use client';

// ============================================================
//  /jogador?id=<steamId>  -  a ficha de um jogador.
//
//  ####  POR QUE QUERY STRING, E NÃO /jogador/[id]  ####
//
//  O painel é EXPORT ESTÁTICO: uma rota dinâmica exigiria
//  `generateStaticParams`, ou seja, saber em tempo de BUILD quais
//  jogadores existem. Eles nascem quando entram no servidor. Mesmo
//  motivo de `/servidor`.
//
//  ####  TRÊS ABAS, TRÊS PERGUNTAS  ####
//
//    Identidade   quem é, desde quando, e está banido?
//    Servidores   onde ele joga, e há quanto tempo em cada um
//    Histórico    o que aconteceu com ele
//
//  ####  O BAN VEM DA BanList  ####
//
//  A mesma linha que a tela de Banidos mostra — e é por isso que
//  revogar aqui aparece lá na leitura seguinte. Uma cópia do
//  estado de banimento do lado do jogador divergiria no primeiro
//  ajuste.
// ============================================================

import { Ban as BanIcon, Copy, Crown, History, IdCard, Server } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';

import { BanDialog } from '@/components/ban-dialog';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { VipDialog } from '@/components/vip-dialog';
import {
  agent,
  type Ban,
  type PlayerEvent,
  type PlayerEventSample,
  type PlayerIdentity,
  type PlayerServer,
  type Vip,
} from '@/lib/api';
import { copySteamId } from '@/lib/clipboard';
import { EM_DASH, formatDateTime, formatDuration, formatInteger, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type Tab = 'identidade' | 'servidores' | 'vip' | 'historico';

const TABS = [
  { key: 'identidade', label: 'Identidade', Icon: IdCard },
  { key: 'servidores', label: 'Servidores', Icon: Server },
  // ####  O VIP VEM ANTES DO HISTÓRICO  ####
  //
  // Ele é ESTADO — "este jogador tem Ouro até dia 4?" —, e a ordem
  // das abas é a da pergunta: quem é, onde joga, o que tem, e por
  // último o que já aconteceu.
  { key: 'vip', label: 'VIP', Icon: Crown },
  { key: 'historico', label: 'Histórico', Icon: History },
] as const;

/** A ficha acompanha a presença, que é conferida a cada 15 s. */
const POLL_MS = 15_000;

export default function JogadorPage() {
  return (
    <RequireSession>
      {/* `useSearchParams` exige Suspense no export estático. */}
      <Suspense fallback={null}>
        <Jogador />
      </Suspense>
    </RequireSession>
  );
}

function Jogador() {
  const params = useSearchParams();
  const steamId = params.get('id') ?? '';

  const [player, setPlayer] = useState<PlayerIdentity | null>(null);
  const [ban, setBan] = useState<Ban | null>(null);
  const [servers, setServers] = useState<PlayerServer[]>([]);
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('identidade');
  const [banindo, setBanindo] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (steamId === '') {
      return;
    }

    try {
      const response = await agent.networkPlayer(steamId);

      setPlayer(response.player);
      setBan(response.ban);
      setServers(response.servers);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [steamId]);

  useEffect(() => {
    void load();

    const timer = setInterval(() => void load(), POLL_MS);

    return () => clearInterval(timer);
  }, [load]);

  // Os ids da rede servem ao diálogo de banir: escolher os
  // servidores de um ban específico sem ter de adivinhar como eles
  // se chamam. Lidos UMA vez — eles não mudam enquanto a ficha
  // está aberta.
  useEffect(() => {
    void (async () => {
      try {
        const response = await agent.servers();

        setServerIds(response.servers.map((server) => server.id));
      } catch {
        // Sem a lista, o diálogo ainda bane em toda a rede — que é
        // o escopo padrão dele.
      }
    })();
  }, []);

  async function revoke(): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.revokeBan(steamId);

      toast.success(response.message);
      await load();
    } catch (cause) {
      toast.error('Não consegui revogar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  if (steamId === '') {
    return <p className="text-sm text-muted">Nenhum jogador selecionado.</p>;
  }

  return (
    <div>
      <Link
        href="/jogadores/"
        className="text-2xs uppercase tracking-wider text-muted hover:text-foreground"
      >
        ← todos os jogadores
      </Link>

      {error !== null && (
        <div className="mt-4">
          <StateBlock variant="error" title="Não consegui abrir esta ficha" detail={error} />
        </div>
      )}

      {player === null && error === null && (
        <div className="mt-4">
          <StateBlock variant="loading" title="Carregando…" />
        </div>
      )}

      {player !== null && (
        <>
          <PageHeader
            title={player.name === '' ? steamId : player.name}
            description={
              player.online
                ? `online agora em ${servers
                    .filter((server) => server.online)
                    .map((server) => server.serverId)
                    .join(', ')}`
                : `visto por último ${formatWhen(player.lastSeen)}`
            }
            aside={
              <div className="flex shrink-0 items-center gap-3">
                {ban !== null && ban.active && (
                  <span className="border border-rust px-2 py-1 font-condensed text-2xs font-bold uppercase tracking-wide text-rust">
                    banido
                  </span>
                )}

                <span
                  className={cn(
                    'flex items-center gap-2 text-2xs uppercase tracking-wider',
                    player.online ? 'text-olive' : 'text-muted',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-2 w-2 rounded-full',
                      player.online ? 'bg-olive' : 'border border-muted',
                    )}
                  />
                  {player.online ? 'online' : 'offline'}
                </span>
              </div>
            }
          />

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
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-4">
            {tab === 'identidade' && (
              <Identidade
                player={player}
                ban={ban}
                busy={busy}
                onBanir={() => setBanindo(true)}
                onRevogar={() => void revoke()}
              />
            )}

            {tab === 'servidores' && <Servidores servers={servers} known={player.known} />}

            {tab === 'vip' && <VipDoJogador steamId={steamId} />}

            {tab === 'historico' && <Historico steamId={steamId} />}
          </div>
        </>
      )}

      {banindo && player !== null && (
        <BanDialog
          open
          servers={serverIds}
          steamId={steamId}
          name={player.name}
          onClose={() => setBanindo(false)}
          onDone={() => void load()}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  Identidade
// ------------------------------------------------------------

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

function Identidade({
  player,
  ban,
  busy,
  onBanir,
  onRevogar,
}: {
  player: PlayerIdentity;
  ban: Ban | null;
  busy: boolean;
  onBanir: () => void;
  onRevogar: () => void;
}) {
  const como = player.name === '' ? player.steamId : player.name;

  return (
    <div className="space-y-4">
      {!player.known && (
        <p className="border border-amber bg-surface-2 px-4 py-3 text-2xs leading-relaxed">
          O agente <strong>nunca viu este jogador entrar</strong> em nenhum servidor da rede — ele
          existe aqui por causa do banimento. As datas ficam em branco até a primeira vez que ele
          aparecer numa lista de online.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome">{player.name === '' ? EM_DASH : player.name}</Field>

        <Field label="SteamID">
          <span className="flex items-center gap-2">
            <span className="truncate font-mono">{player.steamId}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Copiar o SteamID"
              onClick={() => copySteamId(player.steamId)}
            >
              <Copy aria-hidden="true" className="h-4 w-4" />
              Copiar
            </Button>
          </span>
        </Field>

        {/* "Jogador desde" é da REDE, e não deste ou daquele
            servidor: quem joga no pvp1 desde maio e entrou no pve
            ontem é jogador desde maio. O por-servidor está na aba
            ao lado. */}
        <Field label="Jogador desde">{formatDateTime(player.firstSeen)}</Field>

        <Field label="Visto por último">
          {player.online ? 'online agora' : formatDateTime(player.lastSeen)}
        </Field>

        {/* Só o `playerlist` nativo traz endereço; com o
            OrigemZAgent ligado ele não vem, e travessão é a
            resposta honesta. */}
        <Field label="Último IP">
          <span className="font-mono">{player.lastIp ?? EM_DASH}</span>
        </Field>
      </div>

      <section className="border border-border bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
          <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
            <BanIcon aria-hidden="true" className="h-4 w-4" />
            Banimento
          </h3>

          {ban !== null && ban.active ? (
            <ConfirmButton
              variant="danger"
              disabled={busy}
              icon={null}
              label="Revogar"
              confirmLabel="Revogar mesmo"
              hint={
                ban.scope === 'network'
                  ? `${como} volta a entrar em TODOS os servidores.`
                  : `${como} volta a entrar em ${ban.servers.join(', ')}.`
              }
              onConfirm={onRevogar}
            />
          ) : (
            <Button variant="danger" disabled={busy} onClick={onBanir}>
              Banir jogador
            </Button>
          )}
        </header>

        <div className="px-4 py-3 text-sm">
          {ban === null || !ban.active ? (
            <p className="text-muted">
              Este jogador <strong>não está banido</strong>. Banir daqui usa a mesma lista da tela de
              Banidos — cada servidor é espelho dela.
            </p>
          ) : (
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-2xs uppercase tracking-wide text-muted">Motivo</dt>
                <dd>{ban.reason}</dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-wide text-muted">Onde vale</dt>
                <dd>
                  {ban.scope === 'network' ? (
                    <span title="Inclusive nos servidores que ainda vão ser criados.">
                      toda a rede
                    </span>
                  ) : (
                    ban.servers.join(', ') || EM_DASH
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-wide text-muted">Quem aplicou</dt>
                <dd className="text-muted">
                  {ban.origin === 'adopted' ? 'adotado do bans.cfg' : (ban.createdBy ?? EM_DASH)}
                </dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-wide text-muted">Situação</dt>
                <dd className="text-muted">
                  {ban.expired
                    ? 'vencido, saindo'
                    : ban.expiresAt === null
                      ? 'permanente'
                      : `vence em ${formatDateTime(ban.expiresAt)}`}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------
//  Servidores
// ------------------------------------------------------------

function ServerHeaderCell({ children, numeric }: { children: ReactNode; numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 font-condensed text-2xs font-bold uppercase tracking-wide text-muted',
        numeric === true ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

function Servidores({ servers, known }: { servers: PlayerServer[]; known: boolean }) {
  if (servers.length === 0) {
    return (
      <StateBlock
        variant="empty"
        title="Ele não jogou em nenhum servidor desta rede"
        detail={
          known
            ? 'O agente conhece este SteamID, mas ainda não o viu dentro de um servidor.'
            : 'Este SteamID existe aqui por causa de um banimento — a linha do servidor nasce quando ele entrar.'
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <ServerHeaderCell>Servidor</ServerHeaderCell>
              <ServerHeaderCell>Joga aqui desde</ServerHeaderCell>
              <ServerHeaderCell>Última vez</ServerHeaderCell>
              <ServerHeaderCell numeric>Sessões</ServerHeaderCell>
              <ServerHeaderCell numeric>Tempo jogado</ServerHeaderCell>
            </tr>
          </thead>

          <tbody className="divide-y divide-border">
            {servers.map((server) => (
              <tr key={server.serverId}>
                <td className="px-3 py-2">
                  <Link
                    href={`/servidor/?id=${encodeURIComponent(server.serverId)}`}
                    className="flex items-center gap-2 hover:text-rust"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        server.online ? 'bg-olive' : 'border border-muted',
                      )}
                    />
                    {server.serverId}
                  </Link>
                </td>

                <td className="px-3 py-2 text-muted">{formatDateTime(server.firstSeen)}</td>

                <td className="px-3 py-2 text-muted">
                  {server.online ? (
                    <span className="text-olive">dentro desde {formatDateTime(server.joinedAt)}</span>
                  ) : (
                    <>
                      {formatWhen(server.lastSeen)}
                      {server.leaveReason !== null && (
                        <span className="block text-2xs">({server.leaveReason})</span>
                      )}
                    </>
                  )}
                </td>

                <td className="px-3 py-2 text-right">{formatInteger(server.sessions)}</td>

                {/* Tempo ZERO com sessão aberta não é "não jogou":
                    é "a primeira sessão ainda não fechou". Dizer
                    isso evita a conclusão errada. */}
                <td className="px-3 py-2 text-right">
                  {server.playedSeconds === 0 && server.online
                    ? 'na primeira sessão'
                    : formatDuration(server.playedSeconds)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-2xs leading-relaxed text-muted">
        O tempo é somado no <strong>fechamento</strong> de cada sessão, e o começo dela vem do
        próprio servidor — por isso reiniciar o agente com o jogador dentro não infla o número. Cada
        servidor tem o seu &ldquo;joga aqui desde&rdquo;: quem entrou hoje no PVE e joga no PVP desde
        maio é jogador desde maio na rede.
      </p>
    </div>
  );
}

// ------------------------------------------------------------
//  Histórico
// ------------------------------------------------------------

const EVENT_LABEL: Record<PlayerEvent['kind'], string> = {
  join: 'entrou',
  leave: 'saiu',
  kick: 'expulso',
  teleport: 'teleportado',
  ban: 'banido',
  unban: 'banimento revogado',
  // Os dois entraram com a migração 014. O rótulo é curto porque o
  // detalhe do evento já diz qual nível e qual kit.
  vip: 'VIP',
  kit: 'kit',
};

function Historico({ steamId }: { steamId: string }) {
  const [events, setEvents] = useState<PlayerEvent[] | null>(null);
  const [sample, setSample] = useState<PlayerEventSample | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;

    void (async () => {
      try {
        const response = await agent.playerEvents(steamId);

        if (!cancelado) {
          setEvents(response.events);
          setSample(response.sample);
          setError(null);
        }
      } catch (cause) {
        if (!cancelado) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    return () => {
      cancelado = true;
    };
  }, [steamId]);

  return (
    <div className="space-y-4">
      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler o histórico" detail={error} />
      )}

      {events === null && error === null && <StateBlock variant="loading" title="Lendo…" />}

      {events !== null && events.length === 0 && (
        <StateBlock
          variant="empty"
          title="Nada registrado ainda"
          detail="Entradas, saídas, expulsões e banimentos aparecem aqui a partir de agora."
        />
      )}

      {events !== null && events.length > 0 && (
        <ol className="border border-border bg-surface">
          {events.map((event, index) => (
            <li
              key={`${event.at}-${String(index)}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-sm last:border-b-0"
            >
              <span className="w-36 shrink-0 font-mono text-2xs text-muted">
                {formatDateTime(event.at)}
              </span>

              <span
                className={cn(
                  'font-condensed text-2xs font-bold uppercase tracking-wide',
                  event.kind === 'ban' || event.kind === 'kick' ? 'text-rust' : 'text-foreground',
                )}
              >
                {EVENT_LABEL[event.kind]}
              </span>

              {/* Ban de REDE não tem servidor, e um travessão ali
                  diria "faltou dado". Aqui a ausência tem
                  significado, e ele é dito. */}
              <span className="text-muted">
                {event.serverId ??
                  (event.kind === 'ban' || event.kind === 'unban' ? 'toda a rede' : EM_DASH)}
              </span>

              {event.detail !== null && <span className="min-w-0 flex-1">{event.detail}</span>}

              {event.actor !== null && <span className="text-2xs text-muted">por {event.actor}</span>}
            </li>
          ))}
        </ol>
      )}

      {/* ####  O MOCK É ROTULADO  ####

          Kill e morte não existem hoje: o RCON não os entrega e o
          plugin ainda não os coleta. O bloco mostra a ESTRUTURA do
          que vem por aí, com a frase do agente dizendo que nada ali
          aconteceu. Um exemplo que não se anuncia é uma mentira — e
          este vem do agente, num campo separado dos eventos de
          verdade. */}
      {sample !== null && (
        <section className="border border-dashed border-amber bg-surface-2">
          <header className="flex flex-wrap items-center gap-3 border-b border-dashed border-amber px-4 py-2">
            <span className="border border-amber px-2 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-amber">
              {sample.label}
            </span>
          </header>

          <ol className="divide-y divide-border opacity-60">
            {sample.events.map((event, index) => (
              <li
                key={`${event.at}-${String(index)}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-sm"
              >
                <span className="w-36 shrink-0 font-mono text-2xs text-muted">
                  {formatDateTime(event.at)}
                </span>
                <span className="font-condensed text-2xs font-bold uppercase tracking-wide">
                  {event.kind === 'kill' ? 'matou' : 'morreu'}
                </span>
                <span className="text-muted">{event.serverId}</span>
                <span className="min-w-0 flex-1">{event.detail}</span>
              </li>
            ))}
          </ol>

          <p className="border-t border-dashed border-amber px-4 py-2 text-2xs leading-relaxed text-muted">
            {sample.note}
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * O VIP deste jogador: o que vale agora, e o que já valeu.
 *
 * ####  OS DOIS JUNTOS, E SEPARADOS  ####
 *
 * O ativo responde "ele tem Ouro?"; o histórico responde "ele diz
 * que já teve" — e a segunda é a pergunta que chega pelo Discord.
 * Misturá-los faria um VIP revogado em março parecer ativo.
 *
 * O VIP é de REDE: não há coluna de servidor aqui de propósito. O
 * que é por servidor é o grupo do Oxide, e ele é conferido sozinho
 * a cada conexão.
 */
function VipDoJogador({ steamId }: { readonly steamId: string }) {
  const [active, setActive] = useState<Vip[] | null>(null);
  const [history, setHistory] = useState<Vip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [concedendo, setConcedendo] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.playerVips(steamId);

      setActive(response.active);
      setHistory(response.history);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [steamId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(vip: Vip): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.revokeVip(vip.steamId, vip.tier);

      toast.success('VIP revogado', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui revogar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error !== null && <StateBlock variant="error" title="Não consegui ler o VIP" detail={error} />}

      {active === null && error === null && <StateBlock variant="loading" title="Lendo…" />}

      {active !== null && (
        <section className="border border-border bg-surface">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
            <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
              <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />O que ele tem
              agora
            </h2>

            <Button variant="primary" size="sm" disabled={busy} onClick={() => setConcedendo(true)}>
              Conceder ou renovar
            </Button>
          </header>

          {active.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">
              Este jogador não tem VIP nenhum. Um VIP concedido aqui vale em toda a rede.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {active.map((vip) => (
                <li
                  key={vip.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="font-condensed text-sm font-bold uppercase tracking-wide">
                      {vip.tier}
                    </p>
                    <p className="mt-1 text-2xs text-muted">
                      desde {formatDateTime(vip.createdAt)} ·{' '}
                      {vip.expiresAt === null
                        ? 'vitalício'
                        : `até ${formatDateTime(vip.expiresAt)}`}{' '}
                      ·{' '}
                      {vip.origin === 'adotado'
                        ? 'adotado do grupo do Oxide'
                        : `${vip.origin}${vip.createdBy === null ? '' : ` (${vip.createdBy})`}`}
                    </p>
                  </div>

                  <ConfirmButton
                    variant="danger"
                    disabled={busy}
                    icon={null}
                    label="Revogar"
                    confirmLabel="Revogar mesmo"
                    hint={`Ele sai do grupo ${vip.tier} em todos os servidores. A linha fica no histórico.`}
                    onConfirm={() => void revoke(vip)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {history.length > 0 && (
        <section className="border border-border bg-surface">
          <header className="border-b border-border px-4 py-2">
            <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
              <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
              Tudo o que já houve
            </h2>
          </header>

          <ol className="divide-y divide-border">
            {history.map((vip) => (
              <li
                key={vip.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-sm"
              >
                <span className="w-36 shrink-0 font-mono text-2xs text-muted">
                  {formatDateTime(vip.createdAt)}
                </span>
                <span className="font-condensed text-2xs font-bold uppercase tracking-wide">
                  {vip.tier}
                </span>
                <span className="min-w-0 flex-1 text-muted">
                  {vip.revokedAt === null
                    ? vip.expiresAt === null
                      ? 'vitalício, ativo'
                      : `${vip.expired ? 'vencido' : 'ativo'} — ${formatDateTime(vip.expiresAt)}`
                    : `revogado em ${formatDateTime(vip.revokedAt)} por ${
                        vip.revokedBy ?? 'prazo cumprido'
                      }`}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {concedendo && active !== null && (
        <VipDialog
          open
          steamId={steamId}
          current={active}
          onClose={() => setConcedendo(false)}
          onDone={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}
