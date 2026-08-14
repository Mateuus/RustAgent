'use client';

// ============================================================
//  plugins-panel.tsx  -  os .cs daquele servidor.
//
//  ####  ENVIAR E CARREGAR SÃO COISAS DIFERENTES  ####
//
//  O arquivo pode ser gravado com sucesso e o plugin não
//  compilar. A resposta do agente traz os dois: a confirmação do
//  envio e o que o Oxide respondeu. A tela mostra os dois — se
//  mostrasse só "enviado", a pessoa clicaria de novo achando que
//  não foi; se mostrasse só o erro, acharia que precisa reenviar.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { agent, type PluginInfo } from '@/lib/api';
import { toast } from '@/lib/toast';

export function PluginsPanel({ serverId }: { serverId: string }) {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await agent.plugins(serverId);

      setPlugins(response.plugins);
      setDir(response.pluginsDir);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await agent.uploadPlugin(serverId, file);

      // ####  GRAVAR E CARREGAR SÃO COISAS DIFERENTES  ####
      //
      // O toast confirma o ENVIO (que deu certo); a resposta do
      // Oxide fica na tela, porque é lá que aparece o erro de
      // compilação — e esse precisa poder ser lido com calma.
      toast.success(`${response.name} enviado`);

      setNotice(
        response.reload.output === null
          ? response.message
          : `${response.message}\n\nOxide: ${response.reload.output}`,
      );

      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      toast.error('O envio foi recusado', { description: message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
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

        <span className="truncate text-2xs text-muted">{dir}</span>
      </div>

      {error !== null && <p className="mb-4 border border-rust bg-surface-2 p-3 text-sm">{error}</p>}

      {notice !== null && (
        <pre className="mb-4 whitespace-pre-wrap border border-border bg-surface-2 p-3 text-2xs">
          {notice}
        </pre>
      )}

      {plugins === null && error === null && (
        <StateBlock variant="loading" title="Lendo a pasta de plugins…" />
      )}

      {plugins !== null && plugins.length === 0 && (
        <StateBlock
          variant="empty"
          title="Nenhum plugin instalado"
          detail={
            <>
              Envie um <code>.cs</code> — vale para os plugins deste projeto e para qualquer um
              baixado do uMod. Com o servidor parado, ele carrega no próximo start.
            </>
          }
        />
      )}

      <div className="divide-y divide-border border border-border bg-surface">
        {plugins?.map((plugin) => (
          <div key={plugin.name} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm">{plugin.name}</p>
              <p className="text-2xs text-muted">
                {(plugin.bytes / 1024).toFixed(1)} KB ·{' '}
                {new Date(plugin.modifiedAt).toLocaleString('pt-BR')}
              </p>
            </div>

            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                onClick={() => {
                  void agent
                    .reloadPlugin(serverId, plugin.name)
                    .then((response) => {
                      toast.success(`${plugin.name} recarregado`);
                      setNotice(response.reload.output ?? 'Recarregado.');
                    })
                    .catch((cause: unknown) => {
                      const message = cause instanceof Error ? cause.message : String(cause);

                      toast.error('Não consegui recarregar', { description: message });
                      setError(message);
                    });
                }}
              >
                Recarregar
              </Button>

              <ConfirmButton
                variant="danger"
                disabled={busy}
                icon={null}
                label="Remover"
                confirmLabel="Remover mesmo"
                hint={`${plugin.name} é apagado do servidor e descarregado do Oxide.`}
                onConfirm={() => {
                  void agent
                    .removePlugin(serverId, plugin.name)
                    .then(() => {
                      toast.success(`${plugin.name} removido`);
                      return load();
                    })
                    .catch((cause: unknown) => {
                      const message = cause instanceof Error ? cause.message : String(cause);

                      toast.error('Não consegui remover', { description: message });
                      setError(message);
                    });
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
