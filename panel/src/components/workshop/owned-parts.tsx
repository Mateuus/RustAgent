'use client';

// ============================================================
//  owned-parts.tsx  -  as peças da POSSE, usadas em dois lugares.
//
//  ####  POR QUE UM ARQUIVO À PARTE  ####
//
//  A posse aparece na aba Posse de /workshop e na aba Skins da
//  ficha do jogador. As duas escolhem skin do catálogo, escolhem
//  prazo e mostram a mesma recusa do agente — e duas cópias do
//  seletor de prazo divergiriam na primeira opção nova.
//
//  ####  NENHUMA DELAS FALA COM A API  ####
//
//  Quem chama o agente é quem as monta. Aqui só há desenho e a
//  tradução do formulário para o corpo do `POST /workshop/owned`.
// ============================================================

import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { Input } from '@/components/ui/input';
import {
  groupByShortname,
  RARITY_LABELS,
  RARITY_TONES,
} from '@/components/workshop/normalize';
import {
  agent,
  type ApiError,
  type WorkshopOwned,
  type WorkshopOwnedGrantInput,
  type WorkshopRarity,
  type WorkshopSkin,
} from '@/lib/api';
import { cn } from '@/lib/utils';

// ------------------------------------------------------------
//  DESENHO
// ------------------------------------------------------------

/** A raridade em uma etiqueta. Sem raridade, nada. */
export function RarityBadge({ rarity }: { readonly rarity: WorkshopRarity | null }) {
  if (rarity === null) return null;

  return (
    <span
      className={cn(
        'border px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide',
        RARITY_TONES[rarity],
      )}
    >
      {RARITY_LABELS[rarity]}
    </span>
  );
}

/** A arte do Workshop quando a Steam deu a prévia; senão, o item base. */
export function SkinThumb({
  previewUrl,
  shortname,
  large = false,
}: {
  readonly previewUrl: string | null;
  readonly shortname: string;
  /** 48 px nos dois casos (arte e item base), para a lista de posse. */
  readonly large?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  if (previewUrl === null || failed) {
    return <ItemIcon shortname={shortname} size={large ? 'xl' : 'md'} />;
  }

  return (
    // O <img> cru: a imagem vem da Steam, e o export estático não
    // tem otimizador.
    <img
      src={previewUrl}
      alt=""
      loading="lazy"
      className={cn(
        'shrink-0 border border-border object-cover',
        large ? 'h-12 w-12' : 'h-10 w-10',
      )}
      onError={() => setFailed(true)}
    />
  );
}

/** A skin de uma posse, com o que houver dela. */
export function OwnedSkinCell({ owned }: { readonly owned: WorkshopOwned }) {
  const skin = owned.skin;

  if (skin === null) {
    return <span className="text-2xs text-muted">skin #{owned.skinId} (apagada)</span>;
  }

  return (
    <span className="flex items-center gap-2">
      <SkinThumb previewUrl={skin.previewUrl} shortname={skin.shortname} />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-foreground">{skin.label}</span>
          <RarityBadge rarity={skin.rarity} />
          {!skin.enabled && <span className="text-2xs text-muted">desligada</span>}
        </span>
        <span className="block font-mono text-2xs text-muted">{skin.shortname}</span>
      </span>
    </span>
  );
}

/** O que fazer com cada recusa das rotas de posse. */
function ownedWayOut(code: string): string | null {
  switch (code) {
    case 'OWNED_ALREADY_EXPIRED':
      return 'Escolha uma data no futuro, ou "Permanente".';

    case 'WORKSHOP_SKIN_NOT_FOUND':
      return 'A skin foi apagada do catálogo enquanto a tela estava aberta. Recarregue a página.';

    case 'OWNED_NOT_FOUND':
      return 'Essa posse já não existe — alguém a tirou antes, ou a skin foi apagada.';

    case 'INVALID_STEAM_ID':
      return 'SteamID64 tem 17 dígitos e começa com 7656.';

    default:
      return null;
  }
}

/** A recusa do agente, com a saída escrita embaixo. Fica até a próxima tentativa. */
export function OwnedErrorBox({
  error,
  title,
}: {
  readonly error: ApiError | null;
  readonly title: string;
}) {
  if (error === null) return null;

  const wayOut = ownedWayOut(error.code);

  return (
    <div role="alert" className="border border-rust bg-surface-2 p-3">
      <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-rust">
        {/* Sem código é porque nem chegou ao agente. */}
        {error.code === '' ? title : `O agente recusou (${error.code})`}
      </p>
      <p className="mt-1 text-2xs leading-relaxed text-foreground">{error.message}</p>
      {wayOut !== null && (
        <p className="mt-2 border-l-2 border-amber pl-2 text-2xs leading-relaxed text-muted">
          {wayOut}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  PRAZO
// ------------------------------------------------------------

export type Duration = 'permanent' | '1' | '7' | '30' | '90' | 'custom';

const DURATIONS: readonly { id: Duration; label: string }[] = [
  { id: 'permanent', label: 'Permanente' },
  { id: '1', label: '1 dia' },
  { id: '7', label: '7 dias' },
  { id: '30', label: '30 dias' },
  { id: '90', label: '90 dias' },
  { id: 'custom', label: 'Até uma data…' },
];

export interface ExpiryValue {
  readonly duration: Duration;
  /** O valor do `datetime-local`, hora local. */
  readonly customDate: string;
}

export const PERMANENT: ExpiryValue = { duration: 'permanent', customDate: '' };

/**
 * O prazo, na forma do corpo do `POST /workshop/owned`.
 *
 * `days` e `expiresAt` são exclusivos no agente. Os dias vão como
 * DIAS, e não como data calculada aqui: dar de novo a quem já tem
 * SOMA ao prazo vivo, e só o agente sabe quanto sobra.
 *
 * @returns `problem` quando o formulário ainda não pode ir.
 */
export function expiryBody(value: ExpiryValue): {
  readonly problem: string | null;
  readonly body: Pick<WorkshopOwnedGrantInput, 'days' | 'expiresAt'>;
} {
  if (value.duration === 'permanent') return { problem: null, body: {} };

  if (value.duration !== 'custom') return { problem: null, body: { days: Number(value.duration) } };

  const time = value.customDate === '' ? Number.NaN : new Date(value.customDate).getTime();

  if (Number.isNaN(time)) return { problem: 'Escolha a data de vencimento.', body: {} };
  if (time <= Date.now()) return { problem: 'A data escolhida já passou.', body: {} };

  return { problem: null, body: { expiresAt: new Date(time).toISOString() } };
}

export function ExpiryPicker({
  value,
  onChange,
}: {
  readonly value: ExpiryValue;
  readonly onChange: (value: ExpiryValue) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Prazo</span>
        <select
          value={value.duration}
          onChange={(event) => onChange({ ...value, duration: event.target.value as Duration })}
          className="mt-1 h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground hover:border-muted"
        >
          {DURATIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {value.duration === 'custom' && (
        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            Vence em (hora local)
          </span>
          <Input
            type="datetime-local"
            value={value.customDate}
            className="mt-1 h-9"
            onChange={(event) => onChange({ ...value, customDate: event.target.value })}
          />
        </label>
      )}
    </div>
  );
}

export function NoteField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
        Nota (opcional)
      </span>
      <Input
        value={value}
        maxLength={200}
        placeholder="vencedor do evento de sábado"
        className="mt-1 h-9"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

// ------------------------------------------------------------
//  ESCOLHER SKIN NO CATÁLOGO
// ------------------------------------------------------------

/**
 * A busca no catálogo, com uma ou várias escolhas.
 *
 * Lista, e não `<select>`: o catálogo cresce para dezenas de skins
 * por item, e a pergunta chega pelo NOME da skin ("a AK Brasa").
 */
export function SkinCatalogPicker({
  skins,
  selected,
  multiple,
  onChange,
  ownedIds,
}: {
  readonly skins: readonly WorkshopSkin[];
  readonly selected: readonly number[];
  readonly multiple: boolean;
  readonly onChange: (ids: number[]) => void;
  /** As que ele já tem viva — marcadas como renovação. */
  readonly ownedIds?: ReadonlySet<number>;
}) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching =
      needle === ''
        ? skins
        : skins.filter(
            (skin) =>
              skin.label.toLowerCase().includes(needle) ||
              skin.shortname.includes(needle) ||
              skin.skinId.includes(needle),
          );

    return groupByShortname(matching);
  }, [skins, query]);

  function toggle(id: number): void {
    if (!multiple) {
      onChange(selected.includes(id) ? [] : [id]);
      return;
    }

    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
        />
        <Input
          value={query}
          placeholder="Buscar skin por nome, item ou Workshop ID"
          aria-label="Buscar skin no catálogo"
          className="pl-7"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {skins.length === 0 ? (
        <p className="text-2xs text-muted">O catálogo está vazio: cadastre skins na aba Skins.</p>
      ) : groups.length === 0 ? (
        <p className="text-2xs text-muted">Nenhuma skin casa com a busca.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto border border-border">
          {groups.map((group) => (
            <li key={group.shortname}>
              <p className="flex items-center gap-2 bg-surface-2 px-2 py-1 font-mono text-2xs text-muted">
                <ItemIcon shortname={group.shortname} size="sm" />
                {group.shortname}
              </p>
              <ul>
                {group.skins.map((skin) => {
                  const active = selected.includes(skin.id);

                  return (
                    <li key={skin.id}>
                      <button
                        type="button"
                        role={multiple ? 'checkbox' : 'radio'}
                        aria-checked={active}
                        onClick={() => toggle(skin.id)}
                        className={cn(
                          'flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-2',
                          active && 'bg-olive/10',
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'h-3 w-3 shrink-0 border',
                            multiple ? '' : 'rounded-full',
                            active ? 'border-olive bg-olive' : 'border-muted',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {skin.label}
                        </span>
                        <RarityBadge rarity={skin.rarity} />
                        {skin.openToAll && (
                          <span className="text-2xs text-muted" title="Qualquer jogador já aplica">
                            para todos
                          </span>
                        )}
                        {!skin.enabled && <span className="text-2xs text-muted">desligada</span>}
                        {ownedIds?.has(skin.id) === true && (
                          <span className="text-2xs text-amber">já tem</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  JOGADORES
// ------------------------------------------------------------

/** Um jogador da busca, com padrão em cada campo. */
export interface PlayerHit {
  readonly steamId: string;
  readonly name: string;
  readonly online: boolean;
}

export async function searchPlayers(query: string): Promise<PlayerHit[]> {
  const response = await agent.networkPlayers({ query, limit: 20, offset: 0 });

  return (Array.isArray(response.players) ? response.players : [])
    .map((player) => ({
      steamId: String(player.steamId ?? ''),
      name: typeof player.name === 'string' ? player.name : '',
      online: player.online === true,
    }))
    .filter((player) => player.steamId !== '');
}

// ------------------------------------------------------------
//  LOTE
// ------------------------------------------------------------

export interface BatchOutcome {
  readonly done: number;
  /** Uma frase por falha: "76561… — a frase do agente". */
  readonly failures: string[];
}

/**
 * Roda um pedido por item, UM DE CADA VEZ.
 *
 * Em sequência de propósito: cada posse dada reenvia a carga do
 * jogador ao servidor, e cinquenta de uma vez disputariam o RCON.
 * Uma falha não para o lote — ela entra na lista.
 */
export async function runBatch<T>(
  items: readonly T[],
  label: (item: T) => string,
  run: (item: T) => Promise<unknown>,
): Promise<BatchOutcome> {
  let done = 0;
  const failures: string[] = [];

  for (const item of items) {
    try {
      await run(item);
      done += 1;
    } catch (cause) {
      failures.push(`${label(item)} — ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return { done, failures };
}
