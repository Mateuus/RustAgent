'use client';

// ============================================================
//  skin-form.tsx  -  o cadastro de uma skin do Workshop.
//
//  ####  UM SÓ, PARA CRIAR E PARA EDITAR  ####
//
//  Criar e editar uma skin são a MESMA pergunta — "qual item, qual
//  arte, e como ela aparece no menu?" —, e a única diferença é de onde vêm os
//  valores iniciais. Dois formulários divergiriam no primeiro campo
//  novo.
//
//  ####  O WORKSHOP ID VEM PRIMEIRO  ####
//
//  Porque é dele que sai o resto: enquanto o admin digita, a tela
//  pergunta à Steam (pelo pai — ver abaixo) o título, a prévia e as
//  tags. As tags sugerem o item, e o título vira o nome quando o
//  campo Nome fica em branco. É o mesmo que o `/skin add` do jogo
//  faz, e é o que mantém os dois caminhos gravando a mesma linha.
//
//  ####  ELE MORA NUM MODAL  ####
//
//  Quem o abre é o `SkinsPanel`, dentro do `Dialog` do painel — é a
//  caixa que dá o título, o X e o Escape. Por isso aqui não há
//  moldura nem cabeçalho próprio, e o rodapé com Salvar fica preso
//  embaixo enquanto o resto rola.
//
//  ####  ELE NÃO FALA COM A API  ####
//
//  Quem chama o agente é o painel-pai. A consulta à Steam chega aqui
//  como uma função (`onLookup`); este arquivo só decide QUANDO
//  perguntar e joga fora a resposta que chegou atrasada.
//
//  ####  O QUE A RECUSA DO AGENTE PRECISA VIRAR AQUI  ####
//
//  As recusas desta rota têm cada uma uma saída diferente. Um toast
//  que some em cinco segundos não serve — a frase fica no
//  formulário, com o que fazer escrito embaixo.
// ============================================================

import { Loader2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { ItemCombobox } from '@/components/item-combobox';
import { ItemIcon } from '@/components/item-icon';
import {
  messageOf,
  RARITIES,
  RARITY_LABELS,
  safeRarity,
} from '@/components/workshop/normalize';
import { ServerPicker, type WorkshopServerOption } from '@/components/workshop/server-picker';
import { Button } from '@/components/ui/button';
import { HelpTip, type HelpTopic } from '@/components/ui/help-tip';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { WORKSHOP_HELP } from '@/lib/help/workshop';
import type {
  ApiError,
  WorkshopLookup,
  WorkshopSkin,
  WorkshopSkinInput,
} from '@/lib/api';
import { cn } from '@/lib/utils';

export interface SkinFormProps {
  /** Os valores iniciais. */
  readonly value: WorkshopSkinInput;
  /** A skin que está sendo editada, se houver. Ausente = é nova. */
  readonly skin?: WorkshopSkin;
  readonly servers: readonly WorkshopServerOption[];
  readonly busy: boolean;
  /** A última recusa do agente. Fica na tela até o próximo Salvar. */
  readonly error?: ApiError | null;
  /** Pergunta à Steam. Quem chama o agente é o pai. */
  readonly onLookup: (skinId: string, shortname: string) => Promise<WorkshopLookup>;
  readonly onSave: (value: WorkshopSkinInput) => void;
  readonly onCancel: () => void;
}

/** Uma skin que ainda não existe. */
export function blankSkin(): WorkshopSkinInput {
  return {
    label: '',
    shortname: '',
    skinId: '',
    description: null,
    rarity: null,
    sort: 0,
    openToAll: false,
    hideInStreamer: true,
    enabled: true,
    // "Por padrão a skin NÃO é removida" (dono, 17/09/2026): a caixa
    // nasce desligada, e é o wipe que decide quando remover.
    season: false,
    servers: [],
  };
}

/** O teto da descrição, o mesmo do agente (`WORKSHOP_DESCRIPTION_MAX`). */
const DESCRIPTION_MAX = 280;
/** O teto da ordem, o mesmo do agente. */
const SORT_LIMIT = 1_000_000;

/** Só pergunta à Steam a partir daqui: id de Workshop tem 9+ dígitos. */
const LOOKUP_MIN_DIGITS = 6;
const LOOKUP_DEBOUNCE_MS = 500;

/**
 * O que fazer com a recusa, por código de contrato.
 *
 * A FRASE do agente já explica o que aconteceu. O que falta é a
 * saída, e é só isso que mora aqui.
 */
function wayOut(code: string): string | null {
  switch (code) {
    case 'UNKNOWN_BASE_ITEM':
      return 'Escolha o item pela lista do campo Item: o shortname é o do jogo, em inglês.';

    case 'DUPLICATE_MARK':
      return (
        'Esse par item + Workshop ID já está no catálogo — talvez cadastrado pelo jogo, com ' +
        '/skin add. Procure pelo número na lista e edite aquela linha.'
      );

    case 'UNKNOWN_SERVER':
      return 'Um dos servidores marcados não existe mais no agente. Desmarque-o e salve de novo.';

    case 'WORKSHOP_NOT_FOUND':
      return (
        'Confira o número no endereço da página da oficina (…/?id=…). Se a arte acabou de ser ' +
        'publicada, ou está privada, a Steam ainda não a mostra.'
      );

    case 'WORKSHOP_WRONG_GAME':
      return 'Esse número é de uma publicação de outro jogo. Use o da arte publicada para o Rust.';

    case 'WORKSHOP_BANNED':
      return 'A Steam tirou essa arte do ar. Ela não desenha no cliente de ninguém.';

    case 'WORKSHOP_OTHER_ITEM':
      return 'As tags da arte apontam outro item. Escolha o item sugerido na prévia do Workshop ID.';

    case 'WORKSHOP_SKIN_NOT_FOUND':
      return 'A skin que você estava editando foi apagada. Feche o formulário e recarregue a lista.';

    default:
      return null;
  }
}

/** A última resposta da Steam, com a pergunta que a gerou. */
interface LookupState {
  readonly key: string;
  readonly result: WorkshopLookup | null;
  readonly failure: string | null;
}

export function SkinForm({
  value,
  skin,
  servers,
  busy,
  error = null,
  onLookup,
  onSave,
  onCancel,
}: SkinFormProps) {
  const [draft, setDraft] = useState<WorkshopSkinInput>(value);
  const [lookup, setLookup] = useState<LookupState | null>(null);

  function patch(change: Partial<WorkshopSkinInput>): void {
    setDraft((current) => ({ ...current, ...change }));
  }

  const skinId = draft.skinId;
  const shortname = draft.shortname.trim();
  const lookupKey = skinId.length >= LOOKUP_MIN_DIGITS ? `${skinId}|${shortname}` : null;

  useEffect(() => {
    if (lookupKey === null) return;

    // `alive` é o que joga fora a resposta atrasada: o id mudou
    // depois de a pergunta sair, e a limpeza deste efeito já rodou.
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await onLookup(skinId, shortname);

          if (!alive) return;

          setLookup({ key: lookupKey, result, failure: null });

          // Item em branco e UMA sugestão só: é ele. Com mais de uma,
          // o admin escolhe pelos botões da prévia.
          const suggested = Array.isArray(result.suggestedShortnames)
            ? result.suggestedShortnames
            : [];

          if (suggested.length === 1 && suggested[0] !== undefined) {
            const only = suggested[0];

            setDraft((current) =>
              current.shortname.trim() === '' ? { ...current, shortname: only } : current,
            );
          }
        } catch (cause) {
          if (alive) setLookup({ key: lookupKey, result: null, failure: messageOf(cause) });
        }
      })();
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [lookupKey, skinId, shortname, onLookup]);

  // Só vale a resposta da pergunta ATUAL. Uma resposta de outro id
  // não aparece, nem por um instante.
  const current = lookup !== null && lookup.key === lookupKey ? lookup : null;
  const looking = lookupKey !== null && current === null;
  const details = current?.result?.details ?? null;
  const workshopTitle = details?.title ?? skin?.workshopTitle ?? null;
  const previewUrl =
    details?.previewUrl ?? (skin !== undefined && skinId === skin.skinId ? skin.previewUrl : null);
  const suggestions = current?.result?.suggestedShortnames ?? [];
  const verdict = current?.result?.verdict ?? null;

  const description = draft.description ?? '';
  const sortText = String(draft.sort);
  const isNew = skin === undefined;
  const problem =
    skinId === ''
      ? 'Falta o Workshop ID da arte publicada.'
      : draft.shortname.trim() === ''
        ? 'Escolha o item do jogo que vai receber a aparência.'
        : isNew && draft.label.trim() === '' && workshopTitle === null && !looking
          ? 'Dê um nome à skin: a Steam não devolveu um título para usar.'
          : description.trim().length > DESCRIPTION_MAX
            ? `A descrição passa de ${String(DESCRIPTION_MAX)} caracteres.`
            : !Number.isInteger(draft.sort) || Math.abs(draft.sort) > SORT_LIMIT
              ? 'A ordem é um número inteiro (pode ser negativo).'
              : null;

  return (
    <div className="space-y-4">
      {skin !== undefined && (
        <p className="flex flex-wrap items-center gap-2 text-2xs text-muted">
          {draft.shortname !== '' && <ItemIcon shortname={draft.shortname} size="sm" />}
          <span>
            {skin.source === 'game' ? 'cadastrada pelo jogo' : 'cadastrada pelo painel'}
            {skin.createdBy === null ? '' : ` · ${skin.createdBy}`}
          </span>
        </p>
      )}

      {/* ---- Workshop ID + prévia ---- */}
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            Workshop ID
          </span>
          <Input
            // `type="text"`, e não `number`: este número passa de 2^53
            // e um campo numérico o devolveria ARREDONDADO.
            type="text"
            inputMode="numeric"
            value={skinId}
            maxLength={20}
            placeholder="3216783927"
            className="mt-1 h-9 font-mono"
            onChange={(event) => patch({ skinId: event.target.value.replace(/\D/g, '') })}
          />
          <span className="mt-1 block text-2xs text-muted">
            O número do endereço da página da oficina (
            <span className="font-mono">…/?id=3216783927</span>). A arte precisa estar{' '}
            <strong>publicada no Steam Workshop</strong>: quem baixa o modelo é o cliente de cada
            jogador.
          </span>
        </label>

        <LookupPreview
          looking={looking}
          failure={current?.failure ?? null}
          lookup={current?.result ?? null}
          title={workshopTitle}
          previewUrl={previewUrl}
          suggestions={suggestions}
          chosen={shortname}
          verdict={verdict}
          onPick={(next) => patch({ shortname: next })}
        />
      </div>

      <div className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          Item do jogo
        </span>
        <div className="mt-1">
          <ItemCombobox
            value={draft.shortname}
            onValueChange={(next) => patch({ shortname: next })}
            placeholder="nome do item (máscara, machado) ou shortname"
          />
        </div>
        <span className="mt-1 block text-2xs text-muted">
          O item que recebe a aparência. Pode haver várias skins para o mesmo item — o jogador
          escolhe no menu de skins.
        </span>
      </div>

      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Nome</span>
        <Input
          value={draft.label}
          maxLength={60}
          placeholder={workshopTitle ?? (isNew ? 'Máscara OrigemZ' : skin.label)}
          className="mt-1 h-9"
          onChange={(event) => patch({ label: event.target.value })}
        />
        <span className="mt-1 block text-2xs text-muted">
          É o que o jogador lê no menu de skins.{' '}
          {isNew
            ? 'Em branco, usa o título publicado no Workshop.'
            : 'Em branco, mantém o nome atual.'}
        </span>
      </label>

      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          Descrição (opcional)
        </span>
        <textarea
          value={description}
          rows={3}
          maxLength={DESCRIPTION_MAX}
          placeholder="Forjada nas brasas do evento de inverno."
          className="mt-1 w-full border border-border bg-surface-2 px-2 py-1.5 text-sm text-foreground hover:border-muted"
          onChange={(event) => patch({ description: event.target.value })}
        />
        <span className="mt-1 flex justify-between gap-2 text-2xs text-muted">
          <span>O texto do painel de detalhe, no menu de skins do jogo.</span>
          <span className="font-mono">
            {description.length}/{DESCRIPTION_MAX}
          </span>
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            Raridade
          </span>
          <select
            value={draft.rarity ?? ''}
            onChange={(event) => patch({ rarity: safeRarity(event.target.value) })}
            className="mt-1 h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground hover:border-muted"
          >
            <option value="">nenhuma</option>
            {RARITIES.map((rarity) => (
              <option key={rarity} value={rarity}>
                {RARITY_LABELS[rarity]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-2xs text-muted">
            A cor da borda e o rótulo no menu. Nenhuma = borda neutra.
          </span>
        </label>

        <label className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Ordem</span>
          <Input
            type="number"
            step={1}
            value={sortText}
            className="mt-1 h-9 font-mono"
            onChange={(event) => {
              const next = event.target.value === '' ? 0 : Number(event.target.value);

              patch({ sort: Number.isFinite(next) ? Math.trunc(next) : 0 });
            }}
          />
          <span className="mt-1 block text-2xs text-muted">
            Na grade do item, menor primeiro; empate pelo nome.
          </span>
        </label>
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          Em quais servidores
        </span>
        <ServerPicker
          value={draft.servers}
          servers={servers}
          onChange={(next) => patch({ servers: next })}
        />
      </div>

      <div className="space-y-3 border-t border-border pt-3">
        <ToggleRow
          title="Liberada para todos (skin da casa)"
          detail="Qualquer jogador pode aplicar, sem possuir. Desligado, só aparece no menu de skins (/skins) de quem a possui — recebida pelo site, pelo painel ou por /skin give — e dos admins."
        >
          <Toggle
            on={draft.openToAll}
            busy={false}
            onChange={(openToAll) => patch({ openToAll })}
            labels={['para todos', 'restrita']}
            label="Esta skin é liberada para todos?"
          />
        </ToggleRow>

        <ToggleRow
          title="Esconder de quem está em modo streamer"
          detail={
            <>
              Ligado, a skin <strong>sai do item</strong> de quem entra no ar escondendo a logo, e{' '}
              <strong>volta</strong> quando ele sai. A proteção é do <strong>portador</strong>: a
              skin viaja no item, e todo mundo que olha o item dele vê a versão normal — mas a logo
              continua aparecendo nos itens dos outros jogadores que ele enxerga.
            </>
          }
        >
          <Toggle
            on={draft.hideInStreamer}
            busy={false}
            onChange={(hideInStreamer) => patch({ hideInStreamer })}
            labels={['esconde', 'mostra']}
            label="Esconder esta skin de quem está em modo streamer?"
          />
        </ToggleRow>

        <ToggleRow
          title="Skin de temporada"
          topic={WORKSHOP_HELP.season}
          detail={
            <>
              Marque quando a skin for de uma temporada. Ela só sai da posse dos jogadores no{' '}
              <strong>wipe em que você escolher “Remover da posse”</strong> — por padrão, nada é
              removido, e uma skin pode atravessar vários wipes.
            </>
          }
        >
          <Toggle
            on={draft.season}
            busy={false}
            onChange={(season) => patch({ season })}
            labels={['de temporada', 'permanente']}
            label="Esta skin é de temporada?"
          />
        </ToggleRow>

        <ToggleRow
          title="Esta skin está valendo?"
          detail="Desligada some do menu, sem perder o cadastro nem a posse de quem a tem. O que já foi pintado continua pintado."
        >
          <Toggle
            on={draft.enabled}
            busy={false}
            onChange={(enabled) => patch({ enabled })}
            labels={['valendo', 'desligada']}
            label="Esta skin está valendo?"
          />
        </ToggleRow>
      </div>

      {error !== null && (
        <div role="alert" className="border border-rust bg-surface-2 p-3">
          <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-rust">
            {/* Sem código é porque nem chegou ao agente. */}
            {error.code === '' ? 'Não consegui gravar' : `O agente recusou (${error.code})`}
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-foreground">{error.message}</p>
          {wayOut(error.code) !== null && (
            <p className="mt-2 border-l-2 border-amber pl-2 text-2xs leading-relaxed text-muted">
              {wayOut(error.code)}
            </p>
          )}
        </div>
      )}

      {/* Preso no fundo da caixa: o formulário é mais alto que a tela,
          e Salvar não pode ficar lá embaixo. O -mx/-mb cobre o
          respiro do Dialog para o conteúdo não aparecer por baixo. */}
      <div className="sticky bottom-0 -mx-3 -mb-3 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface px-3 py-3">
        <p className="text-2xs text-muted">{problem}</p>

        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || problem !== null}
            onClick={() =>
              onSave({
                ...draft,
                // Vazio vai vazio: é o sinal para o agente usar o
                // título do Workshop (ou manter o nome, na edição).
                label: draft.label.trim(),
                shortname: draft.shortname.trim(),
                description: description.trim() === '' ? null : description.trim(),
                servers: [...draft.servers],
              })
            }
          >
            {busy && <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {isNew ? 'Cadastrar' : 'Salvar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Uma linha de interruptor, com o rótulo e o porquê.
 *
 * `topic` põe o `(?)` ao lado do rótulo — o mesmo do resto do painel
 * (ui/help-tip.tsx): passar o mouse mostra a frase curta, clicar abre
 * o texto inteiro. O `detail` continua sendo o que se lê sem clicar
 * em nada.
 */
function ToggleRow({
  title,
  topic,
  detail,
  children,
}: {
  readonly title: string;
  readonly topic?: HelpTopic;
  readonly detail: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="max-w-xl">
        <p className="flex items-center gap-1.5 font-condensed text-2xs uppercase tracking-wide text-muted">
          {title}
          {topic !== undefined && <HelpTip topic={topic} />}
        </p>
        <p className="mt-1 text-2xs leading-relaxed text-muted">{detail}</p>
      </div>
      {children}
    </div>
  );
}

interface LookupPreviewProps {
  readonly looking: boolean;
  readonly failure: string | null;
  readonly lookup: WorkshopLookup | null;
  readonly title: string | null;
  readonly previewUrl: string | null;
  readonly suggestions: readonly string[];
  readonly chosen: string;
  readonly verdict: WorkshopLookup['verdict'];
  readonly onPick: (shortname: string) => void;
}

/** O que a Steam disse do número digitado. */
function LookupPreview({
  looking,
  failure,
  lookup,
  title,
  previewUrl,
  suggestions,
  chosen,
  verdict,
  onPick,
}: LookupPreviewProps) {
  return (
    <div className="flex min-h-24 gap-3 border border-border bg-surface-2 p-2">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center border border-border bg-surface">
        {previewUrl !== null ? (
          // O <img> cru, e não o next/image: a imagem vem da Steam, e
          // o export estático não tem otimizador.
          <img
            src={previewUrl}
            alt=""
            className="h-20 w-20 object-contain"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        ) : chosen !== '' ? (
          <ItemIcon shortname={chosen} size="lg" />
        ) : null}
      </div>

      <div className="min-w-0 space-y-1 text-2xs">
        {looking ? (
          <p className="flex items-center gap-1 text-muted">
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            Perguntando à Steam…
          </p>
        ) : failure !== null ? (
          <p className="text-muted">Não consegui consultar a Steam: {failure}</p>
        ) : lookup === null ? (
          <p className="text-muted">
            {title === null
              ? 'Digite o Workshop ID para ver a arte, o título e o item sugerido.'
              : title}
          </p>
        ) : lookup.status === 'not_found' ? (
          <p className="text-rust">A Steam não encontrou nada publicado com esse número.</p>
        ) : lookup.status === 'unavailable' ? (
          <p className="text-amber">
            A Steam não respondeu agora{lookup.reason === null ? '' : ` (${lookup.reason})`}. Dá
            para salvar mesmo assim — sem título nem prévia.
          </p>
        ) : (
          <>
            <p className="truncate font-medium text-foreground" title={title ?? ''}>
              {title}
            </p>
            {lookup.details !== null && lookup.details.tags.length > 0 && (
              <p className="truncate text-muted">tags: {lookup.details.tags.join(', ')}</p>
            )}
            {suggestions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-muted">item sugerido:</span>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    aria-pressed={suggestion === chosen}
                    onClick={() => onPick(suggestion)}
                    className={cn(
                      'border px-1.5 py-0.5 font-mono',
                      suggestion === chosen
                        ? 'border-olive bg-olive/10 text-foreground'
                        : 'border-border text-muted hover:border-muted hover:text-foreground',
                    )}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {!looking && verdict !== null && (
          verdict.ok ? (
            verdict.warning !== null && (
              <p className="border-l-2 border-amber pl-2 text-amber">{verdict.warning}</p>
            )
          ) : (
            <p className="border-l-2 border-rust pl-2 text-rust">{verdict.message}</p>
          )
        )}
      </div>
    </div>
  );
}
