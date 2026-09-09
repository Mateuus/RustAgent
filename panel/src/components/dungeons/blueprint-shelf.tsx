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
//  ####  A LISTA NÃO TRAZ O CONTEÚDO  ####
//
//  As sete que vêm com o projeto somam 1,1 MB, e a maior sozinha
//  tem 512 KB. O que a tela mostra são as contagens, calculadas
//  uma vez na escrita.
// ============================================================

import { Check, Eye, FileJson, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

import { BlueprintPreview } from '@/components/dungeons/blueprint-preview';
import { Button } from '@/components/ui/button';
import { agent, type BlueprintSummary } from '@/lib/api';

const ORIGIN_LABEL: Readonly<Record<BlueprintSummary['origin'], string>> = {
  builtin: 'veio com o projeto',
  import: 'enviada por você',
  capture: 'capturada no jogo',
};

export interface BlueprintShelfProps {
  readonly blueprints: readonly BlueprintSummary[];
  readonly onChanged: () => void;
}

export function BlueprintShelf({ blueprints, onChanged }: BlueprintShelfProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A planta aberta na prévia. `null` = nenhuma. */
  const [viewing, setViewing] = useState<BlueprintSummary | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);

    try {
      const content = await file.text();
      const id = slugify(file.name.replace(/\.json$/i, ''));

      await agent.uploadBlueprint({
        id,
        name: id,
        // Pelo nome, como o seeder: um arquivo fora do padrão cai
        // em `entrance`, que é o caso em que a falta de alçapão é
        // cobrada. Errar para o lado que reclama é melhor que
        // errar para o lado que aceita.
        kind: id.toLowerCase().startsWith('base') ? 'base' : 'entrance',
        content,
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
          masmorra pronta. O formato é o do CopyPaste.
        </p>

        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];

            if (file !== undefined) void upload(file);
            event.target.value = '';
          }}
        />

        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <Upload aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          Subir um .json
        </Button>
      </div>

      {error !== null && (
        <p className="border-l-2 border-amber bg-surface-2 px-3 py-2 text-xs text-foreground">
          {error}
        </p>
      )}

      <div className="border border-border bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left font-condensed text-2xs uppercase tracking-wide text-muted">
              <th className="px-3 py-2">Planta</th>
              <th className="px-3 py-2">Tipo</th>
              <th className="px-3 py-2 text-right">Peças</th>
              <th className="px-3 py-2 text-right">Tamanho</th>
              <th className="px-3 py-2">Alçapão</th>
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

                <td className="px-3 py-2 text-2xs text-muted">
                  {blueprint.kind === 'entrance' ? 'entrada' : 'masmorra'}
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
                  ) : (
                    <span className="flex items-center gap-1 text-2xs text-foreground">
                      <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 text-amber" />
                      {blueprint.kind === 'entrance' ? 'não abre' : 'não precisa'}
                    </span>
                  )}
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
