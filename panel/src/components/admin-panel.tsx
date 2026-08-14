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

import { Copy, Maximize2, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { BanDialog } from '@/components/ban-dialog';
import { MapView } from '@/components/map-view';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  agent,
  agentUrl,
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

/**
 * De quanto em quanto tempo perguntar pela imagem do mapa que ainda
 * está sendo desenhada. O render leva dezenas de segundos.
 */
const MAP_RETRY_MS = 15_000;

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

/** Lista, mapa, ou os dois. Ver o alternador no cabeçalho. */
type PlayersMode = 'lista' | 'dividido' | 'mapa';

/**
 * O estado de um jogador, reduzido ao que a tela filtra.
 *
 * `desconhecido` existe porque o `playerlist` nativo não diz se
 * alguém está vivo: sem esta quarta chave, um filtro ligado
 * esconderia a lista inteira num servidor sem o plugin.
 */
type EstadoChave = 'acordado' | 'dormindo' | 'morto' | 'desconhecido';

function estadoChave(player: GamePlayer): EstadoChave {
  if (player.isAlive === null) {
    return 'desconhecido';
  }

  if (!player.isAlive) {
    return 'morto';
  }

  return player.isSleeping === true ? 'dormindo' : 'acordado';
}

const ESTADO_LABEL: Record<EstadoChave, string> = {
  acordado: 'Acordados',
  dormindo: 'Dormindo',
  morto: 'Mortos',
  desconhecido: 'Sem estado',
};

function PlayersSection({ server }: { server: ServerView }) {
  const [snapshot, setSnapshot] = useState<PlayersSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [banning, setBanning] = useState<GamePlayer | null>(null);
  /**
   * Começa DIVIDIDO: as duas perguntas ("quem está aí" e "onde
   * eles estão") são feitas juntas na maior parte das vezes, e
   * abrir num modo que esconde metade obrigaria um clique antes de
   * qualquer resposta.
   */
  const [mode, setMode] = useState<PlayersMode>('dividido');
  /** O SteamID selecionado. É o mesmo nos dois lados. */
  const [selected, setSelected] = useState<string | null>(null);
  /** Nome, SteamID ou célula do mapa. */
  const [busca, setBusca] = useState('');
  /**
   * Quais estados aparecem.
   *
   * Os três nascem ligados: um filtro que começa escondendo gente
   * faria a contagem da tela discordar da do servidor logo na
   * abertura, e ninguém procuraria a causa num filtro que não
   * pediu.
   */
  const [estados, setEstados] = useState<Record<EstadoChave, boolean>>({
    acordado: true,
    dormindo: true,
    morto: true,
    desconhecido: true,
  });
  /** O mapa ocupando a página inteira. */
  const [fullscreen, setFullscreen] = useState(false);

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

  /**
   * O teleporte por arraste.
   *
   * A tela NÃO redesenha o ponto onde ele foi solto: ela recarrega e
   * usa a posição que o SERVIDOR devolveu. A altura é resolvida lá,
   * e o jogador pode parar alguns metros acima ou abaixo do que um
   * mapa 2D sugere — desenhar o palpite seria a tela afirmando uma
   * coisa que ela não sabe.
   */
  async function teleport(player: GamePlayer, target: { x: number; z: number }): Promise<void> {
    setBusy(player.steamId);

    try {
      const response = await agent.teleportPlayer(server.id, player.steamId, target);

      toast.success(`${player.name} foi movido`, { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui teleportar', {
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

  const todos = snapshot?.players ?? [];
  const mapImage = useMapImage(server.id);

  /**
   * A busca e os filtros valem para a LISTA E PARA O MAPA.
   *
   * Filtrar só a lista deixaria a tela contando duas histórias: um
   * nome procurado sumindo da lista e continuando como ponto no
   * mapa, sem nada dizendo qual das duas responde à pergunta.
   */
  const players = todos.filter((player) => {
    if (!estados[estadoChave(player)]) {
      return false;
    }

    const alvo = busca.trim().toLowerCase();

    return (
      alvo === '' ||
      player.name.toLowerCase().includes(alvo) ||
      player.steamId.includes(alvo) ||
      (player.grid ?? '').toLowerCase() === alvo
    );
  });

  const semPosicao = players.filter((player) => player.position === null).length;
  const escondidos = todos.length - players.length;

  return (
    <div className="space-y-3">
      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler quem está online" detail={error} />
      )}

      {snapshot === null && error === null && (
        <StateBlock variant="loading" title="Perguntando ao servidor…" />
      )}

      {snapshot !== null && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface px-4 py-2">
            <div className="min-w-0">
              <h3 className="font-condensed text-sm font-bold uppercase tracking-wide">
                Online <span className="text-muted">({String(snapshot.total)})</span>
              </h3>
              <p className="mt-0.5 text-2xs text-muted">
                {snapshot.source === 'plugin'
                  ? `Lido pelo ${snapshot.plugin.name}: com posição, vida e estado.`
                  : 'Lido pelo playerlist nativo do Rust — sem posição.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* ####  OS TRÊS MODOS  ####

                  A lista e o mapa respondem a perguntas
                  diferentes: "quem está aí" se lê numa lista,
                  "onde eles estão" se vê num mapa. Um alternador
                  em vez de uma divisória arrastável porque a
                  escolha é entre TRÊS estados nomeados — e não
                  entre trezentas larguras que ninguém quer
                  ajustar. */}
              <div className="flex items-stretch border border-border">
                {(
                  [
                    ['lista', 'Lista'],
                    ['dividido', 'Dividido'],
                    ['mapa', 'Mapa'],
                  ] as const
                ).map(([key, label], index) => (
                  <div key={key} className="flex items-stretch">
                    {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                    <button
                      type="button"
                      aria-pressed={mode === key}
                      onClick={() => setMode(key)}
                      className={cn(
                        'px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                        mode === key
                          ? 'bg-surface-2 text-foreground'
                          : 'text-muted hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  </div>
                ))}
              </div>

              {/* ####  A QUEDA PARA O NATIVO TEM SAÍDA  ####

                  Sem o plugin não há posição, e o mapa fica vazio.
                  Com ele no acervo e desligado, o botão resolve
                  aqui mesmo — em vez de mandar a pessoa para outra
                  aba descobrir sozinha o que fazer. */}
              {snapshot.source === 'nativo' && snapshot.plugin.id !== null && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => void enablePlugin(snapshot.plugin.id ?? 0)}
                >
                  {busy === 'plugin' ? 'Ligando…' : `Ligar o ${snapshot.plugin.name}`}
                </Button>
              )}

              <Button size="sm" variant="outline" onClick={() => setFullscreen(true)}>
                <Maximize2 aria-hidden="true" className="h-4 w-4" />
                Tela cheia
              </Button>
            </div>
          </div>

          <PlayersFilters
            busca={busca}
            onBusca={setBusca}
            estados={estados}
            onEstados={setEstados}
            contagem={todos}
            escondidos={escondidos}
          />

          {snapshot.source === 'nativo' && (
            <p className="border border-amber bg-surface-2 px-4 py-3 text-2xs leading-relaxed">
              O <strong>{snapshot.plugin.name}</strong>{' '}
              {snapshot.plugin.id === null
                ? 'não está no acervo deste servidor — envie o .cs na aba Plugins para ter posição, mapa e estado.'
                : 'está desligado aqui. Sem ele o playerlist do Rust não informa posição, nem se o jogador está vivo ou dormindo — e o mapa fica sem pontos.'}
            </p>
          )}

          {snapshot.source === 'plugin' && semPosicao > 0 && (
            <p className="border border-border bg-surface-2 px-4 py-3 text-2xs leading-relaxed text-muted">
              {String(semPosicao)} jogador(es) sem posição conhecida aparecem na lista e{' '}
              <strong>não</strong> no mapa. Sumir dos dois seria esconder gente que está no
              servidor.
            </p>
          )}

          <div
            className={cn(
              'grid gap-3',
              // No dividido a lista tem largura de leitura e o mapa
              // fica com o resto. Abaixo de lg elas empilham: lado a
              // lado numa tela estreita deixaria as duas inúteis.
              mode === 'dividido' && 'lg:grid-cols-[minmax(20rem,28rem)_1fr]',
            )}
          >
            {mode !== 'mapa' && (
              <PlayerList
                players={players}
                selected={selected}
                busy={busy}
                onSelect={(player) =>
                  setSelected(player.steamId === selected ? null : player.steamId)
                }
                onKick={(player) => void kick(player)}
                onBan={(player) => setBanning(player)}
                compact={mode === 'dividido'}
              />
            )}

            {mode !== 'lista' && (
              <div className="space-y-2">
                <div className="h-[38rem] min-h-64">
                  <MapView
                    players={players}
                    world={snapshot.world}
                    selected={selected}
                    imageUrl={mapImage.url}
                    coverage={mapImage.coverage}
                    onSelect={(player) =>
                      setSelected(player.steamId === selected ? null : player.steamId)
                    }
                    // Só com a fonte do plugin: sem ele não existe
                    // comando que mova um jogador, e oferecer o
                    // gesto seria prometer o que o servidor não faz.
                    onTeleport={
                      snapshot.source === 'plugin'
                        ? (player, target) => void teleport(player, target)
                        : undefined
                    }
                  />
                </div>

                {/* O desenho é do JOGO, e leva dezenas de segundos.
                    Dizer isso é a diferença entre "está vindo" e um
                    mapa que parece quebrado. */}
                {mapImage.url === null && (
                  <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface-2 px-3 py-2">
                    <p className="min-w-0 flex-1 text-2xs leading-relaxed text-muted">
                      {mapImage.pending
                        ? 'O jogo está desenhando a imagem deste mundo — ela aparece aqui sozinha, em alguns segundos.'
                        : 'Ainda não há imagem deste mundo.'}{' '}
                      Isso acontece <strong>uma vez por wipe</strong>: o arquivo leva o tamanho e a
                      seed no nome, e o mapa novo refaz o desenho por conta própria.
                    </p>

                    {/* ####  QUANDO ESTE BOTÃO É PRECISO  ####

                        O render automático acontece na conexão do
                        RCON. Quem apagar a imagem com o servidor JÁ
                        no ar não dispara nada — e sem este botão a
                        única saída seria reiniciar o servidor para
                        ter um mapa de volta. */}
                    <Button size="sm" variant="outline" onClick={() => mapImage.render()}>
                      Desenhar agora
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ####  A TELA CHEIA É A MESMA TELA  ####

          Os mesmos componentes, o mesmo estado, a mesma seleção —
          só com espaço. Uma segunda implementação do mapa "para o
          modal" seria a que divergiria no primeiro ajuste, e o
          usuário veria dois mapas com comportamentos diferentes. */}
      <Dialog
        open={fullscreen}
        title={`${server.name} — jogadores e mapa`}
        onClose={() => setFullscreen(false)}
        className="h-[94vh] w-[96vw] max-w-none"
      >
        {snapshot !== null && (
          <div className="flex h-[calc(94vh-3.5rem)] flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-stretch border border-border">
                {(
                  [
                    ['lista', 'Lista'],
                    ['dividido', 'Dividido'],
                    ['mapa', 'Mapa'],
                  ] as const
                ).map(([key, label], index) => (
                  <div key={key} className="flex items-stretch">
                    {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                    <button
                      type="button"
                      aria-pressed={mode === key}
                      onClick={() => setMode(key)}
                      className={cn(
                        'px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                        mode === key
                          ? 'bg-surface-2 text-foreground'
                          : 'text-muted hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  </div>
                ))}
              </div>

              <span className="text-2xs text-muted">
                {String(players.length)} de {String(todos.length)} online
              </span>
            </div>

            <PlayersFilters
              busca={busca}
              onBusca={setBusca}
              estados={estados}
              onEstados={setEstados}
              contagem={todos}
              escondidos={escondidos}
            />

            <div
              className={cn(
                'grid min-h-0 flex-1 gap-3',
                mode === 'dividido' && 'lg:grid-cols-[minmax(20rem,26rem)_1fr]',
              )}
            >
              {mode !== 'mapa' && (
                <div className="min-h-0 overflow-y-auto">
                  <PlayerList
                    players={players}
                    selected={selected}
                    busy={busy}
                    compact={mode === 'dividido'}
                    onSelect={(player) =>
                      setSelected(player.steamId === selected ? null : player.steamId)
                    }
                    onKick={(player) => void kick(player)}
                    onBan={(player) => setBanning(player)}
                  />
                </div>
              )}

              {mode !== 'lista' && (
                <div className="min-h-0">
                  <MapView
                    players={players}
                    world={snapshot.world}
                    selected={selected}
                    imageUrl={mapImage.url}
                    coverage={mapImage.coverage}
                    onSelect={(player) =>
                      setSelected(player.steamId === selected ? null : player.steamId)
                    }
                    // Só com a fonte do plugin: sem ele não existe
                    // comando que mova um jogador, e oferecer o
                    // gesto seria prometer o que o servidor não faz.
                    onTeleport={
                      snapshot.source === 'plugin'
                        ? (player, target) => void teleport(player, target)
                        : undefined
                    }
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </Dialog>

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
    </div>
  );
}

/**
 * A busca e os filtros de estado.
 *
 * ####  ELES VALEM PARA OS DOIS LADOS  ####
 *
 * Filtrar só a lista deixaria a tela contando duas histórias: o
 * nome procurado sumindo da lista e continuando como ponto no mapa.
 *
 * ####  E O QUE FOI ESCONDIDO É DITO  ####
 *
 * "3 escondidos pelo filtro" é a diferença entre um servidor vazio
 * e um filtro ligado — e sem essa frase, os dois têm exatamente a
 * mesma aparência.
 */
function PlayersFilters({
  busca,
  onBusca,
  estados,
  onEstados,
  contagem,
  escondidos,
}: {
  busca: string;
  onBusca: (value: string) => void;
  estados: Record<EstadoChave, boolean>;
  onEstados: (value: Record<EstadoChave, boolean>) => void;
  contagem: readonly GamePlayer[];
  escondidos: number;
}) {
  const porEstado = (chave: EstadoChave): number =>
    contagem.filter((player) => estadoChave(player) === chave).length;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex min-w-56 flex-1 items-center gap-2 border border-border bg-surface-2 px-2">
        <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
        <Input
          value={busca}
          placeholder="nome, SteamID ou célula (ex.: H3)"
          aria-label="Procurar jogador"
          className="border-0 bg-transparent px-0 hover:border-0"
          onChange={(event) => onBusca(event.target.value)}
        />
        {busca !== '' && (
          <Button size="sm" variant="ghost" aria-label="Limpar a busca" onClick={() => onBusca('')}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
      </label>

      <div className="flex flex-wrap gap-2">
        {(['acordado', 'dormindo', 'morto', 'desconhecido'] as const).map((chave) => {
          const total = porEstado(chave);

          // O estado que não existe na lista não vira botão: um
          // filtro de "mortos" num servidor sem mortos é ruído.
          if (total === 0 && estados[chave]) {
            return null;
          }

          return (
            <button
              key={chave}
              type="button"
              aria-pressed={estados[chave]}
              onClick={() => onEstados({ ...estados, [chave]: !estados[chave] })}
              className={cn(
                'border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                estados[chave]
                  ? 'border-border bg-surface-2 text-foreground'
                  : 'border-border text-muted line-through hover:text-foreground',
              )}
            >
              {ESTADO_LABEL[chave]} ({String(total)})
            </button>
          );
        })}
      </div>

      {escondidos > 0 && (
        <span className="text-2xs text-muted">
          {String(escondidos)} escondido(s) pelo filtro
        </span>
      )}
    </div>
  );
}

/**
 * A imagem do mundo, baixada uma vez.
 *
 * ####  POR QUE `fetch` + `blob:`, E NÃO `<image href="/api/…">`  ####
 *
 * A rota é autenticada. Em produção o painel e o agente moram na
 * mesma origem e o cookie iria sozinho — mas em desenvolvimento o
 * painel roda em :3100 e o agente em :8787, e uma imagem
 * cross-origin NÃO leva credencial: a tela quebraria só no
 * ambiente de quem a está construindo.
 *
 * Com `fetch(credentials: 'include')` os dois casos ficam iguais, e
 * o `blob:` sai do endereço — o navegador não refaz a requisição a
 * cada redesenho do SVG.
 *
 * ####  E ELA PODE AINDA NÃO EXISTIR  ####
 *
 * O agente pede o render ao jogo quando o RCON conecta num mundo
 * sem imagem, e o desenho leva dezenas de segundos. Enquanto isso,
 * `available` é falso — e a tela volta a perguntar, em vez de
 * decidir que não há mapa.
 */
function useMapImage(serverId: string): {
  readonly url: string | null;
  /** Quantas unidades do mundo a imagem cobre. Ver `MapView`. */
  readonly coverage: number | null;
  readonly pending: boolean;
  readonly message: string | null;
  /** Pede o render agora. Ver o comentário no botão. */
  readonly render: () => void;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    async function load(): Promise<void> {
      try {
        const info = await agent.mapImage(serverId);

        if (cancelled) {
          return;
        }

        setMessage(info.message ?? null);

        if (info.url === null) {
          setPending(true);
          return;
        }

        const response = await fetch(agentUrl(info.url), { credentials: 'include' });

        if (!response.ok || cancelled) {
          return;
        }

        objectUrl = URL.createObjectURL(await response.blob());

        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        setCoverage(info.coverage);
        setUrl(objectUrl);
        setPending(false);
      } catch {
        // Sem imagem a tela continua servindo: a grade e os pontos
        // é que respondem "onde eles estão".
        if (!cancelled) {
          setPending(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;

      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [serverId, attempt]);

  // Enquanto o jogo desenha, a tela volta a perguntar. O timer só
  // existe enquanto falta imagem — pronto, ele nunca mais roda.
  useEffect(() => {
    if (url !== null) {
      return;
    }

    const timer = setTimeout(() => setAttempt((value) => value + 1), MAP_RETRY_MS);

    return () => clearTimeout(timer);
  }, [url, attempt]);

  const render = useCallback(() => {
    void (async () => {
      try {
        const response = await agent.renderMap(serverId);

        setPending(true);
        toast.info('Desenhando o mapa', { description: response.message });
        // Volta a perguntar já: o `attempt` é o que reinicia o
        // ciclo de leitura.
        setAttempt((value) => value + 1);
      } catch (cause) {
        toast.error('Não consegui pedir o render', {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
  }, [serverId]);

  return { url, coverage, pending, message, render };
}

/**
 * A lista de quem está online.
 *
 * ####  LINHAS, E NÃO UMA TABELA  ####
 *
 * Ela precisa caber numa coluna estreita ao lado do mapa E ocupar a
 * tela inteira sozinha. Uma tabela de sete colunas não faz as duas
 * coisas: no dividido ela viraria rolagem horizontal, que é o jeito
 * mais rápido de tornar uma lista inútil.
 *
 * ####  AS AÇÕES SÓ NA LINHA SELECIONADA  ####
 *
 * Três botões por linha, em duzentas linhas, é uma parede de
 * botões — e todos ficam pequenos demais para acertar. Selecionar
 * primeiro também é o gesto que o mapa já pede: clicar no ponto
 * abre as mesmas ações.
 */
function PlayerList({
  players,
  selected,
  busy,
  compact,
  onSelect,
  onKick,
  onBan,
}: {
  players: readonly GamePlayer[];
  selected: string | null;
  busy: string | null;
  compact: boolean;
  onSelect: (player: GamePlayer) => void;
  onKick: (player: GamePlayer) => void;
  onBan: (player: GamePlayer) => void;
}) {
  if (players.length === 0) {
    return (
      <section className="border border-border bg-surface">
        <p className="px-4 py-6 text-center text-2xs text-muted">
          Ninguém online agora. Este número vem do servidor — não é uma suposição da tela.
        </p>
      </section>
    );
  }

  return (
    <section className="max-h-[38rem] overflow-y-auto border border-border bg-surface">
      <ul className="divide-y divide-border">
        {players.map((player) => {
          const isSelected = selected === player.steamId;

          return (
            <li key={player.steamId}>
              <button
                type="button"
                aria-expanded={isSelected}
                onClick={() => onSelect(player)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left',
                  isSelected ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
              >
                {/* O ponto repete a forma do mapa: quem olhou para
                    um reconhece o outro sem legenda nova. */}
                <span
                  aria-hidden
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    player.isAlive === false
                      ? 'bg-rust'
                      : player.isSleeping === true
                        ? 'bg-amber'
                        : player.isAlive === null
                          ? 'bg-muted'
                          : 'bg-olive',
                  )}
                />

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{player.name}</span>
                  <span className="block truncate text-2xs text-muted">
                    {estadoDe(player)} · {formatDuration(player.connectedSeconds)}
                    {compact ? '' : ` · ${player.steamId}`}
                  </span>
                </span>

                <span className="shrink-0 text-right">
                  {/* A célula do mapa é a resposta útil para "onde
                      ele está" — `120, -840` obriga a traduzir. */}
                  <span className="block font-mono text-2xs">{player.grid ?? EM_DASH}</span>
                  <span className="block text-2xs text-muted">
                    {player.health === null ? EM_DASH : `${String(Math.round(player.health))} ♥`}
                    {player.ping === null ? '' : ` · ${String(player.ping)} ms`}
                  </span>
                </span>
              </button>

              {isSelected && (
                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2 px-3 py-2">
                  <span className="mr-auto truncate font-mono text-2xs text-muted">
                    {player.steamId}
                  </span>

                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Copiar o SteamID de ${player.name}`}
                    onClick={() => copySteamId(player.steamId)}
                  >
                    <Copy aria-hidden="true" className="h-4 w-4" />
                    Copiar
                  </Button>

                  <ConfirmButton
                    variant="primary"
                    disabled={busy !== null}
                    icon={null}
                    label="Expulsar"
                    confirmLabel="Expulsar mesmo"
                    hint={`${player.name} cai do servidor agora. Ele pode voltar a qualquer momento.`}
                    onConfirm={() => onKick(player)}
                  />

                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy !== null}
                    onClick={() => onBan(player)}
                  >
                    Banir
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
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
