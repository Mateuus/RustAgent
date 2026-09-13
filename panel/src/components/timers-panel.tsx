'use client';

// ============================================================
//  timers-panel.tsx  -  quão RÁPIDO as coisas andam para cada
//  GRUPO: fornalha, craft, pesquisa e reciclador.
//
//  A terceira divisão da aba Player, e a que era maquete. Cada timer
//  é um multiplicador de VELOCIDADE: ×2 é duas vezes mais rápido —
//  metade do tempo. Quem aplica é o OrigemZPlayer (seção OS TIMERS).
//
//  ------------------------------------------------------------
//  ####  UMA GRADE, E NÃO UMA LISTA DE LINHAS FECHADAS  ####
//
//  Loadouts e Status abrem um grupo por vez porque o conteúdo de cada
//  um é grande (itens, faixas). Aqui cada grupo são quatro números, e a
//  pergunta que a tela responde é COMPARATIVA — "o gold anda mais
//  rápido que o bronze?". Os quatro ficam à vista para todos os grupos
//  de uma vez, e só a edição abre.
//
//  ####  EM BRANCO NÃO É ×1  ####
//
//  É "este grupo não decide", e o plugin desce um nível: admin → VIP
//  → normal → o jogo. A célula em branco mostra o que vale DE FATO —
//  apagada, e com a origem ("herda do normal") —, para ninguém gravar
//  ×1 num VIP achando que está limpando o campo. Por isso também o ×1
//  não é um atalho do editor: o atalho é "em branco".
//
//  ####  A ORDEM É A DA HIERARQUIA  ####
//
//  O agente já manda a lista assim: normal, os VIPs pelo Rank, admin,
//  e por fim quem não é nível. É a ordem em que o plugin desce, e é o
//  que deixa o "herda" desta tela ser lido de cima para baixo.
// ============================================================

import {
  ChevronRight,
  Flame,
  FlaskConical,
  Hammer,
  Recycle,
  RefreshCw,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { HelpTip, type HelpTopic } from '@/components/ui/help-tip';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { agent, type ServerPlayerTimers } from '@/lib/api';
import { EM_DASH, formatInteger, formatWhen } from '@/lib/format';
import { TIMERS_HELP } from '@/lib/help/timers';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Espelha o `TIMER_LIMITS` de core/src/loadouts/timers.ts.
 *
 * Duplicado de propósito, e não importado: o painel não compartilha
 * módulo com o núcleo. O agente valida de novo — esta cópia existe
 * para a pessoa ver o problema ANTES de gravar.
 */
const LIMITS = { min: 1, max: 20 } as const;

type TimerKey = 'smelt' | 'craft' | 'research' | 'recycle';

interface TimerMeta {
  readonly key: TimerKey;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly help: HelpTopic;
}

const TIMERS: readonly TimerMeta[] = [
  { key: 'smelt', label: 'Fornalha', icon: Flame, help: TIMERS_HELP.smelt },
  { key: 'craft', label: 'Craft', icon: Hammer, help: TIMERS_HELP.craft },
  { key: 'research', label: 'Pesquisa', icon: FlaskConical, help: TIMERS_HELP.research },
  { key: 'recycle', label: 'Reciclador', icon: Recycle, help: TIMERS_HELP.recycle },
];

/** Os atalhos do editor. O ×1 não está aqui — ver o cabeçalho. */
const PRESETS = [1.5, 2, 3, 5, 10] as const;

const NORMAL_TIER = 'normal';
const ADMIN_TIER = 'admin';

/**
 * O esqueleto da grade: o grupo, os quatro timers e a ação. O mesmo
 * nas linhas e no cabeçalho, senão as colunas não se alinham.
 */
const GRID = 'md:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))_6.5rem]';

/** O rascunho guarda TEXTO: só assim "em branco" existe. */
type Draft = Record<TimerKey, string>;

const EMPTY_DRAFT: Draft = { smelt: '', craft: '', research: '', recycle: '' };

/**
 * O que uma célula mostra.
 *
 *   own        o grupo decide este timer
 *   inherited  em branco, e o normal decide por ele
 *   game       em branco, e ninguém decide: é o tempo do Rust
 *   follows    em branco no admin: segue o VIP ou o normal do jogador
 *   unused     grupo que não é nível — o plugin nunca o consulta
 */
type Resolved =
  | { readonly kind: 'own'; readonly speed: number }
  | { readonly kind: 'inherited'; readonly speed: number }
  | { readonly kind: 'game' }
  | { readonly kind: 'follows' }
  | { readonly kind: 'unused' };

/** ×1,5 — com vírgula, como se escreve em português. */
function formatSpeed(speed: number): string {
  return `×${(Math.round(speed * 100) / 100).toLocaleString('pt-BR')}`;
}

/** "33% do tempo". */
function timeShare(speed: number): string {
  return `${String(Math.round(100 / speed))}% do tempo`;
}

/** 1 minuto dividido pela velocidade, no formato mais curto que ainda lê bem. */
function oneMinuteAt(speed: number): string {
  const seconds = 60 / speed;

  return seconds >= 59.95
    ? '1 min'
    : `${(Math.round(seconds * 10) / 10).toLocaleString('pt-BR')} s`;
}

/**
 * O tamanho da barra, em escala LOG até o teto.
 *
 * Em escala linear, ×2 ocuparia 5% da barra — um risco que ninguém vê
 * —, e ×2 é justamente o valor mais comum de VIP.
 */
function barShare(speed: number): number {
  if (speed <= LIMITS.min) {
    return 0;
  }

  return Math.min(1, Math.log(speed) / Math.log(LIMITS.max));
}

/**
 * O texto do rascunho: um número, `null` (em branco), ou a frase do
 * problema. O ×1 digitado vira `null` — é o mesmo que o agente faz.
 */
function parseSpeed(raw: string, label: string): number | null | string {
  const clean = raw.trim().replace(',', '.');

  if (clean === '') {
    return null;
  }

  const value = Number(clean);

  if (!Number.isFinite(value)) {
    return `"${raw.trim()}" não é um número — ${label.toLowerCase()} não aceita isso.`;
  }

  if (value > LIMITS.max) {
    return (
      `${label} vai até ×${String(LIMITS.max)} — é o teto do plugin, onde o custo no servidor ` +
      'ainda é baixo.'
    );
  }

  if (value < LIMITS.min) {
    return (
      `${label} começa em ×${String(LIMITS.min)}, que é o tempo do Rust: abaixo disso seria mais ` +
      'devagar que o jogo, e o plugin não desacelera nada.'
    );
  }

  return value <= LIMITS.min ? null : value;
}

function draftOf(group: ServerPlayerTimers): Draft {
  const textOf = (value: number | null): string => (value === null ? '' : String(value));

  return {
    smelt: textOf(group.smelt),
    craft: textOf(group.craft),
    research: textOf(group.research),
    recycle: textOf(group.recycle),
  };
}

/**
 * O que o grupo `normal` decide — de onde os VIPs herdam o que deixam
 * em branco. Desligado ou órfão não conta: não vai para o jogo.
 */
function baseOf(groups: readonly ServerPlayerTimers[]): Partial<Record<TimerKey, number>> {
  const normal = groups.find(
    (group) => group.tier === NORMAL_TIER && group.enabled && group.exists !== false,
  );

  const base: Partial<Record<TimerKey, number>> = {};

  if (normal === undefined) {
    return base;
  }

  for (const timer of TIMERS) {
    const value = normal[timer.key];

    if (value !== null) {
      base[timer.key] = value;
    }
  }

  return base;
}

/** O que vale naquela célula. Ver `Resolved`. */
function resolve(
  tier: string | null,
  own: number | null,
  inherited: number | undefined,
): Resolved {
  if (own !== null) {
    return { kind: 'own', speed: own };
  }

  if (tier === null) {
    return { kind: 'unused' };
  }

  if (tier === ADMIN_TIER) {
    return { kind: 'follows' };
  }

  if (tier !== NORMAL_TIER && inherited !== undefined) {
    return { kind: 'inherited', speed: inherited };
  }

  return { kind: 'game' };
}

function speedOf(resolved: Resolved): number {
  return resolved.kind === 'own' || resolved.kind === 'inherited' ? resolved.speed : LIMITS.min;
}

/** A frase curta embaixo do número. */
function captionOf(resolved: Resolved): string {
  switch (resolved.kind) {
    case 'own':
      return timeShare(resolved.speed);
    case 'inherited':
      return 'herda do normal';
    case 'game':
      return 'o tempo do Rust';
    case 'follows':
      return 'segue o nível do jogador';
    case 'unused':
      return 'não vale no jogo';
  }
}

/** O rótulo do botão "em branco", que muda de sentido com o nível. */
function blankLabelOf(tier: string | null): string {
  if (tier === ADMIN_TIER) {
    return 'Segue o nível';
  }

  return tier === NORMAL_TIER || tier === null ? '×1 · jogo' : 'Herda';
}

/** A barra de velocidade. Âmbar quando o grupo decide; apagada quando herda. */
function SpeedBar({ resolved, className }: { readonly resolved: Resolved; readonly className?: string }) {
  return (
    <div aria-hidden="true" className={cn('h-1 w-full bg-surface-2', className)}>
      <div
        className={cn(
          'h-full transition-[width] duration-200 motion-reduce:transition-none',
          resolved.kind === 'own' ? 'bg-amber' : 'bg-muted/40',
        )}
        style={{ width: `${String(Math.round(barShare(speedOf(resolved)) * 100))}%` }}
      />
    </div>
  );
}

/** Uma célula da grade: o número, a barra e a frase. */
function SpeedCell({ resolved }: { readonly resolved: Resolved }) {
  const strong = resolved.kind === 'own';
  const blank = resolved.kind === 'follows' || resolved.kind === 'unused';

  return (
    <div className="min-w-0">
      <p
        className={cn(
          'font-condensed text-lg font-bold leading-none tabular-nums',
          strong ? 'text-foreground' : 'text-muted',
        )}
      >
        {blank ? EM_DASH : formatSpeed(speedOf(resolved))}
      </p>

      <SpeedBar resolved={resolved} className="mt-1.5 max-w-32" />

      <p className="mt-1 truncate text-2xs text-muted">{captionOf(resolved)}</p>
    </div>
  );
}

/** O nível do grupo, numa etiqueta. */
function TierBadge({ tier }: { readonly tier: string | null }) {
  return (
    <span
      className={cn(
        'shrink-0 border px-1.5 font-condensed text-2xs font-bold uppercase leading-4 tracking-wide',
        tier === null && 'border-border text-muted',
        tier === NORMAL_TIER && 'border-border text-foreground',
        tier === ADMIN_TIER && 'border-rust text-foreground',
        tier !== null && tier !== NORMAL_TIER && tier !== ADMIN_TIER && 'border-amber/60 text-amber',
      )}
    >
      {tier ?? 'sem nível'}
    </span>
  );
}

/**
 * O nome de um timer com o `(?)` ao lado.
 *
 * ####  O ESTILO FICA NO NOME, E NÃO NA LINHA  ####
 *
 * O HelpTip desenha um `<dialog>`, e o texto longo HERDA o CSS de quem
 * o contém no DOM. Com o `uppercase font-condensed font-bold` na linha
 * inteira, o modal saía todo em maiúsculas e negrito condensado —
 * visto no navegador em 11/09/2026. E `<p>` em volta seria pior:
 * `<dialog>` dentro de `<p>` é HTML inválido, e o React acusa.
 */
function TimerLabel({ timer, className }: { readonly timer: TimerMeta; readonly className: string }) {
  const Icon = timer.icon;

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          'flex items-center gap-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
          className,
        )}
      >
        <Icon aria-hidden="true" className="h-3.5 w-3.5 text-rust" />
        {timer.label}
      </span>
      <HelpTip topic={timer.help} />
    </div>
  );
}

/** Um atalho do editor. */
function Chip({
  selected,
  disabled,
  onClick,
  children,
}: {
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-7 border px-2 font-condensed text-2xs font-bold uppercase tracking-wide transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-amber bg-amber text-background'
          : 'border-border bg-surface-2 text-foreground hover:border-muted',
      )}
    >
      {children}
    </button>
  );
}

/** O cartão de UM timer, dentro do editor. */
function TimerEditor({
  timer,
  tier,
  value,
  inherited,
  busy,
  onChange,
}: {
  readonly timer: TimerMeta;
  readonly tier: string | null;
  readonly value: string;
  readonly inherited: number | undefined;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
}) {
  const parsed = parseSpeed(value, timer.label);
  const invalid = typeof parsed === 'string';
  const resolved = resolve(tier, invalid ? null : parsed, inherited);
  const speed = speedOf(resolved);

  return (
    <div className={cn('border bg-surface p-3', invalid ? 'border-amber' : 'border-border')}>
      <TimerLabel timer={timer} className="text-foreground" />

      <div className="mt-3 flex items-end justify-between gap-3">
        <p
          className={cn(
            'font-condensed text-3xl font-bold leading-none tabular-nums',
            resolved.kind === 'own' ? 'text-foreground' : 'text-muted',
          )}
        >
          {resolved.kind === 'follows' || resolved.kind === 'unused'
            ? EM_DASH
            : formatSpeed(speed)}
        </p>

        <p className="text-right text-2xs leading-snug text-muted">
          {resolved.kind === 'own' || resolved.kind === 'inherited' ? (
            <>
              {resolved.kind === 'inherited' ? 'herda do normal' : timeShare(speed)}
              <br />1 min → {oneMinuteAt(speed)}
            </>
          ) : (
            captionOf(resolved)
          )}
        </p>
      </div>

      <SpeedBar resolved={resolved} className="mt-2 h-1.5" />

      <div className="mt-3 flex flex-wrap gap-1">
        <Chip selected={value.trim() === ''} disabled={busy} onClick={() => onChange('')}>
          {blankLabelOf(tier)}
        </Chip>

        {PRESETS.map((preset) => (
          <Chip
            key={preset}
            selected={parsed === preset}
            disabled={busy}
            onClick={() => onChange(String(preset))}
          >
            {formatSpeed(preset)}
          </Chip>
        ))}
      </div>

      <label className="mt-2 flex items-center gap-2 text-2xs text-muted">
        outro valor
        <Input
          inputMode="decimal"
          name={`timer-${timer.key}`}
          aria-label={`${timer.label}: velocidade`}
          value={value}
          disabled={busy}
          placeholder={`${String(LIMITS.min)} a ${String(LIMITS.max)}`}
          onChange={(event) => onChange(event.target.value)}
          className="h-7 w-24 font-mono text-xs"
        />
      </label>

      {invalid && <p className="mt-2 text-2xs leading-relaxed text-amber">{parsed}</p>}
    </div>
  );
}

/** A escada de quem decide, no topo da tela. */
function HierarchyChain() {
  const steps = ['admin', 'VIP', 'normal', '×1 do jogo'];

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-2xs">
      <span className="font-condensed uppercase tracking-wide text-muted">Quem decide</span>

      {steps.map((step, index) => (
        <Fragment key={step}>
          {index > 0 && <ChevronRight aria-hidden="true" className="h-3 w-3 text-muted" />}
          <span className="border border-border bg-surface-2 px-1.5 font-condensed font-bold uppercase leading-4 tracking-wide">
            {step}
          </span>
        </Fragment>
      ))}

      <span className="text-muted">— em branco, o grupo passa a vez para o seguinte.</span>
      <HelpTip topic={TIMERS_HELP.nivel} />
    </div>
  );
}

export function TimersPanel({ serverId }: { readonly serverId: string }) {
  const [groups, setGroups] = useState<ServerPlayerTimers[] | null>(null);
  const [connected, setConnected] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [levelsProblem, setLevelsProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Qual grupo está aberto para edição. `null` = nenhum. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftEnabled, setDraftEnabled] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await agent.playerTimers(serverId);

      setGroups(response.groups);
      setConnected(response.connected);
      setMessage(response.message ?? null);
      setLevelsProblem(response.levelsProblem);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const base = useMemo(() => baseOf(groups ?? []), [groups]);

  function open(group: ServerPlayerTimers): void {
    setEditing(group.name);
    setDraft(draftOf(group));
    setDraftEnabled(group.enabled);
  }

  async function save(group: string): Promise<void> {
    const values: Record<TimerKey, number | null> = {
      smelt: null,
      craft: null,
      research: null,
      recycle: null,
    };

    for (const timer of TIMERS) {
      const parsed = parseSpeed(draft[timer.key], timer.label);

      if (typeof parsed === 'string') {
        toast.error('Confira os valores', { description: parsed });
        return;
      }

      values[timer.key] = parsed;
    }

    // Os quatro em branco não são configuração: são a ausência dela.
    // O agente recusa com a mesma frase.
    if (TIMERS.every((timer) => values[timer.key] === null)) {
      toast.error('Nada para gravar', {
        description:
          'Os quatro timers estão em branco (ou em ×1), que é o mesmo que o grupo não decidir ' +
          'nada. Escolha algum, ou apague os timers deste grupo.',
      });
      return;
    }

    setBusy(true);

    try {
      const response = await agent.savePlayerTimers(serverId, group, {
        ...values,
        enabled: draftEnabled,
      });

      toast.success('Timers gravados', { description: response.message });
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
      const response = await agent.removePlayerTimers(serverId, group);

      toast.success('Timers apagados', { description: response.message });
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
      const response = await agent.syncPlayerTimers(serverId);

      toast.success('Estado empurrado', { description: response.message });
    } catch (cause) {
      toast.error('Não consegui empurrar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border border-border bg-surface px-3 py-2.5">
        <div className="max-w-4xl space-y-2">
          <p className="text-2xs leading-relaxed text-muted">
            Quão <strong>rápido</strong> as coisas andam para quem está em cada grupo:{' '}
            <strong>×2 é duas vezes mais rápido</strong>, metade do tempo. Vai de ×1, que é o
            Rust, a ×{String(LIMITS.max)}.
          </p>

          <HierarchyChain />
        </div>

        <Button variant="outline" size="sm" disabled={busy} onClick={() => void sync()}>
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          Reempurrar agora
        </Button>
      </div>

      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler os timers" detail={error} />
      )}

      {message !== null && (
        <StateBlock
          variant={connected ? 'empty' : 'offline'}
          title={connected ? 'Atenção' : 'Servidor fora do ar'}
          detail={message}
        />
      )}

      {levelsProblem !== null && (
        <StateBlock
          variant="empty"
          title="Os níveis de VIP deste servidor não foram lidos"
          detail={
            <>
              {levelsProblem} Sem eles, os grupos de VIP aparecem <strong>sem nível</strong> — e os
              timers deles não chegam a quem tem VIP.
            </>
          }
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

      {groups !== null && groups.length > 0 && (
        <div className="border border-border bg-surface">
          <div
            className={cn(
              'hidden items-center gap-x-4 border-b border-border px-3 py-2 md:grid',
              GRID,
            )}
          >
            <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Grupo
            </span>

            {TIMERS.map((timer) => (
              <TimerLabel key={timer.key} timer={timer} className="text-muted" />
            ))}

            <span />
          </div>

          {groups.map((group) => {
            const configured = TIMERS.some((timer) => group[timer.key] !== null);
            const isOpen = editing === group.name;
            const live = group.enabled && group.exists !== false && group.tier !== null;

            return (
              <div key={group.name} className="border-b border-border last:border-b-0">
                <div
                  className={cn(
                    'grid grid-cols-2 items-center gap-x-4 gap-y-3 px-3 py-3',
                    GRID,
                    isOpen && 'bg-surface-2/40',
                  )}
                >
                  <div className="col-span-2 min-w-0 md:col-span-1">
                    <p className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-5 w-[3px] shrink-0',
                          configured && live ? 'bg-rust' : 'bg-border',
                        )}
                      />
                      <span className="truncate font-mono text-sm">{group.name}</span>
                      <TierBadge tier={group.tier} />
                    </p>

                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-[11px] text-2xs text-muted">
                      {group.members !== null && (
                        <span className="inline-flex items-center gap-1">
                          <Users aria-hidden="true" className="h-3 w-3" />
                          {formatInteger(group.members)} dentro
                        </span>
                      )}

                      <span>
                        {group.updatedAt === null
                          ? 'sem timers'
                          : `alterado ${formatWhen(group.updatedAt)}`}
                        {group.updatedBy === null ? '' : ` por ${group.updatedBy}`}
                      </span>

                      {!group.enabled && (
                        <span className="text-amber">desligado — não vai para o jogo</span>
                      )}

                      {group.exists === false && (
                        <span className="text-amber">o grupo não existe mais no Oxide</span>
                      )}
                    </p>
                  </div>

                  {TIMERS.map((timer) => {
                    const Icon = timer.icon;

                    return (
                      <div
                        key={timer.key}
                        className={cn('min-w-0', !live && configured && 'opacity-60')}
                      >
                        {/* No celular não há cabeçalho de coluna: o nome
                            do timer vem junto da célula. */}
                        <p className="mb-1 flex items-center gap-1 font-condensed text-2xs uppercase tracking-wide text-muted md:hidden">
                          <Icon aria-hidden="true" className="h-3 w-3 text-rust" />
                          {timer.label}
                        </p>

                        <SpeedCell
                          resolved={resolve(group.tier, group[timer.key], base[timer.key])}
                        />
                      </div>
                    );
                  })}

                  <div className="col-span-2 flex justify-end md:col-span-1">
                    <Button
                      variant={isOpen ? 'outline' : configured ? 'outline' : 'primary'}
                      size="sm"
                      disabled={busy}
                      onClick={() => (isOpen ? setEditing(null) : open(group))}
                    >
                      {isOpen ? 'Fechar' : configured ? 'Editar' : 'Configurar'}
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <div className="space-y-3 border-t border-border bg-background/40 p-3">
                    {group.tier === null && (
                      <p className="border-l-2 border-amber bg-surface-2 px-3 py-2 text-2xs leading-relaxed">
                        <strong>{group.name}</strong> não é nível nenhum: o plugin só pergunta por
                        admin, pelos VIPs e pelo normal. Dá para gravar — e nada muda no jogo até o
                        grupo virar um nível.
                      </p>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {TIMERS.map((timer) => (
                        <TimerEditor
                          key={timer.key}
                          timer={timer}
                          tier={group.tier}
                          value={draft[timer.key]}
                          inherited={base[timer.key]}
                          busy={busy}
                          onChange={(value) => setDraft({ ...draft, [timer.key]: value })}
                        />
                      ))}
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
                          Desligado, os timers continuam guardados aqui e{' '}
                          <strong>não vão para o jogo</strong>.
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
                            hint={`Quem é de "${group.name}" passa a seguir o nível de baixo.`}
                            onConfirm={() => void remove(group.name)}
                          />
                        )}

                        <Button
                          variant="primary"
                          disabled={busy}
                          onClick={() => void save(group.name)}
                        >
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
      )}
    </div>
  );
}
