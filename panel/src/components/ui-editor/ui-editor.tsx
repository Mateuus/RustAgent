'use client';

// ============================================================
//  ui-editor.tsx  -  a árvore, o desenho e as propriedades.
//
//  ####  O DESENHO É 16:9 E USA AS ÂNCORAS DO CUI  ####
//
//  O palco tem exatamente a proporção da tela do jogo e trabalha
//  na base 1280x720, que é a unidade dos offsets do CUI. A escala
//  é só apresentação: toda conta acontece na mesma régua que o
//  jogo usa.
//
//  Um preview em pixels soltos enganaria — e o erro de âncora só
//  apareceria dentro do jogo, com a tela inteira desenhada em cima
//  dele.
//
//  ------------------------------------------------------------
//  ####  O CABEÇALHO É UMA "TELA" NA LISTA  ####
//
//  Ele não é uma tela do documento: é o SHELL, desenhado uma vez e
//  nunca redesenhado. Mas quem edita precisa chegar nele do mesmo
//  jeito que chega nas outras, então ele aparece no topo da lista.
//
//  ####  O CUI DE VERDADE VEM DO AGENTE  ####
//
//  O botão "Ver o CUI" chama `POST /api/ui/documents/:id/preview`.
//  A conversão mora lá, onde tem teste — e é a resposta de lá que
//  o cliente do jogo recebe. Uma segunda implementação aqui seria
//  uma segunda coisa para divergir.
// ============================================================

import { ChevronDown, ChevronUp, Code2, Layers, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agent, ApiError, type UiPreview } from '@/lib/api';
import { toast } from '@/lib/toast';
import { createElement, createScreen } from '@/lib/ui-doc/factory';
import { REFERENCE_HEIGHT, REFERENCE_WIDTH } from '@/lib/ui-doc/geometry';
import {
  findElement,
  UI_ELEMENT_TYPES,
  type UiDocument,
  type UiElement,
  type UiElementType,
} from '@/lib/ui-doc/model';
import {
  insertElement,
  moveElement,
  removeElement,
  updateElement,
  updateScreen,
  updateShell,
} from '@/lib/ui-doc/tree';
import { findDocumentProblems } from '@/lib/ui-doc/validate';
import { cn } from '@/lib/utils';

import { ElementView } from './element-view';
import { Inspector } from './inspector';

/** O id que representa o SHELL na lista de telas. */
const SHELL = '::shell';

export interface UiEditorProps {
  /** O id do documento no banco, para o preview. */
  readonly documentId: number;
  readonly document: UiDocument;
  readonly onChange: (document: UiDocument) => void;
}

export function UiEditor({ documentId, document, onChange }: UiEditorProps) {
  const [screenId, setScreenId] = useState<string>(document.entryScreenId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<UiPreview | null>(null);
  const [scale, setScale] = useState(1);

  const stage = useRef<HTMLDivElement>(null);

  // A escala do palco vem da LARGURA medida: o tamanho da fonte é
  // em pixels da base 1280, e sem escalá-lo junto um texto de 26px
  // continuaria com 26px numa caixa que encolheu.
  useEffect(() => {
    const element = stage.current;

    if (element === null) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setScale((entry?.contentRect.width ?? REFERENCE_WIDTH) / REFERENCE_WIDTH);
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  // A tela apagada não pode continuar selecionada: o canvas ficaria
  // vazio sem nada dizendo por quê.
  useEffect(() => {
    if (screenId !== SHELL && !document.screens.some((screen) => screen.id === screenId)) {
      setScreenId(document.entryScreenId);
    }
  }, [document, screenId]);

  const editingShell = screenId === SHELL;
  const screen = document.screens.find((item) => item.id === screenId) ?? null;
  const elements = editingShell ? document.shell : (screen?.elements ?? []);

  const selected =
    selectedId === null
      ? null
      : (findElement(document.shell, selectedId) ??
        findElement(
          document.screens.flatMap((item) => item.elements),
          selectedId,
        ));

  const problems = findDocumentProblems(document);

  /** Aplica uma mudança na lista de elementos que está em edição. */
  const editElements = useCallback(
    (edit: (list: readonly UiElement[]) => readonly UiElement[]): void => {
      onChange(
        editingShell
          ? updateShell(document, edit)
          : updateScreen(document, screenId, (item) => ({ ...item, elements: edit(item.elements) })),
      );
    },
    [document, editingShell, onChange, screenId],
  );

  const addElement = (type: UiElementType): void => {
    const element = createElement(type);

    // Entra DENTRO do selecionado quando ele existe: é o gesto que
    // quem desenha espera — "põe isto aqui dentro" — e o que evita
    // uma lista rasa de trinta elementos irmãos.
    editElements((list) => insertElement(list, selected?.id ?? null, element));
    setSelectedId(element.id);
  };

  const addScreen = (): void => {
    const created = createScreen();

    onChange({ ...document, screens: [...document.screens, created] });
    setScreenId(created.id);
    setSelectedId(null);
  };

  const showCui = async (): Promise<void> => {
    try {
      setPreview(
        await agent.previewUiDocument(documentId, {
          ...(editingShell ? {} : { screenId }),
          document,
        }),
      );
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    }
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[220px_1fr_300px]">
      {/* ---------------- ESQUERDA: telas e árvore ---------------- */}
      <div className="space-y-3">
        <div className="border border-border bg-surface">
          <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
            <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Telas
            </span>
            <Button size="sm" variant="ghost" onClick={addScreen} title="Criar uma tela">
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </div>

          <ul className="max-h-64 overflow-y-auto">
            <li>
              <button
                type="button"
                onClick={() => {
                  setScreenId(SHELL);
                  setSelectedId(null);
                }}
                title="O que NÃO é redesenhado ao trocar de tela: moldura, cabeçalho e os slots."
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1.5 text-left text-2xs',
                  editingShell ? 'bg-surface-2 text-foreground' : 'text-muted hover:text-foreground',
                )}
              >
                <Layers aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate font-condensed font-bold uppercase tracking-wide">
                  Cabeçalho
                </span>
              </button>
            </li>

            {document.screens.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setScreenId(item.id);
                    setSelectedId(null);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-2xs',
                    screenId === item.id
                      ? 'bg-surface-2 text-foreground'
                      : 'text-muted hover:text-foreground',
                  )}
                >
                  <span className="truncate">{item.name}</span>
                  {item.id === document.entryScreenId && (
                    <span
                      className="shrink-0 text-rust"
                      title="É a tela que abre. Ela é a única que viaja na carga inicial."
                    >
                      entrada
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {screen !== null && (
          <div className="space-y-2 border border-border bg-surface p-2">
            <label className="block space-y-1">
              <span className="block font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                Nome da tela
              </span>
              <Input
                value={screen.name}
                onChange={(event) =>
                  onChange(
                    updateScreen(document, screen.id, (item) => ({
                      ...item,
                      name: event.target.value,
                    })),
                  )
                }
              />
            </label>

            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={screen.id === document.entryScreenId}
              onClick={() => onChange({ ...document, entryScreenId: screen.id })}
              title="A tela de entrada é a que abre — e a única que viaja na carga inicial."
            >
              Tornar a tela de entrada
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={screen.id === document.entryScreenId || document.screens.length <= 1}
              onClick={() =>
                onChange({
                  ...document,
                  screens: document.screens.filter((item) => item.id !== screen.id),
                })
              }
              title={
                screen.id === document.entryScreenId
                  ? 'A tela de entrada não pode ser removida: sem ela o menu não abre.'
                  : 'Remover esta tela'
              }
            >
              Remover a tela
            </Button>
          </div>
        )}

        <div className="border border-border bg-surface">
          <div className="border-b border-border px-2 py-1.5">
            <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Elementos
            </span>
          </div>

          <div className="flex flex-wrap gap-1 border-b border-border p-2">
            {UI_ELEMENT_TYPES.map((type) => (
              <Button key={type} size="sm" variant="outline" onClick={() => addElement(type)}>
                <Plus aria-hidden="true" className="h-3 w-3" />
                {type}
              </Button>
            ))}
          </div>

          <ul className="max-h-96 overflow-y-auto py-1">
            <ElementBranch
              elements={elements}
              depth={0}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={(id, direction) => editElements((list) => moveElement(list, id, direction))}
            />
          </ul>
        </div>
      </div>

      {/* ---------------- MEIO: o desenho ---------------- */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            {editingShell ? 'Cabeçalho (desenhado uma vez)' : (screen?.name ?? '')}
          </span>

          <Button size="sm" variant="outline" onClick={() => void showCui()}>
            <Code2 aria-hidden="true" className="h-4 w-4" />
            Ver o CUI
          </Button>
        </div>

        {/* O palco. `aspect-video` é 16:9 — a proporção da tela do
            jogo. O fundo quadriculado é o que dá a ver onde há
            transparência. */}
        <div
          ref={stage}
          onClick={() => setSelectedId(null)}
          className="relative aspect-video w-full overflow-hidden border border-border"
          style={{
            backgroundColor: '#0F0F0F',
            backgroundImage:
              'linear-gradient(45deg, #1B1B1B 25%, transparent 25%), ' +
              'linear-gradient(-45deg, #1B1B1B 25%, transparent 25%), ' +
              'linear-gradient(45deg, transparent 75%, #1B1B1B 75%), ' +
              'linear-gradient(-45deg, transparent 75%, #1B1B1B 75%)',
            backgroundSize: '16px 16px',
            backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
          }}
        >
          {/* O SHELL primeiro: no CUI a ordem da lista é a
              profundidade, e o conteúdo vem por cima da moldura. */}
          {!editingShell &&
            document.shell.map((element) => (
              <ElementView
                key={element.id}
                element={element}
                selectedId={selectedId}
                onSelect={setSelectedId}
                scale={scale}
              />
            ))}

          {elements.map((element) => (
            <ElementView
              key={element.id}
              element={element}
              selectedId={selectedId}
              onSelect={setSelectedId}
              scale={scale}
            />
          ))}
        </div>

        <p className="text-2xs text-muted">
          {String(REFERENCE_WIDTH)}×{String(REFERENCE_HEIGHT)} — a base do CUI. O jogo escala isto
          para a resolução de cada jogador.
        </p>

        {problems.length > 0 && (
          <ul className="space-y-1 border border-rust bg-surface p-2">
            {problems.map((problem) => (
              <li key={problem.message} className="text-2xs text-rust">
                {problem.message}
              </li>
            ))}
          </ul>
        )}

        {preview !== null && (
          <div className="space-y-2 border border-border bg-surface p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                O CUI que o agente manda — {String(preview.cui.length)} elementos
              </span>
              <span
                className={cn('text-2xs', preview.payload.fits ? 'text-muted' : 'text-rust')}
                title="É o tamanho da CARGA INICIAL: os metadados mais a tela de entrada. Passando do teto, o envio é recusado inteiro."
              >
                carga inicial: {String(preview.payload.bytes)} de {String(preview.payload.limit)}{' '}
                bytes
              </span>
            </div>

            <pre className="max-h-64 overflow-auto bg-background p-2 font-mono text-2xs text-muted">
              {JSON.stringify(preview.cui, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* ---------------- DIREITA: propriedades ---------------- */}
      <div className="border border-border bg-surface">
        <div className="border-b border-border px-2 py-1.5">
          <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Propriedades
          </span>
        </div>

        <Inspector
          element={selected}
          screens={document.screens}
          onChange={(next) => editElements((list) => updateElement(list, next.id, () => next))}
          onRemove={() => {
            if (selected !== null) {
              editElements((list) => removeElement(list, selected.id));
              setSelectedId(null);
            }
          }}
        />
      </div>
    </div>
  );
}

/**
 * Um ramo da árvore de elementos.
 *
 * A indentação é o aninhamento, e as setas mudam a PROFUNDIDADE: no
 * CUI a ordem da lista é quem cobre quem.
 */
function ElementBranch({
  elements,
  depth,
  selectedId,
  onSelect,
  onMove,
}: {
  elements: readonly UiElement[];
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}) {
  return (
    <>
      {elements.map((element) => (
        <li key={element.id}>
          <div
            className={cn(
              'flex items-center gap-1 pr-1',
              element.id === selectedId ? 'bg-surface-2' : 'hover:bg-surface-2',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(element.id)}
              style={{ paddingLeft: `${String(8 + depth * 12)}px` }}
              className={cn(
                'flex-1 truncate py-1 text-left text-2xs',
                element.id === selectedId ? 'text-foreground' : 'text-muted',
              )}
              title={`${element.name} (${element.type})`}
            >
              <span className="text-rust">{element.type.slice(0, 1)}</span> {element.name}
            </button>

            <button
              type="button"
              onClick={() => onMove(element.id, -1)}
              className="shrink-0 text-muted hover:text-foreground"
              title="Mandar para trás"
            >
              <ChevronUp aria-hidden="true" className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => onMove(element.id, 1)}
              className="shrink-0 text-muted hover:text-foreground"
              title="Trazer para a frente"
            >
              <ChevronDown aria-hidden="true" className="h-3 w-3" />
            </button>
          </div>

          {element.children.length > 0 && (
            <ul>
              <ElementBranch
                elements={element.children}
                depth={depth + 1}
                selectedId={selectedId}
                onSelect={onSelect}
                onMove={onMove}
              />
            </ul>
          )}
        </li>
      ))}
    </>
  );
}
