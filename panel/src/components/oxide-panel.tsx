'use client';

// ============================================================
//  oxide-panel.tsx  -  a sub-aba Oxide de Configurações.
//
//  ####  É AQUI QUE O VIP DE FATO ACONTECE  ####
//
//  O nível de VIP deste projeto é um GRUPO do Oxide:
//  `origemz.vip.bronze` → `silver` → `gold`, cada um herdando do
//  anterior. O plugin cria a hierarquia sozinho ao carregar, a
//  partir do config dele — mas quem está dentro dela, e o que cada
//  nível concede de verdade, só se via digitando `oxide.show` no
//  Console e lendo prosa em inglês.
//
//  ####  O ARQUIVO NÃO É EDITADO. NUNCA  ####
//
//  Grupos e permissões moram em `oxide\data\*.data`, protobuf que
//  o próprio Oxide reescreve quando quer. Editá-los com o servidor
//  no ar perderia a mudança em silêncio — a mesma armadilha do
//  `users.cfg` na aba Admins. Tudo aqui passa por comando, e o
//  agente manda `oxide.save` em seguida.
//
//  ####  LER COM O SERVIDOR PARADO É PERMITIDO  ####
//
//  A tela abre e diz o que não dá para saber, em vez de mostrar um
//  erro vermelho: configuração se confere ANTES de subir, e é para
//  isso que se abre esta aba.
// ============================================================

import { Copy, Layers, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  agent,
  type OxideFrameworkConfig,
  type OxideGroup,
  type OxideLoadedPlugin,
} from '@/lib/api';
import { copySteamId } from '@/lib/clipboard';
import { EM_DASH, formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';

interface OxideStatus {
  connected: boolean;
  version: string | null;
  branch: string | null;
  plugins: OxideLoadedPlugin[];
  config: OxideFrameworkConfig | null;
  message?: string | undefined;
}

export function OxidePanel({ serverId }: { serverId: string }) {
  const [status, setStatus] = useState<OxideStatus | null>(null);
  const [groups, setGroups] = useState<OxideGroup[] | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(0);
  const [connected, setConnected] = useState(true);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [criando, setCriando] = useState(false);

  const load = useCallback(async () => {
    try {
      const [info, perms] = await Promise.all([
        agent.oxide(serverId),
        agent.oxidePermissions(serverId),
      ]);

      setStatus({
        connected: info.connected,
        version: info.oxide.version,
        branch: info.oxide.branch,
        plugins: info.plugins,
        config: info.config,
        message: info.message,
      });

      setGroups(perms.groups);
      setPermissions(perms.permissions);
      setTruncated(perms.truncated);
      setConnected(perms.connected);
      setAviso(perms.message ?? info.message ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Toda ação passa por aqui: ela manda, mostra a frase do agente
   * e RELÊ.
   *
   * Reler não é zelo — o Oxide é a fonte, e o que a tela mostra
   * depois de uma concessão precisa ser o que ELE diz, e não o que
   * nós supomos ter acontecido.
   */
  async function run(action: () => Promise<{ message: string }>): Promise<void> {
    setBusy(true);

    try {
      const response = await action();

      toast.success(response.message);
      await load();
    } catch (cause) {
      toast.error('O Oxide recusou', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler o Oxide deste servidor" detail={error} />
      )}

      {groups === null && error === null && (
        <StateBlock variant="loading" title="Perguntando ao servidor…" />
      )}

      {!connected && aviso !== null && (
        <p className="border border-amber bg-surface-2 px-4 py-3 text-2xs leading-relaxed">
          {aviso}
        </p>
      )}

      {status !== null && <Framework status={status} />}

      {groups !== null && (
        <section className="border border-border bg-surface">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
                <Layers aria-hidden="true" className="h-4 w-4" />
                Grupos <span className="text-muted">({String(groups.length)})</span>
              </h3>
              <p className="mt-0.5 text-2xs text-muted">
                Quem está dentro de um grupo ganha o que ele concede — e o que os pais dele
                concedem.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
                <RefreshCw aria-hidden="true" className="h-4 w-4" />
                Atualizar
              </Button>

              <Button
                size="sm"
                variant="primary"
                disabled={busy || !connected}
                title={connected ? undefined : 'O servidor precisa estar no ar.'}
                onClick={() => setCriando(true)}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                Criar grupo
              </Button>
            </div>
          </header>

          {groups.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">
              Nenhum grupo para mostrar. Com o servidor no ar, o Oxide sempre tem pelo menos{' '}
              <code>default</code> e <code>admin</code>.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {groups.map((group) => (
                <GroupRow
                  key={group.name}
                  group={group}
                  groups={groups}
                  permissions={permissions}
                  busy={busy || !connected}
                  onGrant={(permission) =>
                    void run(() => agent.grantOxidePermission(serverId, group.name, permission))
                  }
                  onRevoke={(permission) =>
                    void run(() => agent.revokeOxidePermission(serverId, group.name, permission))
                  }
                  onAddMember={(steamId) =>
                    void run(() => agent.addOxideMember(serverId, group.name, steamId))
                  }
                  onRemoveMember={(steamId) =>
                    void run(() => agent.removeOxideMember(serverId, group.name, steamId))
                  }
                  onPatch={(patch) =>
                    void run(() => agent.patchOxideGroup(serverId, group.name, patch))
                  }
                  onRemove={() => void run(() => agent.removeOxideGroup(serverId, group.name))}
                />
              ))}
            </ul>
          )}

          {truncated > 0 && (
            <p className="border-t border-border px-4 py-2 text-2xs text-muted">
              Mais {String(truncated)} grupo(s) existem e não foram detalhados: o console responde
              um por comando, e a tela para no sexagésimo. Uma lista truncada que não avisa é pior
              que lista nenhuma.
            </p>
          )}
        </section>
      )}

      {groups !== null && (
        <section className="border border-border bg-surface">
          <header className="border-b border-border px-4 py-2">
            <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
              <ShieldCheck aria-hidden="true" className="h-4 w-4" />
              Permissões registradas{' '}
              <span className="text-muted">({String(permissions.length)})</span>
            </h3>
            <p className="mt-0.5 text-2xs text-muted">
              Quem cria permissão é o <strong>plugin</strong>, ao carregar. Esta é a lista do que
              existe de verdade — conceder o que não está aqui o Oxide recusa.
            </p>
          </header>

          <div className="flex flex-wrap gap-2 px-4 py-3">
            {permissions.length === 0 ? (
              <p className="text-sm text-muted">
                Nenhuma. Os plugins deste servidor não registraram permissão nenhuma — o que é
                comum: muitos decidem por grupo, e não por permissão.
              </p>
            ) : (
              permissions.map((permission) => (
                <span
                  key={permission}
                  className="border border-border px-2 py-0.5 font-mono text-2xs text-muted"
                >
                  {permission}
                </span>
              ))
            )}
          </div>
        </section>
      )}

      {criando && (
        <CreateGroupDialog
          groups={groups ?? []}
          busy={busy}
          onClose={() => setCriando(false)}
          onCreate={(input) => {
            void run(() => agent.createOxideGroup(serverId, input)).then(() => setCriando(false));
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  O Oxide em si
// ------------------------------------------------------------

function Framework({ status }: { status: OxideStatus }) {
  return (
    <section className="border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div>
          <h3 className="font-condensed text-sm font-bold uppercase tracking-wide">O Oxide</h3>
          <p className="mt-0.5 text-2xs text-muted">
            A versão instalada e o que ele conseguiu carregar de verdade.
          </p>
        </div>

        <span className="font-mono text-2xs text-muted">
          {status.version ?? EM_DASH}
          {status.branch === null ? '' : ` · ${status.branch}`}
        </span>
      </header>

      <div className="grid gap-3 px-4 py-3 lg:grid-cols-2">
        <div>
          <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Plugins carregados ({String(status.plugins.length)})
          </p>

          {/* ####  "CARREGADO" NÃO É "ATIVO NO ACERVO"  ####

              A aba Plugins mostra o que o agente aplicou; isto
              mostra o que o Oxide compilou e está rodando agora.
              Quando os dois discordam, o plugin está em disco e não
              roda — e é essa diferença que se procura quando
              "liguei e não aconteceu nada". */}
          {status.plugins.length === 0 ? (
            <p className="mt-1 text-sm text-muted">
              {status.connected
                ? 'Nenhum plugin carregado.'
                : 'Só dá para saber com o servidor no ar.'}
            </p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {status.plugins.map((plugin) => (
                <li key={plugin.name} className="flex flex-wrap items-baseline gap-2">
                  <span>{plugin.name}</span>
                  <span className="font-mono text-2xs text-muted">{plugin.version ?? EM_DASH}</span>
                  <span className="text-2xs text-muted">{plugin.author ?? EM_DASH}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0">
          <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            oxide.config.json
          </p>

          {status.config === null || status.config.text === null ? (
            <p className="mt-1 text-sm text-muted">
              O arquivo ainda não existe. Ele nasce no primeiro boot do servidor depois de o Oxide
              ser instalado.
            </p>
          ) : (
            <>
              <pre className="mt-1 max-h-64 overflow-auto border border-border bg-background p-2 font-mono text-2xs leading-relaxed">
                {status.config.text}
              </pre>
              <p className="mt-1 break-all text-2xs text-muted">
                {status.config.path}
                {status.config.modifiedAt === null
                  ? ''
                  : ` · ${formatDateTime(status.config.modifiedAt)}`}
              </p>
            </>
          )}

          {/* Ele é LIDO no start do servidor. Um editor aqui
              gravaria um arquivo que só vale no próximo boot, e a
              tela estaria dizendo que mudou algo que não mudou. */}
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            Só leitura: o Oxide lê este arquivo <strong>ao subir</strong>. Mudá-lo com o servidor no
            ar não teria efeito nenhum até o próximo start.
          </p>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------
//  Um grupo
// ------------------------------------------------------------

interface GroupRowProps {
  group: OxideGroup;
  groups: OxideGroup[];
  permissions: string[];
  busy: boolean;
  onGrant: (permission: string) => void;
  onRevoke: (permission: string) => void;
  onAddMember: (steamId: string) => void;
  onRemoveMember: (steamId: string) => void;
  onPatch: (patch: { title?: string; rank?: number; parent?: string }) => void;
  onRemove: () => void;
}

function GroupRow({
  group,
  groups,
  permissions,
  busy,
  onGrant,
  onRevoke,
  onAddMember,
  onRemoveMember,
  onPatch,
  onRemove,
}: GroupRowProps) {
  const [aberto, setAberto] = useState(false);
  const [permissao, setPermissao] = useState('');
  const [steamId, setSteamId] = useState('');
  const [titulo, setTitulo] = useState('');
  const [rank, setRank] = useState('');
  const [pai, setPai] = useState('');

  /** O que ele já tem não precisa aparecer no seletor. */
  const disponiveis = permissions.filter((item) => !group.permissions.includes(item));

  return (
    <li>
      <button
        type="button"
        aria-expanded={aberto}
        onClick={() => setAberto(!aberto)}
        className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-2 text-left hover:bg-surface-2"
      >
        <span className="min-w-0">
          <span className="font-mono text-sm">{group.name}</span>

          {/* A herança em voz alta: é ela que faz o Ouro valer
              tudo o que o Bronze vale. */}
          {group.parents.length > 0 && (
            <span className="ml-2 text-2xs text-muted">herda de {group.parents.join(' → ')}</span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-3 text-2xs text-muted">
          <span>
            {group.members.length === 0
              ? 'ninguém dentro'
              : `${String(group.members.length)} jogador(es)`}
          </span>
          <span>
            {group.permissions.length === 0
              ? 'sem permissão própria'
              : `${String(group.permissions.length)} permissão(ões)`}
          </span>
        </span>
      </button>

      {aberto && (
        <div className="space-y-4 border-t border-border bg-surface-2 px-4 py-3">
          {/* ---- permissões ---- */}
          <div>
            <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Permissões deste grupo
            </p>

            <div className="mt-1 flex flex-wrap items-center gap-2">
              {group.permissions.length === 0 && (
                <span className="text-sm text-muted">Nenhuma concedida diretamente.</span>
              )}

              {group.permissions.map((permission) => (
                <span
                  key={permission}
                  className="flex items-center gap-2 border border-border bg-surface px-2 py-0.5"
                >
                  <span className="font-mono text-2xs">{permission}</span>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Revogar ${permission}`}
                    className="text-2xs uppercase tracking-wide text-muted hover:text-rust"
                    onClick={() => onRevoke(permission)}
                  >
                    revogar
                  </button>
                </span>
              ))}
            </div>

            {/* O que vem dos pais aparece separado e sem botão:
                revogar ali é decisão do grupo pai, e o mesmo botão
                sugeriria que dá para tirar daqui. */}
            {group.inherited
              .filter((parent) => parent.permissions.length > 0)
              .map((parent) => (
                <p key={parent.group} className="mt-1 text-2xs text-muted">
                  de <span className="font-mono">{parent.group}</span>:{' '}
                  {parent.permissions.join(', ')}
                </p>
              ))}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {/* Uma LISTA, e não um campo de texto: quem cria
                  permissão é o plugin, e digitar uma que não existe
                  é o jeito mais rápido de achar que se concedeu
                  alguma coisa. */}
              <select
                value={permissao}
                disabled={busy || disponiveis.length === 0}
                aria-label="Permissão a conceder"
                onChange={(event) => setPermissao(event.target.value)}
                className="border border-border bg-surface px-2 py-1.5 font-mono text-2xs text-foreground"
              >
                <option value="">
                  {disponiveis.length === 0 ? 'nada a conceder' : 'escolha uma permissão…'}
                </option>
                {disponiveis.map((permission) => (
                  <option key={permission} value={permission}>
                    {permission}
                  </option>
                ))}
              </select>

              <Button
                size="sm"
                variant="outline"
                disabled={busy || permissao === ''}
                onClick={() => {
                  onGrant(permissao);
                  setPermissao('');
                }}
              >
                Conceder
              </Button>
            </div>
          </div>

          {/* ---- membros ---- */}
          <div>
            <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Quem está dentro
            </p>

            {group.members.length === 0 ? (
              <p className="mt-1 text-sm text-muted">Ninguém.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {group.members.map((member) => (
                  <li key={member.steamId} className="flex flex-wrap items-center gap-2 text-sm">
                    <span>{member.name ?? EM_DASH}</span>
                    <span className="font-mono text-2xs text-muted">{member.steamId}</span>

                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Copiar o SteamID"
                      onClick={() => copySteamId(member.steamId)}
                    >
                      <Copy aria-hidden="true" className="h-4 w-4" />
                    </Button>

                    <ConfirmButton
                      variant="danger"
                      disabled={busy}
                      icon={null}
                      label="Tirar"
                      confirmLabel="Tirar mesmo"
                      hint={`${member.name ?? member.steamId} perde o que este grupo concede — na hora, mesmo jogando.`}
                      onConfirm={() => onRemoveMember(member.steamId)}
                    />
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                value={steamId}
                placeholder="76561198000000000"
                aria-label="SteamID de quem entra no grupo"
                inputMode="numeric"
                className="w-56 font-mono"
                onChange={(event) => setSteamId(event.target.value.trim())}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || steamId.length !== 17}
                onClick={() => {
                  onAddMember(steamId);
                  setSteamId('');
                }}
              >
                Pôr no grupo
              </Button>
              <span className="text-2xs text-muted">
                O jogador precisa ter entrado no servidor pelo menos uma vez.
              </span>
            </div>
          </div>

          {/* ---- título, rank e herança ---- */}
          <div>
            <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Título, ordem e herança
            </p>

            {/* ####  OS CAMPOS NASCEM VAZIOS DE PROPÓSITO  ####

                O console do Oxide NÃO devolve o título nem o rank
                de um grupo — ele só os aceita. Preencher com um
                palpite seria a tela afirmando o que não sabe. */}
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              O console não informa o título nem o rank atuais, só os aceita — por isso os campos
              começam vazios. Gravar substitui o que estiver lá.
            </p>

            <div className="mt-2 flex flex-wrap items-end gap-2">
              <span>
                <Label htmlFor={`titulo-${group.name}`}>Título</Label>
                <Input
                  id={`titulo-${group.name}`}
                  value={titulo}
                  placeholder="[VIP OURO]"
                  className="w-48"
                  onChange={(event) => setTitulo(event.target.value)}
                />
              </span>

              <span>
                <Label htmlFor={`rank-${group.name}`}>Rank</Label>
                <Input
                  id={`rank-${group.name}`}
                  value={rank}
                  placeholder="30"
                  inputMode="numeric"
                  className="w-24"
                  onChange={(event) => setRank(event.target.value.replace(/\D/g, ''))}
                />
              </span>

              <Button
                size="sm"
                variant="outline"
                disabled={busy || titulo.trim() === ''}
                onClick={() => {
                  onPatch({
                    title: titulo.trim(),
                    ...(rank === '' ? {} : { rank: Number(rank) }),
                  });
                  setTitulo('');
                  setRank('');
                }}
              >
                Gravar
              </Button>
            </div>

            <div className="mt-2 flex flex-wrap items-end gap-2">
              <span>
                <Label htmlFor={`pai-${group.name}`}>Herda de</Label>
                <select
                  id={`pai-${group.name}`}
                  value={pai}
                  disabled={busy}
                  onChange={(event) => setPai(event.target.value)}
                  className="mt-1 block border border-border bg-surface px-2 py-1.5 font-mono text-2xs text-foreground"
                >
                  <option value="">(ninguém — desliga a herança)</option>
                  {groups
                    .filter((other) => other.name !== group.name)
                    .map((other) => (
                      <option key={other.name} value={other.name}>
                        {other.name}
                      </option>
                    ))}
                </select>
              </span>

              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onPatch({ parent: pai })}
              >
                {pai === '' ? 'Tirar a herança' : 'Definir'}
              </Button>

              <span className="text-2xs text-muted">
                {group.parents.length === 0
                  ? 'Hoje ele não herda de ninguém.'
                  : `Hoje herda de ${group.parents.join(' → ')}.`}
              </span>
            </div>
          </div>

          {/* ---- remover ---- */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <p className="text-2xs leading-relaxed text-muted">
              Remover apaga as permissões dele e a lista de quem estava dentro. Um grupo que um
              plugin exige é recriado <strong>vazio</strong> no próximo carregamento.
            </p>

            <ConfirmButton
              variant="danger"
              disabled={busy}
              icon={null}
              label="Remover grupo"
              confirmLabel="Remover mesmo"
              hint={
                group.members.length === 0
                  ? `"${group.name}" some deste servidor.`
                  : `${String(group.members.length)} jogador(es) perdem o que "${group.name}" concede.`
              }
              onConfirm={onRemove}
            />
          </div>
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------
//  Criar grupo
// ------------------------------------------------------------

function CreateGroupDialog({
  groups,
  busy,
  onClose,
  onCreate,
}: {
  groups: OxideGroup[];
  busy: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; title?: string; rank?: number; parent?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [rank, setRank] = useState('');
  const [parent, setParent] = useState('');

  /** A mesma regra do agente. Vale avisar antes do envio. */
  const nomeValido = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);

  return (
    <Dialog open title="Criar grupo no Oxide" busy={busy} onClose={onClose}>
      <div className="space-y-4">
        {/* ####  O VIP NÃO NASCE AQUI  ####

            Quem cria os grupos de VIP é o plugin, ao carregar, a
            partir do config dele. Criar um à mão e esperar que o
            plugin o use é ao contrário. */}
        <p className="border border-border bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-muted">
          Os grupos de <strong>VIP</strong> são criados pelo próprio plugin quando ele carrega, a
          partir do <code>OrigemZVip.json</code>. Este formulário é para o resto: o grupo de um
          evento, o que um plugin de terceiro espera encontrar pronto.
        </p>

        <div>
          <Label htmlFor="grupo-nome">Nome</Label>
          <Input
            id="grupo-nome"
            value={name}
            placeholder="evento.natal"
            className="font-mono"
            onChange={(event) => setName(event.target.value.trim())}
          />
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            Letras, números, ponto, hífen ou sublinhado — <strong>sem espaço e sem acento</strong>:
            o nome vai para a linha de comando do servidor. Os deste projeto se parecem com{' '}
            <code>origemz.vip.bronze</code>.
          </p>
        </div>

        <div>
          <Label htmlFor="grupo-titulo">Título (opcional)</Label>
          <Input
            id="grupo-titulo"
            value={title}
            placeholder="[EVENTO]"
            onChange={(event) => setTitle(event.target.value)}
          />
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            É o rótulo que plugins de chat usam como tag ao lado do nome.
          </p>
        </div>

        <div>
          <Label htmlFor="grupo-rank">Rank (opcional)</Label>
          <Input
            id="grupo-rank"
            value={rank}
            placeholder="10"
            inputMode="numeric"
            className="w-24"
            onChange={(event) => setRank(event.target.value.replace(/\D/g, ''))}
          />
        </div>

        <div>
          <Label htmlFor="grupo-pai">Herda de (opcional)</Label>
          <select
            id="grupo-pai"
            value={parent}
            onChange={(event) => setParent(event.target.value)}
            className="mt-1 block w-full border border-border bg-surface px-2 py-2 font-mono text-2xs text-foreground"
          >
            <option value="">(ninguém)</option>
            {groups.map((group) => (
              <option key={group.name} value={group.name}>
                {group.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            Herdar é o que faz um nível valer tudo o que o anterior vale — é assim que o Ouro
            carrega o Prata e o Bronze.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={busy || !nomeValido}
            onClick={() =>
              onCreate({
                name,
                ...(title.trim() === '' ? {} : { title: title.trim() }),
                ...(rank === '' ? {} : { rank: Number(rank) }),
                ...(parent === '' ? {} : { parent }),
              })
            }
          >
            {busy ? 'Criando…' : 'Criar grupo'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
