'use client';

// ============================================================
//  spawn-status-panel.tsx  -  com quanta vida, fome e sede cada
//  GRUPO nasce.
//
//  Irmã da sub-aba Loadouts, e a divisão entre as duas é essa: lá
//  se decide o que o jogador GANHA (os itens), aqui o ESTADO em que
//  ele acorda. A lista de grupos é a mesma, e vem do Oxide deste
//  servidor.
//
//  ####  VAZIO É "O JOGO DECIDE", E NÃO ZERO  ####
//
//  É a regra que atravessa daqui até o plugin, e a tela precisa
//  dizê-la em voz alta: campo em branco NÃO é o mesmo que 0. Zero
//  de comida é nascer com a barra vazia, passando fome de imediato;
//  em branco é não encostar naquele atributo.
//
//  Por isso o campo é texto com placeholder do padrão do Rust, e
//  não um número já preenchido: um `0` no campo seria uma
//  configuração que ninguém pediu.
//
//  ####  ISSO VALE UMA VEZ, AO NASCER  ####
//
//  O plugin aplica no respawn e não vigia o jogador depois. Um VIP
//  que nasce de barriga cheia passa fome no mesmo ritmo de todo
//  mundo no segundo seguinte — e é assim de propósito.
// ============================================================

import { RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { agent, type ServerSpawnStatus } from '@/lib/api';
import { EM_DASH, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';

/**
 * Espelha o `SPAWN_LIMITS` de core/src/loadouts/status.ts.
 *
 * Duplicado de propósito, e não importado: o painel não compartilha
 * módulo com o núcleo. O agente valida de novo — esta cópia existe
 * para a pessoa ver o problema ANTES de gravar, e não para ser a
 * única guarda.
 */
const ATTRIBUTES = [
  {
    key: 'health',
    label: 'Vida',
    min: 1,
    max: 1000,
    gameDefault: 100,
    hint: 'O padrão do Rust é 100. Acima disso o plugin levanta o máximo do jogador — e a vida extra vale até ele tomar dano.',
  },
  {
    key: 'calories',
    label: 'Comida',
    min: 0,
    max: 1000,
    gameDefault: 500,
    hint: 'O máximo padrão do Rust é 500. 0 é nascer com a barra vazia, passando fome.',
  },
  {
    key: 'hydration',
    label: 'Água',
    min: 0,
    max: 1000,
    gameDefault: 250,
    hint: 'O máximo padrão do Rust é 250. 0 é nascer com sede.',
  },
] as const;

type AttributeKey = (typeof ATTRIBUTES)[number]['key'];

/** O rascunho guarda TEXTO: só assim "em branco" existe. */
type Draft = Record<AttributeKey, string>;

const EMPTY_DRAFT: Draft = { health: '', calories: '', hydration: '' };

function draftOf(group: ServerSpawnStatus): Draft {
  return {
    health: group.health === null ? '' : String(group.health),
    calories: group.calories === null ? '' : String(group.calories),
    hydration: group.hydration === null ? '' : String(group.hydration),
  };
}

/** O resumo que aparece na linha fechada. */
function summaryOf(group: ServerSpawnStatus): string {
  const parts = ATTRIBUTES.filter((attribute) => group[attribute.key] !== null).map(
    (attribute) => `${attribute.label.toLowerCase()} ${String(group[attribute.key])}`,
  );

  return parts.length === 0 ? 'sem status — o jogo decide' : parts.join(' · ');
}

type ParsedDraft =
  | { readonly values: Record<AttributeKey, number | null> }
  | { readonly error: string };

/**
 * O que vai para o agente, ou a frase do problema.
 *
 * Em branco vira `null`, que é justamente o "o jogo decide".
 */
function parseDraft(draft: Draft): ParsedDraft {
  const values: Record<AttributeKey, number | null> = {
    health: null,
    calories: null,
    hydration: null,
  };

  for (const attribute of ATTRIBUTES) {
    const raw = draft[attribute.key].trim().replace(',', '.');

    if (raw === '') {
      continue;
    }

    const value = Number(raw);

    if (!Number.isFinite(value)) {
      return { error: `"${raw}" não é um número — o campo ${attribute.label} não aceita isso.` };
    }

    if (value < attribute.min || value > attribute.max) {
      return {
        error:
          `${attribute.label} precisa ficar entre ${String(attribute.min)} e ` +
          `${String(attribute.max)}.`,
      };
    }

    values[attribute.key] = value;
  }

  return { values };
}

export function SpawnStatusPanel({ serverId }: { readonly serverId: string }) {
  const [groups, setGroups] = useState<ServerSpawnStatus[] | null>(null);
  const [connected, setConnected] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Qual grupo está aberto para edição. `null` = nenhum. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftEnabled, setDraftEnabled] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await agent.spawnStatus(serverId);

      setGroups(response.groups);
      setConnected(response.connected);
      setMessage(response.message ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  function open(group: ServerSpawnStatus): void {
    setEditing(group.name);
    setDraft(draftOf(group));
    setDraftEnabled(group.enabled);
  }

  async function save(group: string): Promise<void> {
    const parsed = parseDraft(draft);

    if ('error' in parsed) {
      toast.error('Confira os valores', { description: parsed.error });
      return;
    }

    const { values } = parsed;

    // Os três em branco não são configuração: são a ausência dela.
    // Gravar isso deixaria uma linha na tela que não faz nada no
    // jogo — e o agente recusa, com a mesma frase.
    if (values.health === null && values.calories === null && values.hydration === null) {
      toast.error('Nada para gravar', {
        description:
          'Os três campos estão em branco, que é o mesmo que não ter status. Preencha algum, ' +
          'ou apague o status deste grupo.',
      });
      return;
    }

    setBusy(true);

    try {
      const response = await agent.saveSpawnStatus(serverId, group, {
        ...values,
        enabled: draftEnabled,
      });

      toast.success('Status gravado', { description: response.message });
      setEditing(null);
      await load();
    } catch (cause) {
      toast.error('Não consegui gravar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(group: string): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.removeSpawnStatus(serverId, group);

      toast.success('Status apagado', { description: response.message });
      setEditing(null);
      await load();
    } catch (cause) {
      toast.error('Não consegui apagar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function sync(): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.syncSpawnStatus(serverId);

      toast.success('Estado empurrado', { description: response.message });
    } catch (cause) {
      toast.error('Não consegui empurrar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  /** Preenche os três com o padrão do Rust — o "nasce cheio". */
  function fillFull(): void {
    setDraft({
      health: String(ATTRIBUTES[0].gameDefault),
      calories: String(ATTRIBUTES[1].gameDefault),
      hydration: String(ATTRIBUTES[2].gameDefault),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface px-3 py-2">
        <p className="max-w-2xl text-2xs leading-relaxed text-muted">
          Com que <strong>vida, comida e água</strong> nasce quem está em cada grupo. Campo em
          branco é <strong>o jogo decide</strong> — e não zero. Vale <strong>uma vez</strong>, no
          nascimento: dali em diante o jogador segue as regras de todo mundo.
        </p>

        <Button variant="outline" size="sm" disabled={busy} onClick={() => void sync()}>
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          Reempurrar agora
        </Button>
      </div>

      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler o status" detail={error} />
      )}

      {message !== null && (
        <StateBlock
          variant={connected ? 'empty' : 'offline'}
          title={connected ? 'Atenção' : 'Servidor fora do ar'}
          detail={message}
        />
      )}

      {groups === null && error === null && <StateBlock variant="loading" title="Lendo…" />}

      {groups !== null && groups.length === 0 && (
        <StateBlock
          variant="empty"
          title="Nenhum grupo por aqui"
          detail="Os grupos vêm do Oxide deste servidor. Os de VIP nascem com o OrigemZVip; os outros, em Configurações → Oxide."
        />
      )}

      {groups?.map((group) => {
        const configured = ATTRIBUTES.some((attribute) => group[attribute.key] !== null);

        return (
          <div key={group.name} className="border border-border bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
                  <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
                  <span className="truncate font-mono normal-case tracking-normal">
                    {group.name}
                  </span>
                </p>

                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                  <span>{summaryOf(group)}</span>

                  {group.members !== null && (
                    <span className="inline-flex items-center gap-1">
                      <Users aria-hidden="true" className="h-3 w-3" />
                      {group.members} dentro
                    </span>
                  )}

                  <span>
                    {group.updatedAt === null ? EM_DASH : `alterado ${formatWhen(group.updatedAt)}`}
                    {group.updatedBy === null ? '' : ` por ${group.updatedBy}`}
                  </span>

                  {group.exists === false && (
                    <span className="text-amber">
                      o grupo não existe mais no Oxide — este status não vai para o jogo
                    </span>
                  )}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {!group.enabled && <span className="text-2xs text-amber">desligado</span>}

                <Button
                  variant={editing === group.name ? 'outline' : 'primary'}
                  size="sm"
                  disabled={busy}
                  onClick={() => (editing === group.name ? setEditing(null) : open(group))}
                >
                  {editing === group.name ? 'Fechar' : configured ? 'Editar' : 'Configurar'}
                </Button>
              </div>
            </div>

            {editing === group.name && (
              <div className="space-y-3 p-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  {ATTRIBUTES.map((attribute) => (
                    <label key={attribute.key} className="block">
                      <span className="font-condensed text-2xs font-bold uppercase tracking-wide">
                        {attribute.label}
                      </span>

                      <Input
                        inputMode="decimal"
                        value={draft[attribute.key]}
                        disabled={busy}
                        placeholder={`o jogo decide (${String(attribute.gameDefault)})`}
                        onChange={(event) =>
                          setDraft({ ...draft, [attribute.key]: event.target.value })
                        }
                        className="mt-1 font-mono"
                      />

                      <span className="mt-1 block text-2xs leading-relaxed text-muted">
                        {attribute.hint}
                      </span>
                    </label>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" disabled={busy} onClick={fillFull}>
                    Nasce cheio
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDraft(EMPTY_DRAFT)}
                  >
                    Limpar os três
                  </Button>

                  <span className="text-2xs leading-relaxed text-muted">
                    Limpar os três e gravar não vale: isso é o mesmo que não ter status — use
                    Apagar.
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                  <div className="flex items-center gap-3">
                    <Toggle
                      on={draftEnabled}
                      busy={busy}
                      labels={['Ligado', 'Desligado']}
                      onChange={setDraftEnabled}
                    />
                    <span className="max-w-72 text-2xs leading-relaxed text-muted">
                      Desligado, o status continua guardado aqui e{' '}
                      <strong>não vai para o jogo</strong>.
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {configured && (
                      <ConfirmButton
                        variant="danger"
                        disabled={busy}
                        icon={null}
                        label="Apagar"
                        confirmLabel="Apagar mesmo"
                        hint={`Quem nascer em "${group.name}" volta ao padrão do Rust.`}
                        onConfirm={() => void remove(group.name)}
                      />
                    )}

                    <Button variant="primary" disabled={busy} onClick={() => void save(group.name)}>
                      {busy ? 'Gravando…' : 'Gravar'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
