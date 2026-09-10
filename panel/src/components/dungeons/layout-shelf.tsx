'use client';

// ============================================================
//  layout-shelf.tsx  -  o acervo de traçados desenhados.
//
//  ####  ELE É UMA GRADE, E A LISTA DE PLANTAS É UMA TABELA  ####
//
//  E a diferença não é estética. Uma planta do CopyPaste se escolhe
//  por número — peças, tamanho, tem alçapão — e número se compara
//  em coluna. Um traçado se escolhe pela FORMA: qual desenho é
//  aquele. Uma tabela de nomes obrigaria a abrir os oito para
//  descobrir, e nenhuma coluna responderia a pergunta.
//
//  Por isso cada cartão é a miniatura, grande o bastante para se
//  reconhecer de relance, com os números embaixo.
//
//  ####  O SELO DE DEFEITO APARECE NA GRADE  ####
//
//  Um traçado com sala lacrada é gravado de propósito — é rascunho.
//  Mas ele não pode chegar ao jogo sem ninguém ter visto, e o
//  momento de avisar é aquele em que o admin escolhe qual usar.
// ============================================================

import { Eye, Plus, TriangleAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { LayoutThumb } from '@/components/dungeons/layout-thumb';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { agent, type DungeonLayoutSummary } from '@/lib/api';
import { checkLayout } from '@/lib/dungeon-layout';
import { cn } from '@/lib/utils';

const ORIGIN_LABEL: Readonly<Record<DungeonLayoutSummary['origin'], string>> = {
  builtin: 'veio com o projeto',
  panel: 'desenhada por você',
  capture: 'capturada no jogo',
};

export interface LayoutShelfProps {
  readonly layouts: readonly DungeonLayoutSummary[];
  readonly onChanged: () => void;
  /** Abre a criação de masmorra já com este traçado dentro. */
  readonly onUse: (layout: DungeonLayoutSummary) => void;
}

export function LayoutShelf({ layouts, onChanged, onUse }: LayoutShelfProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<DungeonLayoutSummary | null>(null);

  async function remove(layout: DungeonLayoutSummary) {
    setBusy(true);
    setError(null);

    try {
      await agent.removeDungeonLayout(layout.id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="border border-border bg-surface p-3 text-xs text-muted">
        Um traçado é o desenho de uma masmorra guardado por si só — o mapa dos corredores e das
        salas, sem nada dentro. Ao criar uma masmorra você parte de um destes em vez do grid em
        branco, e o desenho é copiado: mexer nele depois não mexe aqui.
      </p>

      {error !== null && (
        <p className="border-l-2 border-amber bg-surface-2 px-3 py-2 text-xs text-foreground">
          {error}
        </p>
      )}

      {layouts.length === 0 ? (
        <p className="border border-border bg-surface p-6 text-center text-xs text-muted">
          Nenhum traçado ainda. Os quatro que vêm com o projeto entram no primeiro boot do agente —
          e todo desenho que você fizer numa masmorra pode ser salvo aqui pelo botão{' '}
          <strong className="text-foreground">Salvar como planta</strong>.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {layouts.map((layout) => (
            <li key={layout.id} className="flex flex-col border border-border bg-surface">
              <LayoutThumb grid={layout.grid} className="h-40 w-full border-0 border-b" />

              <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
                <h3 className="truncate font-condensed text-sm font-bold uppercase tracking-wide">
                  {layout.name}
                </h3>

                <p className="text-2xs text-muted">
                  {layout.roomCount} sala(s) · {layout.cellCount} células ·{' '}
                  {ORIGIN_LABEL[layout.origin]}
                </p>

                <ColorDots layout={layout} />

                {layout.problemCount > 0 && (
                  <p className="flex items-start gap-1 text-2xs text-foreground">
                    <TriangleAlert
                      aria-hidden="true"
                      className="mt-px h-3 w-3 shrink-0 text-amber"
                    />
                    {layout.problemCount === 1
                      ? '1 defeito: abra para ver.'
                      : `${String(layout.problemCount)} defeitos: abra para ver.`}
                  </p>
                )}

                <div className="mt-auto flex gap-1 pt-2">
                  <Button
                    size="sm"
                    variant="primary"
                    className="flex-1"
                    onClick={() => onUse(layout)}
                  >
                    <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                    Usar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setViewing(layout)}
                    aria-label={`Ver ${layout.name}`}
                  >
                    <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void remove(layout)}
                    aria-label={`Apagar ${layout.name}`}
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {viewing !== null && (
        <LayoutDialog
          layout={viewing}
          onClose={() => setViewing(null)}
          onUse={() => {
            const chosen = viewing;
            setViewing(null);
            onUse(chosen);
          }}
        />
      )}
    </div>
  );
}

/**
 * A mistura de cores do traçado.
 *
 * Bolinha E número: identidade nunca vem só da cor, e verde com
 * vermelho é justamente o par que o daltonismo mais confunde.
 */
function ColorDots({ layout }: { readonly layout: DungeonLayoutSummary }) {
  const parts = [
    { label: 'verdes', count: layout.byColor.green, fill: 'var(--olive)' },
    { label: 'azuis', count: layout.byColor.blue, fill: 'var(--chart-2)' },
    { label: 'vermelhas', count: layout.byColor.red, fill: 'var(--rust-red)' },
  ] as const;

  return (
    <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-muted">
      {parts
        .filter((part) => part.count > 0)
        .map((part) => (
          <span key={part.label} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0"
              style={{ backgroundColor: part.fill }}
            />
            {part.count} {part.label}
          </span>
        ))}
    </p>
  );
}

/** O traçado grande, com o que há de errado nele escrito por extenso. */
function LayoutDialog({
  layout,
  onClose,
  onUse,
}: {
  readonly layout: DungeonLayoutSummary;
  readonly onClose: () => void;
  readonly onUse: () => void;
}) {
  // As frases são calculadas aqui, e não guardadas: o banco tem a
  // CONTAGEM, que serve ao selo da grade. O texto de cada defeito
  // sai da mesma função que o agente roda, sem ida ao servidor.
  const problems = checkLayout(layout.grid);

  return (
    <Dialog open title={layout.name} onClose={onClose} className="w-[min(56rem,94vw)]">
      <div className="grid gap-3 sm:grid-cols-[1fr_15rem]">
        <LayoutThumb grid={layout.grid} gridLines className="max-h-[60vh] w-full" />

        <div className="space-y-3">
          {layout.description !== null && layout.description !== '' && (
            <p className="text-xs text-muted">{layout.description}</p>
          )}

          <dl className="space-y-1.5 text-xs">
            <Stat label="Salas" value={String(layout.roomCount)} />
            <Stat label="Células" value={String(layout.cellCount)} />
            <Stat
              label="Tamanho"
              value={`${String(Math.max(1, ...layout.grid.map((row) => row.length)) * 3)} × ${String(layout.grid.length * 3)} m`}
            />
            <Stat label="Entrada" value={layout.hasEntrance ? 'tem' : 'sem'} />
            <Stat label="Origem" value={ORIGIN_LABEL[layout.origin]} />
          </dl>

          <ColorDots layout={layout} />

          <Button variant="primary" size="sm" className="w-full" onClick={onUse}>
            <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Criar masmorra com este
          </Button>
        </div>
      </div>

      {problems.length > 0 && (
        <ul className={cn('mt-3 space-y-1')}>
          {problems.map((problem) => (
            <li
              key={problem}
              className="border-l-2 border-amber bg-surface-2 px-3 py-1.5 text-2xs text-foreground"
            >
              {problem}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 border-t border-border pt-2 text-2xs text-muted">
        Cada quadradinho é um cômodo de 3 por 3 metros. O amarelo é a entrada — é ali que o alçapão
        cospe o jogador. A porta nasce sozinha onde uma sala encosta no corredor.
      </p>
    </Dialog>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1">
      <dt className="font-condensed text-2xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="font-condensed text-sm font-bold">{value}</dd>
    </div>
  );
}
