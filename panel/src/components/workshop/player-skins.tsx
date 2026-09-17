'use client';

// ============================================================
//  player-skins.tsx  -  a aba Skins da ficha do jogador.
//
//  Docs/OrigemZWorkshop/02 §9. No molde da aba VIP: o que ele tem
//  AGORA, o formulário de dar, e o que já aconteceu.
//
//  ####  VIVA E VENCIDA, SEPARADAS  ####
//
//  "Ele tem a AK?" se responde pela lista viva. A vencida fica
//  embaixo, apagada, porque é a resposta de "eu tinha e sumiu" —
//  misturá-las faria uma posse vencida parecer valendo.
//
//  ####  MORA AQUI, E NÃO NA PÁGINA DA FICHA  ####
//
//  Ela usa as peças da aba Posse (owned-parts.tsx) e o Registro do
//  /workshop; a página da ficha já passa de mil linhas e só a monta.
//
//  Toda resposta passa pelo `safeX` (normalize.ts): campo ausente
//  vira TypeError no render e derruba a página.
// ============================================================

import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { AuditPanel } from '@/components/workshop/audit-panel';
import {
  describeOwnedExpiry,
  messageOf,
  OWNED_SOURCE_LABELS,
  safeOwned,
  safeOwnedList,
  safeSkin,
} from '@/components/workshop/normalize';
import {
  expiryBody,
  ExpiryPicker,
  NoteField,
  OwnedErrorBox,
  OwnedSkinCell,
  PERMANENT,
  SkinCatalogPicker,
  type ExpiryValue,
} from '@/components/workshop/owned-parts';
import type { WorkshopServerOption } from '@/components/workshop/server-picker';
import { agent, ApiError, type WorkshopOwned, type WorkshopSkin } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface PlayerSkinsProps {
  readonly steamId: string;
  /** Para o Registro dar nome ao servidor. */
  readonly servers: readonly WorkshopServerOption[];
}

export function PlayerSkins({ steamId, servers }: PlayerSkinsProps) {
  const [live, setLive] = useState<WorkshopOwned[] | null>(null);
  const [expired, setExpired] = useState<WorkshopOwned[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Muda a cada escrita: remonta o Registro para ele reler. */
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    try {
      const response = await agent.playerSkins(steamId);

      setLive(safeOwnedList(response.live));
      setExpired(safeOwnedList(response.expired));
      setError(null);
    } catch (cause) {
      setLive((current) => current ?? []);
      setError(messageOf(cause));
    }
  }, [steamId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changed(): Promise<void> {
    await load();
    setRevision((value) => value + 1);
  }

  async function revoke(owned: WorkshopOwned): Promise<void> {
    setBusy(true);

    try {
      await agent.revokeWorkshopOwned(owned.id);
      toast.success('Skin tirada', {
        description: `${owned.skin?.label ?? `skin #${String(owned.skinId)}`}. O que já foi pintado continua pintado.`,
      });
      await changed();
    } catch (cause) {
      toast.error('Não consegui tirar', { description: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  const liveIds = useMemo(() => new Set((live ?? []).map((owned) => owned.skinId)), [live]);

  return (
    <div className="space-y-4">
      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler as skins deste jogador" detail={error} />
      )}

      {live === null && error === null && <StateBlock variant="loading" title="Lendo…" />}

      {live !== null && (
        <Block title="O que ele tem">
          {live.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">
              Este jogador não tem skin nenhuma. Ele ainda aplica as liberadas para todos.
            </p>
          ) : (
            <OwnedRows rows={live} busy={busy} onRevoke={(owned) => void revoke(owned)} />
          )}
        </Block>
      )}

      {expired.length > 0 && (
        <Block title="Vencidas">
          <OwnedRows rows={expired} busy={busy} onRevoke={(owned) => void revoke(owned)} />
        </Block>
      )}

      <GiveSkin steamId={steamId} liveIds={liveIds} onGranted={changed} />

      <Block title="Histórico">
        <div className="p-3">
          <AuditPanel key={revision} servers={servers} fixedSteamId={steamId} />
        </div>
      </Block>
    </div>
  );
}

function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
        <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
          <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
          {title}
        </h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

function OwnedRows({
  rows,
  busy,
  onRevoke,
}: {
  readonly rows: readonly WorkshopOwned[];
  readonly busy: boolean;
  readonly onRevoke: (owned: WorkshopOwned) => void;
}) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((owned) => (
        <li
          key={owned.id}
          className={cn(
            'flex flex-wrap items-center justify-between gap-3 px-4 py-3',
            owned.expired && 'opacity-60',
          )}
        >
          <div className="min-w-0 space-y-1">
            <OwnedSkinCell owned={owned} />
            <p className="text-2xs text-muted">
              <span className={cn(!owned.expired && owned.expiresAt === null && 'text-olive')}>
                {describeOwnedExpiry(owned)}
              </span>
              {' · '}
              {OWNED_SOURCE_LABELS[owned.source]}
              {owned.sourceRef === null ? '' : ` (${owned.sourceRef})`}
              {owned.createdBy === '' ? '' : ` · por ${owned.createdBy}`}
              {owned.note === null ? '' : ` · “${owned.note}”`}
            </p>
          </div>

          <ConfirmButton
            variant="danger"
            disabled={busy}
            icon={null}
            label="Remover"
            confirmLabel="Remover mesmo"
            hint="Ele deixa de poder aplicar esta skin. O que já foi pintado continua pintado."
            onConfirm={() => onRevoke(owned)}
          />
        </li>
      ))}
    </ul>
  );
}

function GiveSkin({
  steamId,
  liveIds,
  onGranted,
}: {
  readonly steamId: string;
  readonly liveIds: ReadonlySet<number>;
  readonly onGranted: () => Promise<void>;
}) {
  const [skins, setSkins] = useState<readonly WorkshopSkin[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [skinId, setSkinId] = useState<number | null>(null);
  const [expiry, setExpiry] = useState<ExpiryValue>(PERMANENT);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.workshopSkins();

        if (alive) setSkins((Array.isArray(response.skins) ? response.skins : []).map(safeSkin));
      } catch (cause) {
        if (alive) {
          setSkins([]);
          setCatalogError(messageOf(cause));
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const { problem: expiryProblem, body } = expiryBody(expiry);
  const problem = skinId === null ? 'Escolha a skin.' : expiryProblem;
  const renewing = skinId !== null && liveIds.has(skinId);

  async function submit(): Promise<void> {
    if (skinId === null) return;

    setBusy(true);
    setError(null);

    try {
      const trimmed = note.trim();
      const response = await agent.grantWorkshopOwned({
        steamId,
        skinId,
        ...body,
        ...(trimmed === '' ? {} : { note: trimmed }),
      });
      const owned = response.owned === undefined ? null : safeOwned(response.owned);

      toast.success(response.created === false ? 'Prazo renovado' : 'Skin dada', {
        ...(owned === null
          ? {}
          : { description: `${owned.skin?.label ?? ''} · ${describeOwnedExpiry(owned)}` }),
      });
      setSkinId(null);
      setNote('');
      await onGranted();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError('', messageOf(cause), 0));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Block title="Dar skin">
      <div className="space-y-3 p-4">
        {catalogError !== null && (
          <StateBlock variant="error" title="Não consegui ler o catálogo" detail={catalogError} />
        )}

        {skins === null ? (
          <StateBlock variant="loading" title="Lendo o catálogo…" />
        ) : (
          <SkinCatalogPicker
            skins={skins}
            multiple={false}
            selected={skinId === null ? [] : [skinId]}
            ownedIds={liveIds}
            onChange={(ids) => setSkinId(ids[0] ?? null)}
          />
        )}

        <ExpiryPicker value={expiry} onChange={setExpiry} />
        <NoteField value={note} onChange={setNote} />

        {renewing && (
          <p className="border-l-2 border-amber pl-2 text-2xs leading-relaxed text-amber">
            Ele já tem esta skin. Dar de novo <strong>soma</strong> o prazo escolhido ao que sobra —
            ou mantém o permanente.
          </p>
        )}

        <OwnedErrorBox error={error} title="Não consegui dar a skin" />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="text-2xs text-muted">{problem}</p>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || problem !== null}
            onClick={() => void submit()}
          >
            {busy && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
            {renewing ? 'Renovar' : 'Dar'}
          </Button>
        </div>
      </div>
    </Block>
  );
}
