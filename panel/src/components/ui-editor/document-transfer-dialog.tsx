// ============================================================
//  document-transfer-dialog.tsx  -  LEVAR O DESENHO DE UMA
//  INTERFACE DE UM AGENTE PARA OUTRO, COPIANDO E COLANDO.
//
//  ------------------------------------------------------------
//  ####  O QUE ISTO RESOLVE  ####
//
//  A interface é desenhada no agente de teste, elemento por
//  elemento, e depois precisa existir igual na produção — que é
//  outra máquina, com outro banco, e sem canal nenhum com a
//  primeira. Sem isto, o único caminho é redesenhar tudo à mão do
//  outro lado, e um número diferente numa âncora não dá erro: dá
//  um desenho parecido.
//
//  O editor já mostrava o CUI, mas só de LEITURA — ele é a saída
//  compilada, e não entra de volta. O que viaja aqui é o
//  DOCUMENTO: as telas, o shell e os elementos, que é o que o
//  editor sabe abrir.
//
//  ------------------------------------------------------------
//  ####  COLAR NAO GRAVA — APLICA NO RASCUNHO  ####
//
//  Quem cola quer VER antes de empurrar para os servidores, e o
//  editor já tem o botão que grava. Ir direto ao banco tiraria da
//  pessoa justamente a conferida, e "Salvar" sobe a revisão e
//  empurra a interface para quem a usa.
//
//  ####  E O QUE CHEGA E CONFERIDO PELO AGENTE, NAO AQUI  ####
//
//  O texto colado passa por `POST /ui/documents/:id/preview`, que
//  valida com o MESMO schema do salvar e não grava nada. Um
//  documento quebrado é recusado com a frase do agente, antes de o
//  editor tentar desenhá-lo — escrever uma segunda validação no
//  navegador seria uma régua a mais para divergir da primeira.
// ============================================================

import { ClipboardPaste, Copy, Download, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { agent, ApiError } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { UiDocument } from '@/lib/ui-doc/model';
import { cn } from '@/lib/utils';

import { preparePastedDocument } from './document-transfer';

interface DocumentTransferDialogProps {
  readonly open: boolean;
  /** O id no banco — o preview confere o texto colado por ele. */
  readonly documentId: number;
  /** O documento em edição: é ele que a aba COPIAR mostra. */
  readonly document: UiDocument;
  readonly onClose: () => void;
  /** Aplica o desenho colado no rascunho. Não grava. */
  readonly onPasted: (document: UiDocument) => void;
}

type Tab = 'copiar' | 'colar';

export function DocumentTransferDialog({
  open,
  documentId,
  document,
  onClose,
  onPasted,
}: DocumentTransferDialogProps) {
  const [tab, setTab] = useState<Tab>('copiar');
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);

  const exported = JSON.stringify(document, null, 2);

  useEffect(() => {
    if (open) return;

    setTab('copiar');
    setPasted('');
    setError(null);
  }, [open]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(exported);
      toast.success('Copiado', {
        description: 'Abra o painel do outro agente, nesta mesma interface, e cole na aba ao lado.',
      });
    } catch {
      // Área de transferência exige contexto seguro, e este painel
      // roda em http — por isso é aviso, e não erro: o texto
      // continua na tela para o Ctrl+C.
      toast.warning('Não consegui copiar sozinho', {
        description: 'Selecione o texto e copie com Ctrl+C.',
      });
    }
  }, [exported]);

  const paste = useCallback(async () => {
    const prepared = preparePastedDocument(pasted, document);

    if (!prepared.ok) {
      setError(prepared.message);
      return;
    }

    const candidate = prepared.document;

    setBusy(true);
    setError(null);

    try {
      // Se o preview aceita, o documento passa pela mesma régua do
      // salvar — e nada foi gravado.
      await agent.previewUiDocument(documentId, { document: candidate });

      onPasted(candidate);
      onClose();

      toast.success('Desenho colado', {
        description:
          'Confira na tela e clique em SALVAR para subir a revisão e empurrar aos servidores.',
      });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [pasted, document, documentId, onPasted, onClose]);

  const screens = document.screens.length;
  const shortcuts = document.shortcuts.length;

  return (
    <Dialog
      open={open}
      title="Copiar e colar o desenho"
      busy={busy}
      onClose={onClose}
      className="w-[min(52rem,94vw)]"
    >
      <div className="space-y-3">
        <div className="flex items-stretch border border-border">
          {(
            [
              { value: 'copiar', label: 'Copiar esta interface', icon: Copy },
              { value: 'colar', label: 'Colar de outro agente', icon: ClipboardPaste },
            ] as const
          ).map((option, index) => (
            <div key={option.value} className="flex flex-1 items-stretch">
              {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

              <button
                type="button"
                aria-pressed={tab === option.value}
                disabled={busy}
                onClick={() => {
                  setTab(option.value);
                }}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 px-3 py-2 text-2xs uppercase tracking-wide transition',
                  tab === option.value
                    ? 'bg-foreground/10 font-bold text-foreground'
                    : 'text-muted hover:text-foreground',
                )}
              >
                <option.icon aria-hidden="true" className="h-3.5 w-3.5" />
                {option.label}
              </button>
            </div>
          ))}
        </div>

        {tab === 'copiar' ? (
          <div className="space-y-2">
            <p className="text-2xs text-muted">
              O desenho inteiro desta interface — {String(screens)} tela(s), o cabeçalho e todos os
              elementos, do jeito que estão na tela agora, salvos ou não.
            </p>

            <textarea
              readOnly
              value={exported}
              spellCheck={false}
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              className="h-64 w-full resize-y border border-border bg-background px-3 py-2 font-mono text-2xs leading-relaxed text-muted"
            />

            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs text-muted">
                {new Intl.NumberFormat('pt-BR').format(exported.length)} caracteres
              </span>

              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  void copy();
                }}
              >
                <Copy aria-hidden="true" className="h-4 w-4" />
                Copiar tudo
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ui-doc-paste">O desenho copiado do outro agente</Label>

              <textarea
                id="ui-doc-paste"
                value={pasted}
                disabled={busy}
                spellCheck={false}
                placeholder={`{ "id": "${document.id}", "screens": [ ... ] }`}
                onChange={(event) => {
                  setPasted(event.target.value);
                  setError(null);
                }}
                className="h-48 w-full resize-y border border-border bg-background px-3 py-2 font-mono text-2xs leading-relaxed text-foreground"
              />
            </div>

            <ul className="space-y-1 border border-border bg-surface p-2 text-2xs text-muted">
              <li>
                O desenho substitui o que está aberto aqui — as telas, o cabeçalho e os elementos.
              </li>
              <li>
                O identificador continua sendo <code className="font-mono">{document.id}</code>: ele
                é o endereço que o plugin guarda, e trocá-lo quebraria toda referência a ele.
              </li>
              {shortcuts > 0 && (
                <li>
                  Os {String(shortcuts)} atalho(s) desta interface ficam como estão. Cada um ocupa
                  uma palavra global no servidor, e duas interfaces disputando a mesma deixariam uma
                  inalcançável no jogo.
                </li>
              )}
              <li className="text-foreground">
                Nada é gravado agora: o desenho entra na tela e o <strong>Salvar</strong> continua
                sendo seu.
              </li>
            </ul>

            {error !== null && (
              <p className="border border-rust bg-surface px-3 py-2 text-2xs text-rust">{error}</p>
            )}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
                Cancelar
              </Button>

              <Button
                size="sm"
                variant="primary"
                disabled={busy || pasted.trim() === ''}
                onClick={() => {
                  void paste();
                }}
              >
                {busy ? (
                  <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                ) : (
                  <Download aria-hidden="true" className="h-4 w-4" />
                )}
                Colar o desenho
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
