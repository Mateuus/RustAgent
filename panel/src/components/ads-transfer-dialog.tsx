// ============================================================
//  ads-transfer-dialog.tsx  -  LEVAR O OVERLAY DE UM SERVIDOR
//  PARA OUTRO, COPIANDO E COLANDO.
//
//  ------------------------------------------------------------
//  ####  POR QUE TEXTO, E NAO UM BOTAO DE "SINCRONIZAR"  ####
//
//  O agente de teste e o de produção rodam em máquinas
//  diferentes, com bancos diferentes, e nenhum dos dois sabe que o
//  outro existe. Não há canal entre eles para um botão usar.
//
//  O que existe é a pessoa, com os dois painéis abertos. Texto é o
//  transporte que ela já tem — e funciona igual entre duas abas do
//  mesmo navegador, por Discord, ou colado num arquivo guardado
//  para daqui a seis meses.
//
//  ------------------------------------------------------------
//  ####  COPIAR E COLAR SAO DUAS ABAS, E NAO DOIS BOTOES  ####
//
//  Porque são o mesmo trabalho visto dos dois lados, e quem abre
//  esta janela costuma fazer os dois em sequência: copia no
//  servidor de teste, troca de aba do navegador, cola na produção.
//
//  A que abre primeiro é COPIAR: é a que não muda nada. Abrir
//  direto na que apaga seria convidar o clique errado.
// ============================================================

import { AlertTriangle, ClipboardPaste, Copy, Download, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { agent, type AdsPackage, type AdsView } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface AdsTransferDialogProps {
  readonly open: boolean;
  readonly serverId: string;
  readonly onClose: () => void;
  /** A vista já refeita, para a página se redesenhar sem ir à rede. */
  readonly onImported: (view: AdsView) => void;
}

type Tab = 'copiar' | 'colar';
type Mode = 'replace' | 'append';

export function AdsTransferDialog({
  open,
  serverId,
  onClose,
  onImported,
}: AdsTransferDialogProps) {
  const [tab, setTab] = useState<Tab>('copiar');
  const [busy, setBusy] = useState(false);

  const [exported, setExported] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [pasted, setPasted] = useState('');
  const [mode, setMode] = useState<Mode>('replace');
  const [importError, setImportError] = useState<string | null>(null);

  // ----------------------------------------------------------
  //  O PACOTE É BUSCADO AO ABRIR, E NÃO NUM BOTÃO
  //
  //  Quem abre esta janela na aba COPIAR quer o texto — pedir mais
  //  um clique para ver aquilo que é a única coisa ali seria um
  //  passo sem decisão nenhuma dentro dele.
  // ----------------------------------------------------------
  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();

    void (async () => {
      try {
        const result = await agent.exportAds(serverId, controller.signal);
        setExported(JSON.stringify(result.package, null, 2));
        setExportError(null);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;

        setExportError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      controller.abort();
    };
  }, [open, serverId]);

  /** Volta ao estado de recém-aberta — a próxima abertura é outra tarefa. */
  useEffect(() => {
    if (open) return;

    setTab('copiar');
    setPasted('');
    setMode('replace');
    setImportError(null);
    setExported(null);
    setExportError(null);
  }, [open]);

  const copy = useCallback(async () => {
    if (exported === null) return;

    try {
      await navigator.clipboard.writeText(exported);
      toast.success('Copiado', {
        description: 'Cole no outro servidor, na aba "Colar" desta mesma janela.',
      });
    } catch {
      // ####  A AREA DE TRANSFERENCIA PODE SER NEGADA  ####
      //
      // Ela exige contexto seguro e, em alguns navegadores,
      // permissão. Negada, o texto continua ali na tela para
      // selecionar à mão — por isso isto é um aviso, e não um erro.
      toast.warning('Não consegui copiar sozinho', {
        description: 'Selecione o texto e copie com Ctrl+C.',
      });
    }
  }, [exported]);

  const paste = useCallback(async () => {
    const raw = pasted.trim();

    if (raw === '') {
      setImportError('Cole aqui o texto que você copiou do outro servidor.');
      return;
    }

    // ####  O JSON E CONFERIDO AQUI ANTES DE IR A REDE  ####
    //
    // Não para validar o conteúdo — quem faz isso é o agente, com o
    // mesmo schema das duas pontas. É para que "colei metade do
    // texto" tenha uma resposta imediata e específica, em vez de
    // virar um 400 genérico depois da viagem.
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      setImportError(
        'Isto não é um texto de overlay válido. Confira se você copiou tudo, do primeiro { ao último }.',
      );
      return;
    }

    setBusy(true);
    setImportError(null);

    try {
      const result = await agent.importAds(serverId, mode, parsed as AdsPackage);

      onImported(result);
      onClose();

      toast.success('Overlay colado', {
        description:
          mode === 'replace'
            ? `${String(result.created)} propaganda(s) no lugar de ${String(result.removed)}. O ajuste também veio junto.`
            : `${String(result.created)} propaganda(s) acrescentada(s) no fim da lista.`,
      });
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [pasted, mode, serverId, onImported, onClose]);

  return (
    <Dialog
      open={open}
      title="Copiar e colar o overlay"
      busy={busy}
      onClose={onClose}
      className="w-[min(52rem,94vw)]"
    >
      <div className="space-y-3">
        <div className="flex items-stretch border border-border">
          {(
            [
              { value: 'copiar', label: 'Copiar deste servidor', icon: Copy },
              { value: 'colar', label: 'Colar de outro', icon: ClipboardPaste },
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
                  'flex flex-1 items-center justify-center gap-2 px-3 py-2 text-xs transition',
                  tab === option.value
                    ? 'bg-foreground/10 font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
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
            <p className="text-xs text-muted-foreground">
              Este texto tem o ajuste do overlay e todas as propagandas — inclusive as desligadas.
              Copie e cole no outro servidor, pela aba ao lado.
            </p>

            {exportError !== null ? (
              <p className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {exportError}
              </p>
            ) : exported === null ? (
              <p className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                Montando o texto…
              </p>
            ) : (
              <>
                <textarea
                  readOnly
                  value={exported}
                  spellCheck={false}
                  onFocus={(event) => {
                    event.currentTarget.select();
                  }}
                  className="h-64 w-full resize-y border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground"
                />

                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {new Intl.NumberFormat('pt-BR').format(exported.length)} caracteres
                  </span>

                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      void copy();
                    }}
                  >
                    <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                    Copiar tudo
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label htmlFor="ads-paste">O texto do outro servidor</Label>

              <textarea
                id="ads-paste"
                value={pasted}
                disabled={busy}
                spellCheck={false}
                placeholder='{ "kind": "origemz.ads", ... }'
                onChange={(event) => {
                  setPasted(event.target.value);
                  setImportError(null);
                }}
                className="h-48 w-full resize-y border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label>O que fazer com o que já está aqui</Label>

              {(
                [
                  {
                    value: 'replace',
                    title: 'Substituir tudo',
                    detail:
                      'Apaga as propagandas deste servidor e traz o ajuste junto. É o que deixa este servidor igual ao outro.',
                  },
                  {
                    value: 'append',
                    title: 'Acrescentar',
                    detail:
                      'Mantém o que já existe e põe as novas no fim da lista. O ajuste deste servidor não é tocado.',
                  },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={busy}
                  aria-pressed={mode === option.value}
                  onClick={() => {
                    setMode(option.value);
                  }}
                  className={cn(
                    'w-full border px-3 py-2 text-left transition',
                    mode === option.value
                      ? 'border-foreground/40 bg-foreground/5'
                      : 'border-border hover:border-foreground/25',
                  )}
                >
                  <span className="block text-xs font-medium text-foreground">{option.title}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {option.detail}
                  </span>
                </button>
              ))}
            </div>

            {/* ####  O AVISO E SO DO MODO QUE APAGA  ####

                Pô-lo sempre na tela o transformaria em moldura, e
                quem lê duas vezes a mesma frase para de a ler. */}
            {mode === 'replace' && (
              <p className="flex items-start gap-2 border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                <AlertTriangle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>
                  As propagandas que estão neste servidor agora vão ser apagadas, e o ajuste do
                  overlay será o do texto colado. Isto não tem desfazer.
                </span>
              </p>
            )}

            {importError !== null && (
              <p className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {importError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
                Cancelar
              </Button>

              <Button
                variant="primary"
                size="sm"
                disabled={busy || pasted.trim() === ''}
                onClick={() => {
                  void paste();
                }}
              >
                {busy ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {mode === 'replace' ? 'Substituir o overlay' : 'Acrescentar as propagandas'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
