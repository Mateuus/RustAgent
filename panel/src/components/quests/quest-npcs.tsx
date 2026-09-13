'use client';

// ============================================================
//  quest-npcs.tsx  -  os bonecos que dão missão.
//
//  ####  POR QUE ELES SAÍRAM DA MANUTENÇÃO  ####
//
//  Estavam numa caixa entre as recompensas travadas e o botão de
//  zerar progresso — lugar onde se vai quando algo quebrou. Mas o
//  NPC é rotina: pedido do dono em 11/09/2026, depois do teste em
//  que ninguém achou onde ver a lista, a posição e a missão de cada
//  um. Agora ele é uma aba, ao lado de Catálogo e Progresso.
//
//  ####  O MAPA É A LISTA  ####
//
//  Uma linha dizendo "194, 747" não responde "onde ele está" para
//  ninguém. O mapa responde, e é o mesmo componente que os pontos
//  de nascimento da masmorra já usam.
//
//  ####  O QUE NÃO SE FAZ DAQUI: A POSIÇÃO  ####
//
//  Ninguém escolhe coordenada digitando número. Mover é ir até o
//  lugar no jogo e digitar `/questnpc move <id>` — o comando TRAZ o
//  boneco. Até 11/09 este painel mandava usar o `add` de novo, que
//  criava um SEGUNDO NPC com o sufixo `-2`.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §10.
// ============================================================

import { MapPin, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { MapView } from '@/components/map-view';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { useMapImage } from '@/lib/hooks/use-map-image';
import {
  agent,
  type PlayersSnapshot,
  type QuestDefinition,
  type QuestNpc,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Os bonecos que um NPC pode vestir.
 *
 * ####  ESPELHA `NPC_PREFABS` DE core/src/types/quests.ts  ####
 *
 * E a coluna que importa é a `talks`: o prompt **TALK** do jogo é
 * do `NPCTalking`. Quem escolher um boneco mudo terá um NPC que
 * funciona só pelo alcance do USE — sem aviso nenhum na tela de
 * quem chega perto. Foi o que o teste de 11/09/2026 encontrou, e
 * por isso o painel avisa em vez de esconder a opção.
 */
const NPC_PREFABS = [
  {
    prefab: 'assets/prefabs/npc/bandit/shopkeepers/bandit_conversationalist.prefab',
    label: 'Aviador do Bandit',
    talks: true,
  },
  {
    prefab: 'assets/prefabs/npc/bandit/shopkeepers/boat_shopkeeper.prefab',
    label: 'Barqueiro',
    talks: true,
  },
  {
    prefab: 'assets/prefabs/npc/bandit/shopkeepers/stables_shopkeeper.prefab',
    label: 'Cavalariço',
    talks: true,
  },
  {
    prefab: 'assets/prefabs/npc/apartment/apartment_vendor.prefab',
    label: 'Porteiro',
    talks: true,
  },
  {
    prefab: 'assets/prefabs/npc/bandit/shopkeepers/bandit_shopkeeper.prefab',
    label: 'Vendedor do Bandit (mudo)',
    talks: false,
  },
  {
    prefab: 'assets/prefabs/npc/waterwell/waterwell_shopkeeper.prefab',
    label: 'Poceiro (mudo)',
    talks: false,
  },
] as const;

function prefabLabel(prefab: string): string {
  return NPC_PREFABS.find((option) => option.prefab === prefab)?.label ?? 'Boneco personalizado';
}

function prefabTalks(prefab: string): boolean {
  return NPC_PREFABS.some((option) => option.prefab === prefab && option.talks);
}

export function QuestNpcsPanel({
  quests,
  servers,
  onChanged,
}: {
  readonly quests: readonly QuestDefinition[];
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly onChanged: () => void;
}) {
  const [npcs, setNpcs] = useState<readonly QuestNpc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** `''` = ainda não escolhido; vira o primeiro que tiver NPC. */
  const [serverId, setServerId] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await agent.questNpcs();

      setNpcs(response.npcs);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setNpcs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // O servidor da vez: o primeiro que tiver NPC, senão o primeiro
  // da rede. Escolher sozinho evita a tela vazia de abertura, que
  // pareceria "não há NPC nenhum".
  useEffect(() => {
    if (serverId !== '' || npcs === null) {
      return;
    }

    setServerId(npcs[0]?.serverId ?? servers[0]?.id ?? '');
  }, [npcs, servers, serverId]);

  const here = (npcs ?? []).filter((npc) => npc.serverId === serverId);

  return (
    <div className="space-y-4">
      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler os NPCs" detail={error} />
      )}

      {npcs !== null && npcs.length === 0 && (
        <StateBlock
          variant="empty"
          title="Nenhum NPC ainda"
          detail="Ninguém escolhe coordenada digitando número: entre no jogo, vá até o lugar, olhe para onde ele deve olhar e digite /questnpc add <nome>. Ele nasce em instantes, e o resto se faz daqui."
        />
      )}

      {npcs !== null && npcs.length > 0 && (
        <>
          {servers.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {servers.map((server) => (
                <button
                  key={server.id}
                  type="button"
                  onClick={() => setServerId(server.id)}
                  className={cn(
                    'rounded border px-2 py-1 font-condensed text-2xs uppercase tracking-wide',
                    server.id === serverId
                      ? 'border-rust bg-rust/10 text-foreground'
                      : 'border-border text-muted hover:text-foreground',
                  )}
                >
                  {server.name} (
                  {String(npcs.filter((npc) => npc.serverId === server.id).length)})
                </button>
              ))}
            </div>
          )}

          <NpcMap serverId={serverId} npcs={here} />

          <Section title={`NPCs${serverId === '' ? '' : ` · ${serverId}`}`}>
            <div className="space-y-2">
              {here.map((npc) => (
                <NpcRow
                  key={npc.id}
                  npc={npc}
                  quests={quests}
                  onChanged={() => {
                    void load();
                    onChanged();
                  }}
                />
              ))}

              {here.length === 0 && (
                <p className="text-2xs text-muted">
                  Nenhum NPC neste servidor. Entre nele e use{' '}
                  <code className="text-foreground">/questnpc add &lt;nome&gt;</code>.
                </p>
              )}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  O MAPA
// ------------------------------------------------------------

/**
 * Onde eles estão.
 *
 * O mapa precisa do tamanho do mundo, e quem o traz é a leitura dos
 * jogadores — a mesma escolha do painel de pontos de nascimento.
 * Servidor parado: a lista abaixo continua valendo, e é o mapa que
 * fica de fora.
 */
function NpcMap({ serverId, npcs }: { readonly serverId: string; readonly npcs: readonly QuestNpc[] }) {
  const [snapshot, setSnapshot] = useState<PlayersSnapshot | null>(null);
  const mapImage = useMapImage(serverId);

  useEffect(() => {
    let alive = true;

    setSnapshot(null);

    if (serverId === '') {
      return;
    }

    void (async () => {
      try {
        const response = await agent.players(serverId);

        if (alive) {
          setSnapshot(response);
        }
      } catch {
        // Servidor fora do ar. A lista é do banco e continua de pé.
      }
    })();

    return () => {
      alive = false;
    };
  }, [serverId]);

  const marks = useMemo(
    () =>
      npcs.map((npc) => ({
        id: npc.id,
        x: npc.x,
        z: npc.z,
        label: npc.name,
        tone: npc.enabled ? ('normal' as const) : ('muted' as const),
      })),
    [npcs],
  );

  if (snapshot === null) {
    return (
      <div className="border border-border bg-surface-2 p-4 text-center text-2xs text-muted">
        O mapa é do servidor, e ele não está respondendo agora. A lista abaixo continua valendo.
      </div>
    );
  }

  return (
    <div className="h-120 min-h-64">
      <MapView
        players={snapshot.players}
        world={snapshot.world}
        selected={null}
        onSelect={() => undefined}
        imageUrl={mapImage.url}
        coverage={mapImage.coverage}
        marks={marks}
      />
    </div>
  );
}

// ------------------------------------------------------------
//  A LINHA
// ------------------------------------------------------------

function NpcRow({
  npc,
  quests,
  onChanged,
}: {
  readonly npc: QuestNpc;
  readonly quests: readonly QuestDefinition[];
  readonly onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setError(null);

    try {
      const result = await agent.removeQuestNpc(npc.id);

      if (result.orphaned.length > 0) {
        // A quest NÃO vai junto — ela volta a ser uma quest de
        // menu, com o progresso de quem estava fazendo intacto. Mas
        // isso precisa ser dito: ela some do mapa sem sumir da
        // lista.
        setError(
          `O NPC saiu. Estas missões deixaram de ter balcão e agora se pegam pelo menu: ${result.orphaned.join(', ')}.`,
        );
      }

      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="rounded border border-border p-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-condensed text-xs font-bold">
            <MapPin className="h-3.5 w-3.5 text-rust" />
            {npc.name}
            {!npc.enabled && (
              <span className="text-2xs uppercase tracking-wide text-muted">desligado</span>
            )}
            {npc.kind === 'delivery' && (
              <span className="text-2xs uppercase tracking-wide text-muted">só entregas</span>
            )}
          </p>
          <p className="text-2xs text-muted">
            {npc.x.toFixed(0)}, {npc.z.toFixed(0)} · raio {npc.useRadius.toFixed(1)} m ·{' '}
            {prefabLabel(npc.prefab)}
            {npc.wipePolicy === 'remove' && ' · some no wipe'}
          </p>

          {/* O prompt do jogo é do `NPCTalking`. Um boneco mudo não
              o mostra, e o jogador chega perto sem ver nada — o
              sintoma que o teste de 11/09/2026 relatou. */}
          {!prefabTalks(npc.prefab) && (
            <p className="mt-1 text-2xs text-amber">
              Este boneco não mostra “TALK”: quem chegar perto precisa apertar USE às cegas. Troque
              no lápis para um dos que falam.
            </p>
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          <NpcEditor npc={npc} onSaved={onChanged} />
          <button
            type="button"
            aria-label="Apagar NPC"
            onClick={() => void remove()}
            className="rounded border border-border p-1.5 text-muted hover:text-rust"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <NpcQuests npc={npc} quests={quests} onChanged={onChanged} />

      {error !== null && (
        <p className="mt-2 rounded border border-amber/40 bg-amber/10 px-2 py-1.5 text-2xs text-amber">
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  AS MISSÕES DELE
// ------------------------------------------------------------

/**
 * O que este NPC oferece, pelo NOME.
 *
 * Antes a linha dizia "2 missão(ões)" — número que não responde a
 * pergunta de quem abriu a tela. Vincular e desvincular acontece
 * aqui pelo mesmo motivo: a alternativa era abrir o editor de cada
 * missão para descobrir a qual boneco ela pertence.
 */
function NpcQuests({
  npc,
  quests,
  onChanged,
}: {
  readonly npc: QuestNpc;
  readonly quests: readonly QuestDefinition[];
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const mine = quests.filter((quest) => quest.npcId === npc.id);
  // Candidatas: as sem balcão, e só as que valem naquele servidor —
  // a API recusa vincular uma quest de outro mundo, e oferecer o
  // que vai ser recusado é pior que não oferecer.
  const free = quests.filter(
    (quest) =>
      quest.npcId === null &&
      (quest.servers.length === 0 || quest.servers.includes(npc.serverId)),
  );

  async function link(quest: QuestDefinition, npcId: string | null) {
    setBusy(true);
    setError(null);

    try {
      const { id, createdAt, updatedAt, ...body } = quest;

      void id;
      void createdAt;
      void updatedAt;

      await agent.updateQuest(quest.id, { ...body, npcId });
      setAdding(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  // Um NPC de entrega não tem vitrine: ele existe para receber o
  // pacote. Ver a regra no serviço.
  if (npc.kind === 'delivery') {
    return (
      <p className="mt-2 text-2xs text-muted">
        Ele recebe entregas. Quem escolhe este NPC como destino é o objetivo da missão, no editor
        dela.
      </p>
    );
  }

  return (
    <div className="mt-2 border-t border-border pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Oferece</span>

        {mine.length === 0 && (
          <span className="text-2xs text-muted">nada ainda — ele é só um ponto no mapa</span>
        )}

        {mine.map((quest) => (
          <span
            key={quest.id}
            className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-2xs"
          >
            {quest.title}
            {!quest.enabled && <span className="text-muted">(desligada)</span>}
            <button
              type="button"
              disabled={busy}
              aria-label={`Desvincular ${quest.title}`}
              onClick={() => void link(quest, null)}
              className="text-muted hover:text-rust"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}

        {!adding && free.length > 0 && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 rounded border border-dashed border-border px-1.5 py-0.5 text-2xs text-muted hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            Atribuir
          </button>
        )}

        {adding && (
          <select
            autoFocus
            disabled={busy}
            defaultValue=""
            className="rounded border border-border bg-background px-2 py-1 text-2xs"
            onChange={(event) => {
              const quest = free.find((item) => item.id === event.target.value);

              if (quest !== undefined) {
                void link(quest, npc.id);
              }
            }}
          >
            <option value="">escolha a missão…</option>
            {free.map((quest) => (
              <option key={quest.id} value={quest.id}>
                {quest.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {mine.length > 0 && (
        <p className="mt-1 text-2xs text-muted">
          Elas aparecem no menu marcadas com “fale com {npc.name}”, e só se pegam aqui no balcão.
        </p>
      )}

      {error !== null && <p className="mt-1 text-2xs text-rust">{error}</p>}
    </div>
  );
}

// ------------------------------------------------------------
//  O EDITOR
// ------------------------------------------------------------

/**
 * Editar um NPC.
 *
 * ####  A POSIÇÃO NÃO ESTÁ AQUI, E É DE PROPÓSITO  ####
 *
 * Ninguém escolhe coordenada digitando número. Para mover, o admin
 * vai até o novo lugar no jogo e usa `/questnpc move <id>` — o
 * comando TRAZ o boneco, e é a única forma que não deixa um
 * segundo NPC para trás.
 */
function NpcEditor({ npc, onSaved }: { readonly npc: QuestNpc; readonly onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(npc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);

    try {
      await agent.updateQuestNpc(npc.id, {
        serverId: form.serverId,
        name: form.name,
        kind: form.kind,
        x: form.x,
        y: form.y,
        z: form.z,
        rotation: form.rotation,
        prefab: form.prefab,
        mapMarker: form.mapMarker,
        useRadius: form.useRadius,
        enabled: form.enabled,
        wipePolicy: form.wipePolicy,
      });

      setOpen(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Editar NPC"
        onClick={() => {
          setForm(npc);
          setOpen(true);
        }}
        className="rounded border border-border p-1.5 text-muted hover:text-foreground"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded border border-border bg-surface p-4">
        <h3 className="mb-3 font-condensed text-sm font-bold uppercase tracking-wide">{npc.name}</h3>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
              Nome
            </span>
            <input
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>

          <label className="block">
            <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
              Boneco
            </span>
            <select
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              value={form.prefab}
              onChange={(event) => setForm({ ...form, prefab: event.target.value })}
            >
              {NPC_PREFABS.map((option) => (
                <option key={option.prefab} value={option.prefab}>
                  {option.label}
                </option>
              ))}
              {/* Um prefab escrito na mão continua valendo: a coluna
                  aceita qualquer caminho, e a lista é conveniência. */}
              {!NPC_PREFABS.some((option) => option.prefab === form.prefab) && (
                <option value={form.prefab}>{form.prefab}</option>
              )}
            </select>
            <span className="mt-1 block text-2xs text-muted">
              {prefabTalks(form.prefab)
                ? 'Mostra “TALK” quando o jogador mira nele.'
                : 'Este não mostra “TALK”: só responde ao USE, sem aviso na tela.'}
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
              Papel
            </span>
            <select
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              value={form.kind}
              onChange={(event) =>
                setForm({ ...form, kind: event.target.value as QuestNpc['kind'] })
              }
            >
              <option value="quest">Oferece missões</option>
              <option value="delivery">Só recebe entregas</option>
            </select>
            {/* Um NPC de entrega NÃO abre lista de missões: ele
                existe para receber o pacote, e uma vitrine ali
                confundiria quem chegou para entregar. */}
            {form.kind === 'delivery' && (
              <span className="mt-1 block text-2xs text-muted">
                Ele não mostra missões: serve como destino de entrega.
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
              Alcance do USE (metros)
            </span>
            <input
              type="number"
              min={0.5}
              max={20}
              step={0.5}
              className="w-24 rounded border border-border bg-background px-2 py-1.5 text-xs"
              value={form.useRadius}
              onChange={(event) => setForm({ ...form, useRadius: Number(event.target.value) })}
            />
            {/* O TALK do jogo tem alcance FIXO de 3 m — é o teto do
                RPC (`RPC_Server.MaxDistance(3f)`), e não uma escolha
                nossa. Acima disso só o USE por proximidade alcança. */}
            {form.useRadius > 3 && (
              <span className="mt-1 block text-2xs text-muted">
                O “TALK” do jogo só vale até 3 m. Acima disso, o jogador precisa apertar USE.
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
              No wipe
            </span>
            <select
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              value={form.wipePolicy}
              onChange={(event) =>
                setForm({ ...form, wipePolicy: event.target.value as QuestNpc['wipePolicy'] })
              }
            >
              <option value="keep">A posição sobrevive</option>
              <option value="remove">Some (a posição era só daquele mapa)</option>
            </select>
          </label>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-2xs text-muted">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-rust"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              Ligado
            </label>
            <label className="flex items-center gap-2 text-2xs text-muted">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-rust"
                checked={form.mapMarker}
                onChange={(event) => setForm({ ...form, mapMarker: event.target.checked })}
              />
              Marcar no mapa
            </label>
          </div>

          <p className="text-2xs text-muted">
            Posição: {form.x.toFixed(0)}, {form.z.toFixed(0)}. Para mover, vá até o novo lugar no
            jogo e use <code className="text-foreground">/questnpc move {npc.id}</code> — ele vem
            para onde você está.
          </p>

          {error !== null && <p className="text-2xs text-rust">{error}</p>}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded border border-border px-3 py-1.5 text-2xs uppercase tracking-wide"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded bg-rust px-3 py-1.5 text-2xs uppercase tracking-wide text-white disabled:opacity-50"
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
