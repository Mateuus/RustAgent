'use client';

// ============================================================
//  /interface  -  o menu que os jogadores abrem no jogo.
//
//  ####  O DESENHO É DA REDE; O QUE APARECE É DO SERVIDOR  ####
//
//  Esta tela edita o DESENHO, e ele vale para a rede inteira. O
//  que cada servidor mostra dele — e o que ele esconde — fica na
//  página do servidor, em Configurações → Interface.
//
//  Uma interface por servidor faria seis cópias do mesmo menu, e a
//  sétima mudança seria feita em cinco delas.
//
//  ####  A REVISÃO É O QUE DIZ SE O JOGO ESTÁ EM DIA  ####
//
//  Ela sobe a cada gravação. Cada servidor guarda a que ele
//  RECEBEU — e a diferença entre as duas é o que a lista mostra,
//  sem precisar perguntar ao plugin.
// ============================================================

import { LayoutTemplate, Save, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { UiEditor } from '@/components/ui-editor/ui-editor';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { agent, ApiError, type UiDocumentSummary } from '@/lib/api';
import { formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import type { UiDocument } from '@/lib/ui-doc/model';
import { cn } from '@/lib/utils';

export default function InterfacePage() {
  return (
    <RequireSession>
      <Interface />
    </RequireSession>
  );
}

function Interface() {
  const [documents, setDocuments] = useState<UiDocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [openId, setOpenId] = useState<number | null>(null);
  /** O documento em edição. `null` = nenhum aberto. */
  const [draft, setDraft] = useState<UiDocument | null>(null);
  /** O que está GRAVADO, para saber se há o que salvar. */
  const [saved, setSaved] = useState<string>('');
  const [salvando, setSalvando] = useState(false);

  const load = useCallback(async () => {
    try {
      setDocuments((await agent.uiDocuments()).documents);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: number): Promise<void> => {
    try {
      const response = await agent.uiDocument(id);

      setOpenId(id);
      setDraft(response.document.document as UiDocument);
      setSaved(JSON.stringify(response.document.document));
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    }
  };

  const criarDoModelo = async (): Promise<void> => {
    try {
      const response = await agent.createUiFromPreset('menu-principal');

      toast.success('Menu Principal criado a partir do modelo.');
      await load();
      await open(response.document.id);
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    }
  };

  /**
   * Volta o desenho ao modelo, sem trocar o documento.
   *
   * ####  POR QUE NÃO É "CRIAR OUTRO"  ####
   *
   * Criar do modelo dá um documento NOVO, e cada servidor teria de
   * escolhê-lo de novo em Configurações. Isto reescreve o que já
   * existe: o id que o plugin guarda e os vínculos ficam de pé, e o
   * menu chega atualizado no próximo envio.
   */
  const restaurarDoModelo = async (id: number): Promise<void> => {
    try {
      const response = await agent.resetUiDocument(id, 'menu-principal');

      toast.success('Interface restaurada', { description: response.message });
      await load();

      if (openId === id) {
        await open(id);
      }
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    }
  };

  const salvar = async (): Promise<void> => {
    if (openId === null || draft === null) {
      return;
    }

    setSalvando(true);

    try {
      const response = await agent.saveUiDocument(openId, draft);

      setSaved(JSON.stringify(response.document.document));
      toast.success(`Salvo. Revisão ${String(response.document.revision)}.`);
      await load();
    } catch (cause) {
      // A frase vem do CORE: ela conhece a regra (botão para tela
      // apagada, id repetido) e a nossa não.
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setSalvando(false);
    }
  };

  const remover = async (id: number): Promise<void> => {
    try {
      await agent.deleteUiDocument(id);

      if (openId === id) {
        setOpenId(null);
        setDraft(null);
      }

      toast.success('Interface removida.');
      await load();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    }
  };

  const sujo = draft !== null && JSON.stringify(draft) !== saved;

  return (
    <div>
      <PageHeader
        title="Interface"
        description="O menu que os jogadores abrem no jogo. O desenho é da rede; o que cada servidor mostra dele fica na página dele."
        aside={
          <span className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted">
            <LayoutTemplate aria-hidden="true" className="h-4 w-4" />
            {documents === null || documents.length === 0
              ? 'nenhuma'
              : `${String(documents.length)} no total`}
          </span>
        }
      />

      <div className="mt-4 space-y-4">
        {error !== null && (
          <StateBlock variant="error" title="Não consegui ler as interfaces" detail={error} />
        )}

        {documents === null && error === null && <StateBlock variant="loading" title="Lendo…" />}

        {documents !== null && documents.length === 0 && (
          <div className="space-y-3">
            <StateBlock
              variant="empty"
              title="Nenhuma interface ainda"
              detail="O Menu Principal vem pronto: sete telas, cabeçalho com navegação e o botão de fechar. Ele nasce editável como qualquer outro."
            />

            <Button onClick={() => void criarDoModelo()}>
              <Sparkles aria-hidden="true" className="h-4 w-4" />
              Criar a partir do modelo
            </Button>
          </div>
        )}

        {documents !== null && documents.length > 0 && (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  {['Interface', 'Comando', 'Telas', 'Revisão', 'Quem usa', 'acoes'].map((title) => (
                    <th
                      key={title}
                      scope="col"
                      className="px-3 py-2 text-left font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
                    >
                      {title === 'acoes' ? <span className="sr-only">Ações</span> : title}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {documents.map((item) => (
                  <tr
                    key={item.id}
                    className={cn('hover:bg-surface-2', openId === item.id && 'bg-surface-2')}
                  >
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => void open(item.id)}
                        className="block min-w-0 text-left"
                      >
                        <span className="block truncate text-foreground">{item.name}</span>
                        <span className="block truncate font-mono text-2xs text-muted">
                          {item.slug}
                        </span>
                      </button>
                    </td>

                    <td className="px-3 py-2 font-mono text-2xs text-muted">/{item.command}</td>
                    <td className="px-3 py-2 text-muted">{String(item.screens)}</td>

                    <td className="px-3 py-2 text-muted">
                      {String(item.revision)}
                      <span className="block text-2xs">{formatWhen(item.updatedAt)}</span>
                    </td>

                    <td className="px-3 py-2">
                      {item.servers.length === 0 ? (
                        <span className="text-2xs text-muted">nenhum servidor</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {item.servers.map((binding) => (
                            <li key={binding.serverId} className="text-2xs">
                              <span className="text-foreground">{binding.serverId}</span>{' '}
                              {binding.appliedRevision === null ? (
                                <span
                                  className="text-rust"
                                  title="Ainda não foi aplicada neste servidor."
                                >
                                  nunca aplicada
                                </span>
                              ) : binding.appliedRevision < item.revision ? (
                                <span
                                  className="text-rust"
                                  title="O agente tem uma versão mais nova que a que está no jogo. Aplique na página do servidor."
                                >
                                  na revisão {String(binding.appliedRevision)}
                                </span>
                              ) : (
                                <span className="text-muted">em dia</span>
                              )}
                              {!binding.enabled && <span className="text-muted"> · desligada</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>

                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {/* ####  O MODELO ANDA; O DOCUMENTO NÃO  ####

                            O menu nasce no primeiro boot e fica
                            parado ali. Quando o modelo ganha algo
                            novo — o saldo no cabeçalho, os modais da
                            loja —, este é o caminho de volta, e ele
                            preserva os servidores que já o
                            escolheram. */}
                        <ConfirmButton
                          variant="primary"
                          disabled={false}
                          icon={null}
                          label="Restaurar do modelo"
                          confirmLabel="Substituir o desenho"
                          hint="O desenho atual é substituído INTEIRO pelo modelo do agente. Os servidores que usam esta interface continuam com ela, e recebem a versão nova no próximo envio."
                          onConfirm={() => void restaurarDoModelo(item.id)}
                        />

                        <ConfirmButton
                          variant="danger"
                          disabled={false}
                          icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
                          label="Remover"
                          confirmLabel="Remover mesmo?"
                          hint={
                            item.servers.length === 0
                              ? 'Ela some do agente. Nenhum servidor a usa.'
                              : `${String(item.servers.length)} servidor(es) ficam sem menu no jogo.`
                          }
                          onConfirm={() => void remover(item.id)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {documents !== null && documents.length > 0 && draft === null && (
          <p className="text-2xs text-muted">Clique no nome de uma interface para abrir o editor.</p>
        )}

        {/* ---------------- O EDITOR ---------------- */}
        {draft !== null && openId !== null && (
          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
                {draft.name}
                {sujo && <span className="ml-2 text-2xs text-rust">alterações não salvas</span>}
              </span>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setDraft(null);
                    setOpenId(null);
                  }}
                >
                  Fechar
                </Button>

                <Button disabled={!sujo || salvando} onClick={() => void salvar()}>
                  <Save aria-hidden="true" className="h-4 w-4" />
                  Salvar
                </Button>
              </div>
            </div>

            <p className="text-2xs leading-relaxed text-muted">
              Salvar sobe a revisão e empurra a interface para os servidores que a usam. Quem
              estiver parado recebe quando voltar.
            </p>

            <UiEditor documentId={openId} document={draft} onChange={setDraft} />
          </div>
        )}
      </div>
    </div>
  );
}
