'use client';

// ============================================================
//  blueprint-shelf.tsx  -  o acervo de construções prontas.
//
//  ####  A COLUNA QUE IMPORTA É O ALÇAPÃO  ####
//
//  Uma planta de entrada sem a marca do alçapão SOBE BONITA e
//  falha 60 segundos depois, no jogo, com a casinha já de pé — o
//  pior lugar possível para descobrir. Por isso o selo aparece em
//  toda linha, e não escondido num detalhe.
//
//  O agente já recusa o upload de uma entrada sem marca; o selo
//  serve para a que veio de antes, e para a de tipo `base`, que
//  não precisa dele.
//
//  ####  O PAPEL É UMA ESCOLHA, E NÃO O NOME DO ARQUIVO  ####
//
//  Até 16/09/2026 o papel saía do nome ("base…" = masmorra), e uma
//  construção feita à mão raramente se chama assim. Agora o upload
//  PERGUNTA — o nome do arquivo só sugere a resposta — e a linha
//  deixa trocar o papel depois, sem subir o arquivo de novo.
//
//  O corpo volta do upload com o relatório: quantos marcadores o
//  arquivo tem e o que dele não será importado. É o momento em que o
//  admin ainda pode consertar a construção no jogo.
//
//  ####  A LISTA NÃO TRAZ O CONTEÚDO  ####
//
//  As sete que vêm com o projeto somam 1,1 MB, e a maior sozinha
//  tem 512 KB. O que a tela mostra são as contagens, calculadas
//  uma vez na escrita.
// ============================================================

import { Check, Eye, FileJson, Loader2, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { BlueprintPreview } from '@/components/dungeons/blueprint-preview';
import { Button } from '@/components/ui/button';
import { FieldLabel, HelpTip } from '@/components/ui/help-tip';
import { Input } from '@/components/ui/input';
import {
  agent,
  type BlueprintBodyReport,
  type BlueprintKind,
  type BlueprintMarkerCounts,
  type BlueprintSummary,
} from '@/lib/api';
import { DUNGEON_HELP } from '@/lib/help/dungeons';
import { cn } from '@/lib/utils';

const ORIGIN_LABEL: Readonly<Record<BlueprintSummary['origin'], string>> = {
  builtin: 'veio com o projeto',
  import: 'enviada por você',
  capture: 'capturada no jogo',
};

const KIND_LABEL: Readonly<Record<BlueprintKind, string>> = {
  entrance: 'Entrada',
  base: 'Corpo da masmorra',
};

const KIND_DETAIL: Readonly<Record<BlueprintKind, string>> = {
  entrance: 'A casinha da superfície. Precisa da marca do alçapão.',
  base: 'Uma construção feita no jogo, colada lá embaixo no modo "Construção importada".',
};

/** O arquivo escolhido, esperando o admin dizer o que ele é. */
interface PendingUpload {
  readonly fileName: string;
  readonly content: string;
  readonly name: string;
  readonly kind: BlueprintKind;
}

/** O que o último upload respondeu. */
interface UploadResult {
  readonly name: string;
  readonly kind: BlueprintKind;
  readonly body: BlueprintBodyReport | null;
}

export interface BlueprintShelfProps {
  readonly blueprints: readonly BlueprintSummary[];
  readonly onChanged: () => void;
}

export function BlueprintShelf({ blueprints, onChanged }: BlueprintShelfProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A planta aberta na prévia. `null` = nenhuma. */
  const [viewing, setViewing] = useState<BlueprintSummary | null>(null);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  /** A linha cujo papel está sendo trocado agora. */
  const [changing, setChanging] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function pick(file: File) {
    setError(null);
    setResult(null);

    try {
      const content = await file.text();
      const base = file.name.replace(/\.json$/i, '');

      setPending({
        fileName: file.name,
        content,
        name: base,
        // O nome do arquivo SUGERE, como fazia o seeder. Na dúvida,
        // entrada: é o papel em que a falta de alçapão é cobrada, e
        // errar para o lado que reclama é melhor que errar para o lado
        // que aceita.
        kind: slugify(base).startsWith('base') ? 'base' : 'entrance',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function upload(chosen: PendingUpload) {
    const id = slugify(chosen.name);

    if (id.length < 2) {
      setError('Dê um nome de pelo menos duas letras: é dele que sai o identificador da planta.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await agent.uploadBlueprint({
        id,
        name: chosen.name.trim(),
        kind: chosen.kind,
        content: chosen.content,
      });

      setPending(null);
      setResult({
        name: response.blueprint.name,
        kind: response.blueprint.kind,
        body: response.body ?? null,
      });
      onChanged();
    } catch (cause) {
      // A frase da API ENSINA onde fica a marca do alçapão.
      // Reescrevê-la aqui perderia justamente isso.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function changeKind(blueprint: BlueprintSummary, kind: BlueprintKind) {
    if (kind === blueprint.kind) return;

    setChanging(blueprint.id);
    setError(null);

    try {
      await agent.updateBlueprint(blueprint.id, { kind });
      onChanged();
    } catch (cause) {
      // `BLUEPRINT_NO_HATCH` e `BLUEPRINT_IN_USE` trazem a frase
      // pronta — inclusive o nome da masmorra que usa a planta.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChanging(null);
    }
  }

  async function remove(blueprint: BlueprintSummary) {
    setBusy(true);
    setError(null);

    try {
      await agent.removeBlueprint(blueprint.id);
      onChanged();
    } catch (cause) {
      // `BLUEPRINT_IN_USE` traz o nome de quem usa — é o que
      // decide se o admin insiste.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface p-3">
        <p className="min-w-0 text-xs text-muted">
          Uma planta é uma construção inteira salva em arquivo — a casinha da entrada, ou uma
          masmorra construída no jogo. O formato é o do CopyPaste.
        </p>

        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];

            if (file !== undefined) void pick(file);
            event.target.value = '';
          }}
        />

        <Button
          size="sm"
          variant="primary"
          disabled={busy || pending !== null}
          onClick={() => fileInput.current?.click()}
        >
          <Upload aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          Subir um .json
        </Button>
      </div>

      {pending !== null && (
        <UploadChoice
          pending={pending}
          busy={busy}
          taken={blueprints.some((blueprint) => blueprint.id === slugify(pending.name))}
          onChange={setPending}
          onConfirm={() => void upload(pending)}
          onCancel={() => setPending(null)}
        />
      )}

      {result !== null && <UploadReport result={result} onClose={() => setResult(null)} />}

      {error !== null && (
        <p className="border-l-2 border-amber bg-surface-2 px-3 py-2 text-xs text-foreground">
          {error}
        </p>
      )}

      <div className="overflow-x-auto border border-border bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left font-condensed text-2xs uppercase tracking-wide text-muted">
              <th className="px-3 py-2">Planta</th>
              <th className="px-3 py-2">
                <span className="flex items-center gap-1.5">
                  Papel
                  <HelpTip topic={DUNGEON_HELP.blueprintRole} />
                </span>
              </th>
              <th className="px-3 py-2 text-right">Peças</th>
              <th className="px-3 py-2 text-right">Tamanho</th>
              <th className="px-3 py-2">Alçapão</th>
              <th className="px-3 py-2">Marcadores</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>

          <tbody className="divide-y divide-border">
            {blueprints.map((blueprint) => (
              <tr key={blueprint.id}>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    <FileJson aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted" />
                    <span className="min-w-0">
                      <span className="block truncate font-condensed font-bold">
                        {blueprint.name}
                      </span>
                      <span className="block text-2xs text-muted">
                        {ORIGIN_LABEL[blueprint.origin]}
                      </span>
                    </span>
                  </span>
                </td>

                <td className="px-3 py-2">
                  <span className="flex items-center gap-1.5">
                    <select
                      value={blueprint.kind}
                      disabled={busy || changing !== null}
                      aria-label={`Papel de ${blueprint.name}`}
                      onChange={(event) =>
                        void changeKind(blueprint, event.target.value as BlueprintKind)
                      }
                      className="h-7 border border-border bg-background px-1 text-2xs"
                    >
                      <option value="entrance">entrada</option>
                      <option value="base">masmorra (corpo)</option>
                    </select>
                    {changing === blueprint.id && (
                      <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-muted" />
                    )}
                  </span>
                </td>

                <td className="px-3 py-2 text-right tabular-nums">{blueprint.entityCount}</td>

                <td className="px-3 py-2 text-right tabular-nums text-muted">
                  {formatBytes(blueprint.byteSize)}
                </td>

                <td className="px-3 py-2">
                  {/* Ícone E texto: identidade nunca por cor sozinha. */}
                  {blueprint.hasHatch ? (
                    <span className="flex items-center gap-1 text-2xs text-muted">
                      <Check aria-hidden="true" className="h-3.5 w-3.5 text-olive" />
                      tem
                    </span>
                  ) : blueprint.kind === 'entrance' ? (
                    <span className="flex items-center gap-1 text-2xs text-foreground">
                      <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 text-amber" />
                      não abre
                    </span>
                  ) : (
                    // O corpo não precisa: o servidor põe o alçapão de
                    // subir sobre a árvore de Natal.
                    <span className="text-2xs text-muted">não precisa</span>
                  )}
                </td>

                <td className="px-3 py-2">
                  {/* `?? null`: um agente de antes da contagem não manda o
                      campo, e o tipo do painel não valida a resposta. */}
                  <MarkerCell kind={blueprint.kind} markers={blueprint.markers ?? null} />
                </td>

                <td className="px-3 py-2 text-right">
                  <span className="flex justify-end gap-1">
                    {/* "584 pecas" nao diz que construcao e essa. O
                        JSON tem a posicao de cada peca, entao da
                        para DESENHAR a vista de cima. */}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setViewing(blueprint)}
                      aria-label={`Ver ${blueprint.name}`}
                    >
                      <Eye aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                      Ver
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void remove(blueprint)}
                      aria-label={`Apagar ${blueprint.name}`}
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {blueprints.length === 0 && (
          <p className="p-6 text-center text-xs text-muted">
            Nenhuma planta no acervo. As sete que vêm com o projeto são importadas no primeiro boot
            do agente — se a lista está vazia, o agente ainda não subiu com a pasta{' '}
            <code>Assets/dungeons</code> no lugar.
          </p>
        )}
      </div>

      {viewing !== null && (
        <BlueprintPreview blueprint={viewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

/**
 * A pergunta do upload: que construção é essa?
 *
 * Inline, e não um diálogo: a aba já mostra a lista, e o admin quer
 * ver as plantas que já existem enquanto dá o nome da nova.
 */
function UploadChoice({
  pending,
  busy,
  taken,
  onChange,
  onConfirm,
  onCancel,
}: {
  readonly pending: PendingUpload;
  readonly busy: boolean;
  /** Já existe uma planta com este identificador: ela será substituída. */
  readonly taken: boolean;
  readonly onChange: (pending: PendingUpload) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const nameId = useId();
  const id = slugify(pending.name);

  return (
    <div className="space-y-3 border border-border bg-surface-2 p-3">
      <p className="font-condensed text-sm font-bold uppercase tracking-wide">
        Que construção é {pending.fileName}?
      </p>

      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Papel da planta">
        {(['entrance', 'base'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={pending.kind === kind}
            onClick={() => onChange({ ...pending, kind })}
            className={cn(
              'border p-3 text-left transition-colors',
              pending.kind === kind
                ? 'border-rust bg-rust/10'
                : 'border-border bg-surface hover:border-muted',
            )}
          >
            <span className="block font-condensed text-xs font-bold uppercase tracking-wide">
              {kind === 'entrance'
                ? 'Entrada (casinha da superfície)'
                : 'Corpo da masmorra (construção feita no jogo)'}
            </span>
            <span className="mt-1 block text-2xs text-muted">{KIND_DETAIL[kind]}</span>
          </button>
        ))}
      </div>

      <div className="max-w-md">
        <FieldLabel htmlFor={nameId}>Nome</FieldLabel>
        <Input
          id={nameId}
          className="mt-1"
          value={pending.name}
          maxLength={80}
          onChange={(event) => onChange({ ...pending, name: event.target.value })}
        />
        <span className="mt-1 block text-2xs text-muted">
          Identificador: <code className="font-mono">{id === '' ? '—' : id}</code>
          {taken ? ' — já existe uma planta com ele, e ela será substituída.' : ''}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="confirm" disabled={busy} onClick={onConfirm}>
          {busy ? (
            <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          )}
          Subir como {KIND_LABEL[pending.kind].toLowerCase()}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/**
 * O que o upload respondeu.
 *
 * Para o corpo, é a validação da importação: quantos marcadores o
 * arquivo tem, e o que dele não sobe. Um zero em lápides é o aviso de
 * que a masmorra vai nascer sem inimigo nenhum — a não ser os que o
 * admin adicionar à mão.
 */
function UploadReport({
  result,
  onClose,
}: {
  readonly result: UploadResult;
  readonly onClose: () => void;
}) {
  const body = result.body;

  return (
    <div className="border-l-2 border-olive bg-surface-2 px-3 py-3">
      <p className="font-condensed text-sm font-bold uppercase tracking-wide">
        {result.name} no acervo, como {KIND_LABEL[result.kind].toLowerCase()}
      </p>

      {result.kind === 'base' && body === null && (
        <p className="mt-1 text-2xs text-muted">
          O agente não devolveu o relatório do corpo. Os marcadores aparecem quando você escolher
          esta construção numa masmorra.
        </p>
      )}

      {body !== null && (
        <>
          <p className="mt-1 text-xs text-foreground">
            <strong>{body.markers.npc}</strong> lápide(s) (inimigos),{' '}
            <strong>{body.markers.crate}</strong> conjunto(s) de velas (caixas) e{' '}
            <strong>{body.markers.arrival}</strong> árvore(s) de Natal (chegada).
          </p>

          {body.markers.npc + body.markers.crate === 0 && (
            <p className="mt-1 border-l-2 border-amber pl-2 text-2xs text-foreground">
              Nenhuma lápide nem vela: os inimigos e as caixas dessa masmorra serão só os que você
              adicionar à mão.
            </p>
          )}

          {body.warnings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {body.warnings.map((warning) => (
                <li key={warning} className="border-l-2 border-amber pl-2 text-2xs text-foreground">
                  {warning}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-2 text-2xs text-muted">
            Para usá-la, crie ou edite uma masmorra e escolha{' '}
            <strong className="text-foreground">Construção importada</strong>.
          </p>
        </>
      )}

      <Button size="sm" variant="ghost" className="mt-2" onClick={onClose}>
        Fechar
      </Button>
    </div>
  );
}

/** Os marcadores de corpo da planta, contados na escrita. */
function MarkerCell({
  kind,
  markers,
}: {
  readonly kind: BlueprintKind;
  readonly markers: BlueprintMarkerCounts | null;
}) {
  if (markers === null) {
    // Gravada antes da contagem existir. A leitura do corpo, ao
    // escolher a construção, conta na hora.
    return <span className="text-2xs text-muted">{kind === 'base' ? 'não contados' : '—'}</span>;
  }

  const total = markers.npc + markers.crate + markers.arrival;

  if (total === 0) {
    return (
      <span className="text-2xs text-muted">{kind === 'base' ? 'nenhum' : '—'}</span>
    );
  }

  return (
    <span className="flex flex-col text-2xs text-muted">
      <span className="tabular-nums">
        {markers.npc} inimigo(s) · {markers.crate} caixa(s)
      </span>
      <span
        className={cn(
          'tabular-nums',
          kind === 'base' && markers.arrival !== 1 && 'text-foreground',
        )}
      >
        {markers.arrival === 1
          ? '1 chegada'
          : markers.arrival === 0
            ? 'sem chegada'
            : `${String(markers.arrival)} árvores: escolher`}
      </span>
    </span>
  );
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${String(Math.round(bytes / 1024))} KB`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
