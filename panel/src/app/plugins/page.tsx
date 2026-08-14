'use client';

// ============================================================
//  /plugins  -  a BIBLIOTECA de plugins do agente.
//
//  ####  ESTA TELA É DE REDE, NÃO DE SERVIDOR  ####
//
//  O `.cs` entra aqui UMA vez, com a versão e o autor lidos do
//  próprio arquivo. Quem liga e desliga é a aba Plugins de cada
//  servidor. Foi a separação que faltava: antes, atualizar um
//  plugin em cinco servidores era o mesmo upload cinco vezes, e
//  não havia como saber se as cinco cópias eram iguais.
//
//  ####  ENVIAR NÃO É APLICAR  ####
//
//  Subir a versão nova deixa a biblioteca em dia e NÃO mexe em
//  servidor nenhum: cinco servidores no ar recarregando um plugin
//  porque alguém arrastou um arquivo é susto que ninguém pediu. A
//  resposta diz quem ficou para trás, e a aba de cada servidor tem
//  o botão de aplicar.
//
//  ####  TABELA, E NÃO CARTÃO  ####
//
//  Mesma razão da lista de servidores: esta tela é de COMPARAÇÃO —
//  varrer a coluna de versão e a de "ativo em" de cima a baixo e
//  achar o que está fora do lugar.
// ============================================================

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { agent, ApiError, type LibraryPlugin } from '@/lib/api';
import { EM_DASH } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export default function PluginsPage() {
  return (
    <RequireSession>
      <Library />
    </RequireSession>
  );
}

function HeaderCell({ children, numeric }: { children: ReactNode; numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 font-condensed text-2xs font-bold uppercase tracking-wide text-muted',
        numeric === true ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

function Library() {
  const [plugins, setPlugins] = useState<LibraryPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await agent.plugins();

      setPlugins(response.plugins);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setNotice(null);

    try {
      const response = await agent.uploadPlugin(file);

      toast.success(`${response.plugin.name} na biblioteca`, {
        description:
          response.plugin.version === null
            ? undefined
            : `versão ${response.plugin.version}, de ${response.plugin.author ?? 'autor não declarado'}`,
      });

      // Quem ficou para trás fica NA TELA, e não no toast: é uma
      // lista de servidores para agir sobre, um a um.
      if (response.pendingServers.length > 0) {
        setNotice(response.message);
      }

      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      toast.error('O envio foi recusado', { description: message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Remove da biblioteca.
   *
   * Sem servidores usando, vai direto. Com, vai com `force` — mas
   * só depois de o botão ter escrito QUAIS servidores perdem o
   * plugin: um "tem certeza?" que não diz o tamanho do estrago não
   * confirma nada.
   */
  async function remove(plugin: LibraryPlugin, force: boolean): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.removePlugin(plugin.id, force);

      toast.success(response.message);
      setNotice(null);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      // A recusa por estar em uso não é falha: é o agente pedindo
      // confirmação, com a lista de servidores na frase. Ela vai
      // para a tela, e não para um toast que some em segundos.
      if (cause instanceof ApiError && cause.code === 'PLUGIN_IN_USE') {
        setNotice(message);
      } else {
        toast.error('Não consegui remover', { description: message });
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Plugins"
        description="A biblioteca do agente. Cada servidor liga o que quiser dela."
        aside={
          <div className="flex shrink-0 items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept=".cs"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];

                if (file !== undefined) {
                  void upload(file);
                }

                event.target.value = '';
              }}
            />

            <Button variant="primary" disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? 'Enviando…' : 'Enviar plugin (.cs)'}
            </Button>
          </div>
        }
      />

      <div className="mt-4">
        {error !== null && (
          <div className="mb-4">
            <StateBlock variant="error" title="Não consegui ler a biblioteca" detail={error} />
          </div>
        )}

        {notice !== null && (
          <p className="mb-4 border border-amber bg-surface-2 p-3 text-sm leading-relaxed">
            {notice}
          </p>
        )}

        {plugins === null && error === null && (
          <StateBlock variant="loading" title="Lendo a biblioteca…" />
        )}

        {plugins !== null && plugins.length === 0 && (
          <StateBlock
            variant="empty"
            title="Nenhum plugin na biblioteca"
            detail={
              <>
                Envie um <code>.cs</code> — vale para os plugins deste projeto e para qualquer um
                baixado do uMod. O nome, o autor e a versão saem do próprio arquivo.
              </>
            }
          />
        )}

        {plugins !== null && plugins.length > 0 && (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>Plugin</HeaderCell>
                  <HeaderCell>Autor</HeaderCell>
                  <HeaderCell>Versão</HeaderCell>
                  <HeaderCell>Ativo em</HeaderCell>
                  <HeaderCell numeric>Tamanho</HeaderCell>
                  <HeaderCell>
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {plugins.map((plugin) => (
                  <tr key={plugin.id}>
                    <td className="px-3 py-2">
                      <p className="truncate">{plugin.title ?? plugin.name}</p>
                      <p className="truncate text-2xs text-muted">{plugin.file}</p>

                      {/* ####  A DEPENDÊNCIA APARECE ANTES DO CLIQUE  ####

                          Quem remove daqui remove de TODOS os
                          servidores — e leva junto, em cada um, quem
                          exigia este plugin. Ler isso só na
                          confirmação é tarde para quem ainda está
                          decidindo o que remover. */}
                      {plugin.dependents.hard.length > 0 && (
                        <p className="mt-1 text-2xs leading-relaxed text-amber">
                          {plugin.dependents.hard.join(', ')}{' '}
                          {plugin.dependents.hard.length > 1 ? 'não carregam' : 'não carrega'} sem
                          este.
                        </p>
                      )}

                      {plugin.dependents.soft.length > 0 && (
                        <p className="mt-1 text-2xs leading-relaxed text-muted">
                          {plugin.dependents.soft.join(', ')} usa este quando ele está no ar.
                        </p>
                      )}

                      {plugin.requires.length > 0 && (
                        <p className="mt-1 text-2xs leading-relaxed text-muted">
                          Depende de {plugin.requires.join(', ')}.
                        </p>
                      )}
                    </td>

                    <td className="px-3 py-2 text-muted">{plugin.author ?? EM_DASH}</td>

                    <td className="px-3 py-2 tabular-nums">{plugin.version ?? EM_DASH}</td>

                    {/* Os NOMES, e não a contagem: "2 servidores"
                        obriga a ir procurar quais. */}
                    <td className="px-3 py-2">
                      {plugin.servers.length === 0 ? (
                        <span className="text-muted">{EM_DASH}</span>
                      ) : (
                        plugin.servers.join(', ')
                      )}
                    </td>

                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {(plugin.bytes / 1024).toFixed(1)} KB
                    </td>

                    <td className="px-3 py-2 text-right">
                      <ConfirmButton
                        variant="danger"
                        disabled={busy}
                        icon={null}
                        label="Remover"
                        confirmLabel="Remover mesmo"
                        hint={
                          plugin.servers.length === 0
                            ? `${plugin.file} sai da biblioteca.`
                            : `${plugin.name} é descarregado e apagado de ${plugin.servers.join(
                                ', ',
                              )}. A configuração em oxide\\config é preservada.`
                        }
                        onConfirm={() => {
                          void remove(plugin, plugin.servers.length > 0);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-2xs leading-relaxed text-muted">
          Enviar uma versão nova atualiza a biblioteca e{' '}
          <strong>não mexe em servidor nenhum</strong>: quem já usa o plugin continua com a versão
          anterior até alguém aplicar, na aba Plugins daquele servidor. É lá que aparece o aviso de
          atualização pendente.
        </p>
      </div>
    </div>
  );
}
