'use client';

// ============================================================
//  create-ui-dialog.tsx  -  a segunda interface, e a terceira.
//
//  ####  O MOTOR JÁ EXISTIA; FALTAVA A PORTA  ####
//
//  `POST /api/ui/documents` sempre aceitou um documento inteiro ou
//  um modelo. O que não existia era caminho no painel: o botão de
//  criar só aparecia com a lista VAZIA e tinha `menu-principal`
//  escrito na mão. Com o Menu Principal de pé, não havia como
//  fazer um `/vip` ou um `/eventos` sem falar com a API na unha.
//
//  ------------------------------------------------------------
//  ####  TRÊS ORIGENS, PORQUE SÃO TRÊS PERGUNTAS DIFERENTES  ####
//
//    EM BRANCO   uma tela vazia. Para um menu que não se parece
//                com nada do que já existe.
//    DO MODELO   o desenho que o agente traz pronto. O id, o nome
//                e o comando são DELE — por isso os campos somem.
//    COPIANDO    o desenho de uma interface que já está de pé,
//                com identidade nova. É o caminho de "quero o
//                mesmo menu, com duas telas a menos".
//
//  ------------------------------------------------------------
//  ####  COPIAR PRESERVA OS IDS DAS TELAS, E ISSO É O PONTO  ####
//
//  `tela-ranking`, `tela-loja`, `tela-kits` não são nomes: são os
//  endereços pelos quais o agente reconhece as telas que ELE monta
//  (ver `generatedScreens`, em core/src/index.ts). Uma cópia que
//  sorteasse ids novos viraria um menu com a aba de loja abrindo
//  uma tela vazia — e sem erro nenhum, porque o documento
//  continuaria válido.
//
//  Trocamos só o que é identidade do DOCUMENTO: id, nome e
//  comando. O desenho vai inteiro.
//
//  ------------------------------------------------------------
//  ####  A DECISÃO NÃO MORA AQUI  ####
//
//  O que impede de criar está em `create-ui-rules.ts`, onde tem
//  teste: o vitest do painel roda em Node puro, sem jsdom, e o que
//  precisa de prova é a REGRA, não o render.
//
//  E ela é só aviso: quem RECUSA é o core. Ele conhece o banco, e
//  entre a lista que este componente recebeu e o INSERT cabe outra
//  aba do painel criando a mesma interface.
// ============================================================

import { Copy, FilePlus2, Sparkles } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { toSlug, whyNotReady, type Origin } from '@/components/ui-editor/create-ui-rules';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { agent, ApiError, type UiDocumentSummary, type UiPreset } from '@/lib/api';
import { createDocument } from '@/lib/ui-doc/factory';
import type { UiDocument } from '@/lib/ui-doc/model';
import { cn } from '@/lib/utils';

const ORIGINS: readonly {
  readonly value: Origin;
  readonly label: string;
  readonly icon: typeof FilePlus2;
}[] = [
  { value: 'blank', label: 'Em branco', icon: FilePlus2 },
  { value: 'preset', label: 'De um modelo', icon: Sparkles },
  { value: 'copy', label: 'Copiar uma existente', icon: Copy },
];

export interface CreateUiDialogProps {
  /** As que já existem — para barrar id e comando repetidos. */
  readonly documents: readonly UiDocumentSummary[];
  readonly onClose: () => void;
  /** O id da interface criada, para a tela abrir o editor nela. */
  readonly onCreated: (id: number) => void;
}

export function CreateUiDialog({ documents, onClose, onCreated }: CreateUiDialogProps) {
  const [origin, setOrigin] = useState<Origin>('blank');

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  /** `true` depois de a pessoa editar o id à mão: paramos de sugerir. */
  const [slugTouched, setSlugTouched] = useState(false);

  const [presets, setPresets] = useState<readonly UiPreset[] | null>(null);
  const [preset, setPreset] = useState<string>('');
  const [sourceId, setSourceId] = useState<string>('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.uiPresets();

        if (!alive) return;

        setPresets(response.presets);
        setPreset((current) => (current === '' ? (response.presets[0]?.preset ?? '') : current));
      } catch {
        // Sem modelos, as outras duas origens continuam de pé. Um
        // erro aqui não pode fechar a porta inteira.
        if (alive) setPresets([]);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const chosenPreset = presets?.find((item) => item.preset === preset) ?? null;

  const problem = whyNotReady(
    { origin, slug, name, command, preset: chosenPreset, sourceId },
    documents,
  );

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();

    if (problem !== null) {
      setError(problem);
      return;
    }

    setBusy(true);
    setError(null);

    try {
      onCreated(await create());
    } catch (cause) {
      // A frase vem do CORE quando ele é quem recusou: ele conhece
      // o banco, e a corrida entre duas abas é dele.
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  /** Cria e devolve o id no banco. Cada origem, um caminho. */
  async function create(): Promise<number> {
    if (origin === 'preset') {
      return (await agent.createUiFromPreset(preset)).document.id;
    }

    if (origin === 'copy') {
      const source = await agent.uiDocument(Number(sourceId));
      const document = source.document.document as UiDocument;

      // Só a identidade muda. Telas, shell e slots vão inteiros —
      // ver o cabeçalho deste arquivo.
      //
      // ####  MENOS OS ATALHOS  ####
      //
      // Cada atalho ocupa um nome GLOBAL de comando no servidor: o
      // plugin põe `command` e `shortcuts` no mesmo mapa. Levá-los
      // na cópia faria o `/quest` do original e o da cópia
      // disputarem a mesma palavra — e o core recusa a gravação por
      // isso, com razão. Quem quiser atalho na cópia escolhe um,
      // que é uma decisão e não um resíduo.
      const copy: UiDocument = {
        ...document,
        id: slug,
        name: name.trim(),
        command,
        shortcuts: [],
      };

      return (await agent.createUiDocument(copy)).document.id;
    }

    return (await agent.createUiDocument(createDocument(slug, name.trim(), command))).document.id;
  }

  const needsIdentity = origin !== 'preset';

  return (
    <Dialog open title="Criar interface" onClose={onClose} busy={busy}>
      <form onSubmit={(event) => void onSubmit(event)}>
        <p className="mb-4 text-sm text-muted">
          O desenho vale para a rede inteira. Qual servidor mostra esta interface — e o que ele
          esconde dela — fica na página de cada um, em Configurações.
        </p>

        {/* ---------------- A ORIGEM ---------------- */}
        <div className="mb-5 grid grid-cols-3 gap-2">
          {ORIGINS.map((item) => {
            const Icon = item.icon;
            const active = origin === item.value;

            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setOrigin(item.value);
                  setError(null);
                }}
                className={cn(
                  'flex flex-col items-center gap-1 border p-3 font-condensed text-2xs font-bold uppercase tracking-wide transition-colors',
                  active
                    ? 'border-amber bg-amber text-background'
                    : 'border-border bg-surface-2 text-foreground hover:border-muted',
                )}
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </div>

        {/* ---------------- DO MODELO ---------------- */}
        {origin === 'preset' && (
          <div>
            <Label htmlFor="preset">Modelo</Label>

            {presets === null ? (
              <p className="mt-1 text-2xs text-muted">Lendo os modelos…</p>
            ) : presets.length === 0 ? (
              <p className="mt-1 text-2xs text-muted">
                O agente não ofereceu modelo nenhum. As outras duas origens continuam valendo.
              </p>
            ) : (
              <select
                id="preset"
                value={preset}
                onChange={(event) => setPreset(event.target.value)}
                className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
              >
                {presets.map((item) => (
                  <option key={item.preset} value={item.preset}>
                    {item.name} — /{item.command}, {String(item.screens)} tela
                    {item.screens === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            )}

            {chosenPreset !== null && (
              <p className="mt-2 text-2xs leading-relaxed text-muted">
                Nasce como <code>{chosenPreset.id}</code> e responde a{' '}
                <code>/{chosenPreset.command}</code>. O identificador e o comando são do modelo — o
                agente monta o mesmo documento que ele cria sozinho no primeiro boot, e é isso que
                impede os dois caminhos de darem menus diferentes. Depois de criada, tudo é
                editável.
              </p>
            )}
          </div>
        )}

        {/* ---------------- COPIANDO ---------------- */}
        {origin === 'copy' && (
          <div className="mb-4">
            <Label htmlFor="source">Copiar o desenho de</Label>

            {documents.length === 0 ? (
              <p className="mt-1 text-2xs text-muted">
                Não há nenhuma interface para copiar ainda. Comece em branco ou por um modelo.
              </p>
            ) : (
              <>
                <select
                  id="source"
                  value={sourceId}
                  onChange={(event) => {
                    setSourceId(event.target.value);
                    setError(null);
                  }}
                  className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
                >
                  <option value="">escolha uma…</option>
                  {documents.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      {item.name} — /{item.command}, {String(item.screens)} tela
                      {item.screens === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>

                <p className="mt-2 text-2xs leading-relaxed text-muted">
                  Vem o desenho inteiro, com os ids das telas intactos — é o que mantém as abas de
                  ranking, loja e kits funcionando na cópia, porque é por esses ids que o agente as
                  reconhece. A partir daqui são duas interfaces independentes: mexer numa não mexe
                  na outra.
                </p>
              </>
            )}
          </div>
        )}

        {/* ---------------- A IDENTIDADE ---------------- */}
        {needsIdentity && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="name">Nome</Label>
              <Input
                id="name"
                value={name}
                placeholder="Menu VIP"
                onChange={(event) => {
                  setName(event.target.value);

                  if (!slugTouched) {
                    setSlug(toSlug(event.target.value));
                  }
                }}
              />
              <p className="mt-1 text-2xs text-muted">
                O que aparece nesta lista. Não vai para o jogo.
              </p>
            </div>

            <div>
              <Label htmlFor="slug">Identificador</Label>
              <Input
                id="slug"
                value={slug}
                placeholder="menu-vip"
                className="font-mono"
                onChange={(event) => {
                  setSlugTouched(true);
                  setSlug(event.target.value.toLowerCase());
                }}
              />
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                O endereço que o plugin guarda. <strong>Não muda depois</strong> — trocá-lo
                quebraria toda referência a ele.
              </p>
            </div>

            <div>
              <Label htmlFor="command">Comando de chat</Label>
              <div className="flex items-center gap-1">
                <span className="font-mono text-sm text-muted">/</span>
                <Input
                  id="command"
                  value={command}
                  placeholder="vip"
                  className="font-mono"
                  onChange={(event) =>
                    setCommand(event.target.value.toLowerCase().replace(/^\//, ''))
                  }
                />
              </div>
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                O que o jogador digita para abrir. Sem a barra: o jogo a adiciona, e{' '}
                <code>/vip</code> viraria <code>//vip</code>.
              </p>
            </div>
          </div>
        )}

        {error !== null && (
          <p className="mt-4 border border-rust bg-surface-2 p-3 text-sm">{error}</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={busy || problem !== null}>
            {busy ? 'Criando…' : 'Criar'}
          </Button>
        </div>

        {/* O que trava o botão fica visível, em vez de o botão
            apagado deixar a pessoa procurando o campo errado. */}
        {problem !== null && error === null && (
          <p className="mt-2 text-right text-2xs text-muted">{problem}</p>
        )}
      </form>
    </Dialog>
  );
}
