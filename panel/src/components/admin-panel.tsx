'use client';

// ============================================================
//  admin-panel.tsx  -  a aba Administração de um servidor.
//
//  Cinco sub-abas, e cada uma responde a uma pergunta que hoje só
//  se responde entrando no jogo:
//
//    Jogadores  quem está online, e o que fazer com cada um
//    Chat       o que estão dizendo, e como falar com eles
//    Admins     quem manda aqui
//    Banidos    o que vale neste servidor, e de onde veio
//    Comandos   os atalhos da semana, e o campo livre
//
//  ####  A FONTE DA LISTA NÃO É ESCOLHA DE QUEM OLHA  ####
//
//  Com o OrigemZAgent ligado, a lista vem do plugin e tem posição;
//  sem ele, vem do `playerlist` nativo e não tem. O agente decide e
//  DIZ qual usou — a tela mostra isso e oferece ligar o plugin ali
//  mesmo. Um seletor de fonte seria transferir para quem administra
//  uma decisão que o agente já sabe tomar.
//
//  ####  E O QUE FALTA VIRA TRAVESSÃO  ####
//
//  Nunca zero, nunca "morto". Ver Docs\07-PAINEL.md: "0 jogadores"
//  quando na verdade ninguém sabe é a leitura que faz o admin
//  concluir que o servidor está vazio.
// ============================================================

import { Copy, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { BanDialog } from '@/components/ban-dialog';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  agent,
  type AdminEntry,
  type AdminLevel,
  type ChatLine,
  type GamePlayer,
  type PlayersSnapshot,
  type ServerBan,
  type ServerView,
} from '@/lib/api';
import { EM_DASH, formatDuration } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type Section = 'jogadores' | 'chat' | 'admins' | 'banidos' | 'comandos';

const SECTIONS: readonly { key: Section; label: string }[] = [
  { key: 'jogadores', label: 'Jogadores' },
  { key: 'chat', label: 'Chat' },
  { key: 'admins', label: 'Admins' },
  { key: 'banidos', label: 'Banidos' },
  { key: 'comandos', label: 'Comandos' },
];

/** Quanto tempo entre as leituras de cada sub-aba. */
const PLAYERS_POLL_MS = 5_000;
const CHAT_POLL_MS = 2_000;

export function AdminPanel({ server }: { server: ServerView }) {
  const [section, setSection] = useState<Section>('jogadores');

  return (
    <div className="space-y-4">
      {/* As sub-abas, no mesmo desenho de server-settings.tsx:
          pílulas com divisória de 1px. Sem a divisória, cinco
          rótulos em maiúsculas viram uma faixa contínua de texto. */}
      <div className="flex flex-wrap items-stretch border border-border bg-surface">
        {SECTIONS.map((item, index) => (
          <div key={item.key} className="flex items-stretch">
            {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

            <button
              type="button"
              onClick={() => setSection(item.key)}
              className={cn(
                'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                section === item.key
                  ? 'bg-surface-2 text-foreground'
                  : 'text-muted hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>

      {section === 'jogadores' && <PlayersSection server={server} />}
      {section === 'chat' && <ChatSection serverId={server.id} />}
      {section === 'admins' && <AdminsSection serverId={server.id} />}
      {section === 'banidos' && <BansSection serverId={server.id} />}
      {section === 'comandos' && <CommandsSection serverId={server.id} />}
    </div>
  );
}

// ------------------------------------------------------------
//  Casca comum
// ------------------------------------------------------------

function Card({
  title,
  hint,
  aside,
  children,
}: {
  title: string;
  hint?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0">
          <h3 className="font-condensed text-sm font-bold uppercase tracking-wide">{title}</h3>
          {hint !== undefined && <p className="mt-0.5 text-2xs text-muted">{hint}</p>}
        </div>
        {aside}
      </header>

      {children}
    </section>
  );
}

function HeaderCell({ children, numeric }: { children: ReactNode; numeric?: boolean }) {
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

/**
 * Copia o SteamID.
 *
 * ####  A API DE ÁREA DE TRANSFERÊNCIA NÃO EXISTE EM TODO LUGAR  ####
 *
 * Ela exige contexto seguro, e o painel é servido por HTTP puro num
 * IP de rede local com frequência. Falhar em silêncio ali deixaria
 * um botão que não faz nada; o desfecho é mostrar o id no toast, de
 * onde ainda dá para copiar à mão.
 */
function copySteamId(steamId: string): void {
  void (async () => {
    try {
      await navigator.clipboard.writeText(steamId);
      toast.success('SteamID copiado', { description: steamId });
    } catch {
      toast.info('Copie à mão', {
        description: `${steamId} — o navegador só libera a área de transferência em HTTPS.`,
        duration: null,
      });
    }
  })();
}

// ------------------------------------------------------------
//  Jogadores
// ------------------------------------------------------------

function PlayersSection({ server }: { server: ServerView }) {
  const [snapshot, setSnapshot] = useState<PlayersSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [banning, setBanning] = useState<GamePlayer | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await agent.players(server.id);

      setSnapshot(response);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [server.id]);

  useEffect(() => {
    void load();

    const timer = setInterval(() => void load(), PLAYERS_POLL_MS);

    return () => clearInterval(timer);
  }, [load]);

  async function kick(player: GamePlayer): Promise<void> {
    setBusy(player.steamId);

    try {
      const response = await agent.kickPlayer(server.id, player.steamId);

      toast.success(`${player.name} expulso`, { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui expulsar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(null);
    }
  }

  async function enablePlugin(pluginId: number): Promise<void> {
    setBusy('plugin');

    try {
      const response = await agent.setServerPlugin(server.id, pluginId, true);

      toast.success(response.message);
      await load();
    } catch (cause) {
      toast.error('Não consegui ligar o plugin', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error !== null && (
        <div className="mb-4">
          <StateBlock variant="error" title="Não consegui ler quem está online" detail={error} />
        </div>
      )}

      {snapshot === null && error === null && (
        <StateBlock variant="loading" title="Perguntando ao servidor…" />
      )}

      {snapshot !== null && (
        <Card
          title={`Online (${String(snapshot.total)})`}
          hint={
            snapshot.source === 'plugin'
              ? `Lido pelo ${snapshot.plugin.name}: com posição, vida e estado.`
              : 'Lido pelo playerlist nativo do Rust.'
          }
          aside={
            /* ####  A QUEDA PARA O NATIVO É DITA, E TEM SAÍDA  ####

               Sem esta faixa, a coluna de posição simplesmente
               apareceria vazia — e "a posição sumiu" é uma caça ao
               defeito que não existe. Com o plugin no acervo e
               desligado, o botão resolve aqui mesmo. */
            snapshot.source === 'nativo' && snapshot.plugin.id !== null ? (
              <Button
                size="sm"
                variant="primary"
                disabled={busy !== null}
                onClick={() => void enablePlugin(snapshot.plugin.id ?? 0)}
              >
                {busy === 'plugin' ? 'Ligando…' : `Ligar o ${snapshot.plugin.name}`}
              </Button>
            ) : undefined
          }
        >
          {snapshot.source === 'nativo' && (
            <p className="border-b border-border bg-surface-2 px-4 py-3 text-2xs leading-relaxed">
              O <strong>{snapshot.plugin.name}</strong>{' '}
              {snapshot.plugin.id === null
                ? 'não está no acervo deste servidor — envie o .cs na aba Plugins para ter posição e estado.'
                : 'está desligado aqui. Sem ele, o playerlist do Rust não informa posição, nem se o jogador está vivo ou dormindo.'}
            </p>
          )}

          {snapshot.players.length === 0 ? (
            <p className="px-4 py-6 text-center text-2xs text-muted">
              Ninguém online agora. Este número vem do servidor — não é uma suposição da tela.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border">
                  <tr>
                    <HeaderCell>Jogador</HeaderCell>
                    <HeaderCell>Estado</HeaderCell>
                    <HeaderCell numeric>Vida</HeaderCell>
                    <HeaderCell numeric>Ping</HeaderCell>
                    <HeaderCell numeric>Conectado</HeaderCell>
                    <HeaderCell>Posição</HeaderCell>
                    <HeaderCell>
                      <span className="sr-only">Ações</span>
                    </HeaderCell>
                  </tr>
                </thead>

                <tbody className="divide-y divide-border">
                  {snapshot.players.map((player) => (
                    <tr key={player.steamId}>
                      <td className="px-3 py-2">
                        <p className="truncate">{player.name}</p>
                        <p className="truncate font-mono text-2xs text-muted">{player.steamId}</p>
                      </td>

                      <td className="px-3 py-2 text-muted">{estadoDe(player)}</td>

                      <td className="px-3 py-2 text-right tabular-nums">
                        {player.health === null ? EM_DASH : Math.round(player.health)}
                      </td>

                      <td className="px-3 py-2 text-right tabular-nums text-muted">
                        {player.ping === null ? EM_DASH : `${String(player.ping)} ms`}
                      </td>

                      <td className="px-3 py-2 text-right tabular-nums text-muted">
                        {formatDuration(player.connectedSeconds)}
                      </td>

                      <td className="px-3 py-2 font-mono text-2xs text-muted">
                        {player.position === null
                          ? EM_DASH
                          : `${player.position.x.toFixed(0)}, ${player.position.z.toFixed(0)}`}
                      </td>

                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Copiar o SteamID de ${player.name}`}
                            onClick={() => copySteamId(player.steamId)}
                          >
                            <Copy aria-hidden="true" className="h-4 w-4" />
                          </Button>

                          <ConfirmButton
                            variant="primary"
                            disabled={busy !== null}
                            icon={null}
                            label="Expulsar"
                            confirmLabel="Expulsar mesmo"
                            hint={`${player.name} cai do servidor agora. Ele pode voltar a qualquer momento.`}
                            onConfirm={() => void kick(player)}
                          />

                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy !== null}
                            onClick={() => setBanning(player)}
                          >
                            Banir
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* A `key` força um formulário limpo a cada jogador: sem ela,
          o motivo digitado para um sobreviveria para o próximo. */}
      {banning !== null && (
        <BanDialog
          key={banning.steamId}
          open
          servers={[server.id]}
          steamId={banning.steamId}
          name={banning.name}
          defaultServer={server.id}
          onClose={() => setBanning(null)}
          onDone={() => void load()}
        />
      )}
    </>
  );
}

/** Vivo, morto, dormindo — ou travessão quando ninguém sabe. */
function estadoDe(player: GamePlayer): string {
  if (player.isAlive === null) {
    return EM_DASH;
  }

  if (!player.isAlive) {
    return 'morto';
  }

  return player.isSleeping === true ? 'dormindo' : 'acordado';
}

// ------------------------------------------------------------
//  Chat
// ------------------------------------------------------------

function ChatSection({ serverId }: { serverId: string }) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const logRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await agent.chat(serverId);

      // A lista é SUBSTITUÍDA, e não acumulada: o histórico é do
      // servidor, e o que chega já é a janela inteira. Acumular
      // duplicaria cada mensagem a cada volta do polling.
      setConnected(response.connected);
      setNotice(response.message ?? null);
      setLines(response.lines);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();

    const timer = setInterval(() => void load(), CHAT_POLL_MS);

    return () => clearInterval(timer);
  }, [load]);

  // Mesma regra do console: a rolagem para quando a pessoa sobe,
  // senão não dá para ler a mensagem que passou.
  useEffect(() => {
    if (stickToBottom.current && logRef.current !== null) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();

    const trimmed = message.trim();

    if (trimmed === '') {
      return;
    }

    setSending(true);

    try {
      await agent.say(serverId, trimmed);
      setMessage('');
      await load();
    } catch (cause) {
      toast.error('A mensagem não foi', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted">
        <span
          aria-hidden
          className={cn('h-2 w-2 rounded-full', connected ? 'bg-olive' : 'bg-muted')}
        />
        {connected ? 'RCON conectado' : 'RCON fora do ar'}
      </div>

      {notice !== null && <p className="text-2xs leading-relaxed text-muted">{notice}</p>}

      <div
        ref={logRef}
        onScroll={(event) => {
          const element = event.currentTarget;

          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
        className="h-[24rem] space-y-1 overflow-y-auto border border-border bg-background p-3 text-sm"
      >
        {lines.length === 0 ? (
          <p className="text-2xs text-muted">
            Nada ainda. As mensagens vêm do histórico do próprio servidor — ele guarda o que foi
            dito antes de o agente subir.
          </p>
        ) : (
          lines.map((line, index) => (
            // A key é a posição: a lista é substituída inteira a
            // cada leitura, e duas mensagens iguais no mesmo segundo
            // são possíveis (o mesmo jogador repetindo).
            <div key={`${String(index)}-${line.at}`} className="flex flex-wrap items-baseline gap-2">
              <span className="shrink-0 font-mono text-2xs text-muted">
                {new Date(line.at).toLocaleTimeString('pt-BR')}
              </span>

              {/* O canal importa: uma mensagem de equipe lida como
                  global faz quem administra achar que o combinado
                  foi dito para todo mundo. */}
              {line.channel !== null && line.channel !== 'global' && (
                <span className="shrink-0 font-condensed text-2xs font-bold uppercase tracking-wide text-amber">
                  {line.channel}
                </span>
              )}

              {/* ####  A TAG DO GRUPO  ####

                  É o [VIP OURO] / [ADMIN] que o plugin de chat põe
                  na frente do nome no jogo. Mostrá-la aqui é o que
                  faz esta aba ser a MESMA conversa que os jogadores
                  estão vendo — sem ela, quem administra não sabe se
                  está falando com um VIP ou com um novato. */}
              {line.tag !== null && (
                <span
                  className="shrink-0 font-condensed text-2xs font-bold uppercase tracking-wide"
                  style={line.color === null ? undefined : { color: line.color }}
                >
                  {line.tag}
                </span>
              )}

              {/* A cor vem do grupo, conferida pelo agente. Ela é a
                  mesma que o jogador vê no jogo — e é o que permite
                  reconhecer quem é quem de relance. */}
              <span
                className="shrink-0 font-medium"
                style={line.color === null ? undefined : { color: line.color }}
              >
                {line.name}
              </span>

              <span className="min-w-0 break-words text-muted">{line.text}</span>
            </div>
          ))
        )}
      </div>

      <form onSubmit={(event) => void send(event)} className="flex gap-2">
        <Input
          value={message}
          disabled={!connected || sending}
          maxLength={200}
          placeholder={connected ? 'falar no chat do servidor (say)' : 'RCON fora do ar'}
          onChange={(event) => setMessage(event.target.value)}
        />
        <Button type="submit" variant="primary" disabled={!connected || sending}>
          Enviar
        </Button>
      </form>

      <p className="text-2xs leading-relaxed text-muted">
        A conversa é lida do <strong>histórico do servidor</strong>, e não de um buffer do agente:
        ela continua inteira depois de um restart do agente, e aparece mesmo com um plugin de chat
        formatando as mensagens — que é quando o log do RCON deixa de trazê-las. A tag do grupo
        (<code>[VIP OURO]</code>, <code>[ADMIN]</code>) e a cor do nome são as mesmas que o jogador
        vê.
      </p>

      <p className="text-2xs leading-relaxed text-muted">
        A mensagem que você envia sai como <code>say</code>, no nome do servidor. Aspas e{' '}
        <code>&lt;color&gt;</code> são removidos: o <code>say</code> do Rust quebra com aspas, e o
        rich text deixaria qualquer texto se passar por mensagem de admin.
      </p>
    </div>
  );
}

// ------------------------------------------------------------
//  Admins
// ------------------------------------------------------------

function AdminsSection({ serverId }: { serverId: string }) {
  const [admins, setAdmins] = useState<AdminEntry[] | null>(null);
  const [path, setPath] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [steamId, setSteamId] = useState('');
  const [name, setName] = useState('');
  const [level, setLevel] = useState<AdminLevel>('moderator');

  const load = useCallback(async () => {
    try {
      const response = await agent.admins(serverId);

      setAdmins(response.admins);
      setPath(response.path);
      setNotice(response.message ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function grant(): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.grantAdmin(serverId, {
        steamId: steamId.trim(),
        name: name.trim() === '' ? undefined : name.trim(),
        level,
      });

      toast.success(response.message);
      setSteamId('');
      setName('');
      await load();
    } catch (cause) {
      toast.error('Não consegui promover', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(entry: AdminEntry): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.revokeAdmin(serverId, entry.steamId, entry.level);

      toast.success(response.message);
      await load();
    } catch (cause) {
      toast.error('Não consegui rebaixar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler os admins" detail={error} />
      )}

      <Card
        title="Quem manda aqui"
        hint="Owner faz tudo; moderador expulsa, bane e teleporta."
        aside={
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            Reler
          </Button>
        }
      >
        {notice !== null && (
          <p className="border-b border-border bg-surface-2 px-4 py-3 text-2xs leading-relaxed">
            {notice}
          </p>
        )}

        {admins !== null && admins.length === 0 && notice === null && (
          <p className="px-4 py-6 text-center text-2xs text-muted">
            Nenhum admin cadastrado neste servidor.
          </p>
        )}

        {admins !== null && admins.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>SteamID</HeaderCell>
                  <HeaderCell>Nome</HeaderCell>
                  <HeaderCell>Nível</HeaderCell>
                  <HeaderCell>
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {admins.map((entry) => (
                  <tr key={`${entry.level}-${entry.steamId}`}>
                    <td className="px-3 py-2 font-mono text-2xs">{entry.steamId}</td>
                    <td className="px-3 py-2">{entry.name ?? EM_DASH}</td>
                    <td className="px-3 py-2 text-muted">
                      {entry.level === 'owner' ? 'owner' : 'moderador'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <ConfirmButton
                        variant="danger"
                        disabled={busy}
                        icon={null}
                        label="Rebaixar"
                        confirmLabel="Rebaixar mesmo"
                        hint={`${entry.name ?? entry.steamId} perde o poder de ${
                          entry.level === 'owner' ? 'owner' : 'moderador'
                        } neste servidor.`}
                        onConfirm={() => void revoke(entry)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Promover" hint="Vale na hora, com o jogador dentro do jogo inclusive.">
        <div className="space-y-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="admin-steamid">SteamID64</Label>
              <Input
                id="admin-steamid"
                value={steamId}
                placeholder="76561198000000000"
                className="font-mono"
                onChange={(event) => setSteamId(event.target.value.trim())}
              />
            </div>

            <div>
              <Label htmlFor="admin-nome">Nome (opcional)</Label>
              <Input id="admin-nome" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
          </div>

          <div>
            <Label>Nível</Label>

            <div className="mt-1 flex items-stretch border border-border">
              {(
                [
                  ['moderator', 'Moderador'],
                  ['owner', 'Owner'],
                ] as const
              ).map(([key, label], index) => (
                <div key={key} className="flex items-stretch">
                  {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                  <button
                    type="button"
                    aria-pressed={level === key}
                    onClick={() => setLevel(key)}
                    className={cn(
                      'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                      level === key
                        ? 'bg-surface-2 text-foreground'
                        : 'text-muted hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={busy || steamId.trim().length !== 17}
              onClick={() => void grant()}
            >
              {busy ? 'Aplicando…' : 'Promover'}
            </Button>
          </div>
        </div>
      </Card>

      {/* ####  O ARQUIVO É LIDO, E NUNCA ESCRITO  ####

          Dizer isso na tela evita a tentativa clássica: abrir o
          users.cfg no editor com o servidor no ar e perder a
          mudança no próximo writecfg, sem erro nenhum. */}
      <p className="text-2xs leading-relaxed text-muted">
        A lista é lida de <code className="break-all">{path === '' ? 'users.cfg' : path}</code>, que
        o jogo reescreve inteiro a cada <code>server.writecfg</code>. Editar esse arquivo à mão com
        o servidor no ar <strong>perde a mudança</strong> — quem muda o estado é o comando pelo
        RCON, que é o que os botões acima fazem.
      </p>
    </div>
  );
}

// ------------------------------------------------------------
//  Banidos (a visão deste servidor)
// ------------------------------------------------------------

const SOURCE_LABEL: Record<ServerBan['source'], string> = {
  rede: 'rede',
  especifico: 'específico',
  adotado: 'adotado do bans.cfg',
};

function BansSection({ serverId }: { serverId: string }) {
  const [bans, setBans] = useState<ServerBan[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.serverBans(serverId);

      setBans(response.bans);
      setConnected(response.connected);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync(): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.syncServerBans(serverId);

      // O desfecho fica NA TELA, e não só no toast: ele conta o que
      // mudou, e "adotei 3 banimentos que já estavam no servidor" é
      // uma frase para ler com calma.
      setNotice(response.message);
      toast.success('Lista conferida', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui sincronizar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(ban: ServerBan): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.revokeBan(ban.steamId);

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

  return (
    <div className="space-y-4">
      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler os banidos" detail={error} />
      )}

      {notice !== null && (
        <p className="border border-border bg-surface-2 p-3 text-2xs leading-relaxed">{notice}</p>
      )}

      <Card
        title={`Banidos aqui (${String(bans?.length ?? 0)})`}
        hint="O que vale neste servidor, e de onde veio."
        aside={
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !connected}
            title={
              connected
                ? 'Confere o bans.cfg deste servidor contra a lista do agente.'
                : 'O RCON está fora do ar — não há como conferir a lista do servidor agora.'
            }
            onClick={() => void sync()}
          >
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            {busy ? 'Conferindo…' : 'Sincronizar agora'}
          </Button>
        }
      >
        {bans !== null && bans.length === 0 && (
          <p className="px-4 py-6 text-center text-2xs text-muted">
            Ninguém banido neste servidor. Os banimentos de rede aparecem aqui automaticamente.
          </p>
        )}

        {bans !== null && bans.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>Jogador</HeaderCell>
                  <HeaderCell>Motivo</HeaderCell>
                  <HeaderCell>Origem</HeaderCell>
                  <HeaderCell>Vence</HeaderCell>
                  <HeaderCell>
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {bans.map((ban) => (
                  <tr key={ban.id}>
                    <td className="px-3 py-2">
                      <p className="truncate">{ban.name ?? EM_DASH}</p>
                      <p className="truncate font-mono text-2xs text-muted">{ban.steamId}</p>
                    </td>

                    <td className="px-3 py-2 text-muted">{ban.reason}</td>

                    <td className="px-3 py-2 text-muted">{SOURCE_LABEL[ban.source]}</td>

                    <td className="px-3 py-2 text-muted">{vencimentoDe(ban)}</td>

                    <td className="px-3 py-2 text-right">
                      <ConfirmButton
                        variant="danger"
                        disabled={busy}
                        icon={null}
                        label="Revogar"
                        confirmLabel="Revogar mesmo"
                        hint={
                          ban.scope === 'network'
                            ? `${ban.name ?? ban.steamId} volta a entrar em TODOS os servidores.`
                            : `${ban.name ?? ban.steamId} volta a entrar em ${ban.servers.join(', ')}.`
                        }
                        onConfirm={() => void revoke(ban)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-2xs leading-relaxed text-muted">
        A lista é do <strong>agente</strong>; o <code>bans.cfg</code> deste servidor é o espelho
        dela. A conferência acontece sozinha quando o agente sobe, quando o servidor é ligado e
        quando o RCON reconecta — o botão só antecipa isso. O que já estava no servidor é{' '}
        <strong>adotado</strong>, nunca apagado.
      </p>
    </div>
  );
}

/** "permanente", a data, ou "vencido, saindo". */
function vencimentoDe(ban: ServerBan): string {
  if (ban.expiresAt === null) {
    return 'permanente';
  }

  if (ban.expired) {
    // Estado real e curto: o relógio do agente passa por ele e
    // manda o unban. Dizer "ativo" aqui faria o prazo parecer
    // quebrado.
    return 'vencido, saindo';
  }

  return new Date(ban.expiresAt).toLocaleString('pt-BR');
}

// ------------------------------------------------------------
//  Comandos
// ------------------------------------------------------------

/**
 * Os atalhos da semana, com o que cada um faz escrito ao lado.
 *
 * O texto não é enfeite: `server.writecfg` e `oxide.reload *` são
 * comandos que quem administra manda de cor e sem saber direito o
 * que fazem — e um deles derruba todos os plugins por alguns
 * segundos.
 */
const ATALHOS: readonly { command: string; label: string; hint: string }[] = [
  {
    command: 'server.save',
    label: 'Salvar o mundo',
    hint: 'Grava agora o que existe no mundo. É o que se perde num "parar à força".',
  },
  {
    command: 'server.writecfg',
    label: 'Gravar as configurações',
    hint: 'Escreve users.cfg e bans.cfg em disco. Sem ele, um crash perde as mudanças da sessão.',
  },
  {
    command: 'oxide.reload *',
    label: 'Recarregar todos os plugins',
    hint: 'Descarrega e carrega TODOS. Por alguns segundos nenhum plugin responde no jogo.',
  },
  {
    command: 'weather.rain 0',
    label: 'Parar a chuva',
    hint: 'Zera a chuva até o clima mudar sozinho de novo.',
  },
  {
    command: 'env.time 12',
    label: 'Meio-dia',
    hint: 'Põe o relógio do mundo no meio-dia. O ciclo continua correndo a partir dali.',
  },
];

function CommandsSection({ serverId }: { serverId: string }) {
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(raw: string): Promise<void> {
    const trimmed = raw.trim();

    if (trimmed === '') {
      return;
    }

    setBusy(true);

    try {
      const response = await agent.rcon(serverId, trimmed);

      // A resposta fica NA TELA: é onde aparece o erro do comando, e
      // esse precisa poder ser lido com calma.
      setOutput(
        response.response.trim() === ''
          ? `> ${trimmed}\n(o servidor aceitou e não respondeu nada — é o normal para este comando)`
          : `> ${trimmed}\n${response.response.trimEnd()}`,
      );
    } catch (cause) {
      toast.error('O comando não foi', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="Atalhos" hint="Cada um com o que ele faz de verdade.">
        <div className="divide-y divide-border">
          {ATALHOS.map((atalho) => (
            <div
              key={atalho.command}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{atalho.label}</p>
                <p className="truncate font-mono text-2xs text-muted">{atalho.command}</p>
                <p className="mt-0.5 text-2xs leading-relaxed text-muted">{atalho.hint}</p>
              </div>

              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run(atalho.command)}
              >
                Executar
              </Button>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Comando livre" hint="Vai direto para o console do servidor, pelo RCON.">
        <div className="space-y-3 p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(command);
            }}
            className="flex gap-2"
          >
            <Input
              value={command}
              disabled={busy}
              placeholder="ex.: status, env.time 8, teleport.topos"
              className="font-mono"
              onChange={(event) => setCommand(event.target.value)}
            />
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Enviando…' : 'Enviar'}
            </Button>
          </form>

          {output !== null && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap border border-border bg-background p-3 font-mono text-2xs">
              {output}
            </pre>
          )}

          <p className="text-2xs leading-relaxed text-muted">
            Isto <strong>não</strong> é comando na máquina: ele vai para o servidor de Rust,
            exatamente como o console web faz. Quem tem a senha do RCON já podia fazer isso.
          </p>
        </div>
      </Card>
    </div>
  );
}
