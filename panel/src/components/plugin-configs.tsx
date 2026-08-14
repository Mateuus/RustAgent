'use client';

// ============================================================
//  plugin-configs.tsx  -  o `oxide\config\<Nome>.json` de cada
//  plugin, editável aqui.
//
//  ####  O QUE ISTO SUBSTITUI  ####
//
//  Abrir `Servers\<id>\oxide\config\OrigemZVip.json` no Bloco de
//  Notas, na máquina onde o servidor mora, e depois lembrar de
//  mandar `oxide.reload OrigemZVip` — senão nada acontece. As duas
//  metades andam juntas aqui: gravar recarrega.
//
//  ------------------------------------------------------------
//  ####  UM EDITOR DE TEXTO, E NÃO UM FORMULÁRIO  ####
//
//  A tentação é gerar campos a partir do JSON. Não dá: a estrutura
//  muda por plugin, e um formulário gerado erra em qualquer coisa
//  aninhada — a lista de itens da loja, o mapa de permissões por
//  nível. O que ele mostraria seria uma versão empobrecida do
//  arquivo, e o que ele gravasse de volta seria pior.
//
//  O que a tela DEVE fazer é não deixar gravar lixo: o
//  `JSON.parse` roda a cada tecla, a mensagem dele (que diz a
//  posição) fica à vista, e o botão de gravar só vale enquanto o
//  texto for válido. JSON quebrado não derruba a tela — derruba o
//  plugin, no servidor, com os jogadores dentro.
//
//  ------------------------------------------------------------
//  ####  O TEXTO QUE VOLTA NÃO É O QUE FOI ENVIADO  ####
//
//  Vários plugins chamam `SaveConfig()` ao carregar e reescrevem a
//  própria config, normalizando o que leram — campo que faltava
//  aparece com o padrão, ordem muda, número vira decimal. Por isso a
//  tela adota o texto que o AGENTE devolveu depois do reload. Manter
//  o que a pessoa digitou faria a tela afirmar uma coisa que o
//  arquivo em disco não diz mais.
// ============================================================

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { agent, type PluginConfigSummary } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** A mensagem do `JSON.parse`, ou `null` se o texto está bom. */
function jsonError(text: string): string | null {
  if (text.trim() === '') {
    return 'A configuração está vazia. Para voltar ao padrão do plugin, use o botão de restaurar.';
  }

  try {
    JSON.parse(text);

    return null;
  } catch (error) {
    // A posição é a parte útil: quem procura a vírgula sobrando em
    // 200 linhas precisa saber onde o parser desistiu.
    return error instanceof Error ? error.message : String(error);
  }
}

function Etiqueta({ children, tone }: { children: string; tone: 'muted' | 'amber' }) {
  return (
    <span
      className={cn(
        'border px-1.5 py-0.5 font-condensed text-3xs font-bold uppercase tracking-wide',
        tone === 'amber' ? 'border-amber text-amber' : 'border-border text-muted',
      )}
    >
      {children}
    </span>
  );
}

export function PluginConfigs({ serverId }: { serverId: string }) {
  const [configs, setConfigs] = useState<readonly PluginConfigSummary[]>([]);
  const [configDir, setConfigDir] = useState('');
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState<string | null>(null);
  /** O texto do editor. */
  const [text, setText] = useState('');
  /** O que o agente devolveu por último — a régua do "mudou?". */
  const [stored, setStored] = useState('');
  const [busy, setBusy] = useState(false);
  /** O que o Oxide respondeu ao último reload. */
  const [output, setOutput] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await agent.pluginConfigs(serverId);

      setConfigs(response.configs);
      setConfigDir(response.configDir);
    } catch (cause) {
      toast.error('Não consegui listar as configurações', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Trocar de servidor sem largar o arquivo aberto mostraria a config
  // de um servidor com o nome do outro.
  useEffect(() => {
    setSelected(null);
    setText('');
    setStored('');
    setOutput(null);
  }, [serverId]);

  async function open(plugin: string): Promise<void> {
    setSelected(plugin);
    setOutput(null);
    setBusy(true);

    try {
      const response = await agent.pluginConfig(serverId, plugin);
      const conteudo = response.config?.text ?? '';

      setText(conteudo);
      setStored(conteudo);

      if (response.message !== null) {
        toast.info(plugin, { description: response.message });
      }
    } catch (cause) {
      toast.error(`Não consegui abrir a configuração de ${plugin}`, {
        description: cause instanceof Error ? cause.message : String(cause),
      });
      setSelected(null);
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (selected === null) return;

    setBusy(true);

    try {
      const response = await agent.savePluginConfig(serverId, selected, text);
      // Ver o cabeçalho: o que vale é o que ficou em disco.
      const conteudo = response.config?.text ?? '';

      setText(conteudo);
      setStored(conteudo);
      setOutput(response.reload.output);

      toast.success(`Configuração de ${selected} gravada`, { description: response.message });
      await refresh();
    } catch (cause) {
      toast.error('Não consegui gravar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function reset(): Promise<void> {
    if (selected === null) return;

    setBusy(true);

    try {
      const response = await agent.resetPluginConfig(serverId, selected);
      const conteudo = response.config?.text ?? '';

      setText(conteudo);
      setStored(conteudo);
      setOutput(response.reload.output);

      toast.success(`Configuração de ${selected} restaurada`, { description: response.message });
      await refresh();
    } catch (cause) {
      toast.error('Não consegui restaurar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  const erro = jsonError(text);
  const mudou = text !== stored;
  const atual = configs.find((config) => config.plugin === selected);

  if (loading) {
    return <p className="text-sm text-muted">Lendo a pasta de configuração…</p>;
  }

  if (configs.length === 0) {
    return (
      <div className="border border-border bg-surface p-4">
        <p className="text-sm">Nenhuma configuração nesta pasta ainda.</p>
        <p className="mt-2 text-2xs leading-relaxed text-muted">
          Quem cria o <code>{'<Nome>.json'}</code> é o próprio plugin, no primeiro carregamento, com
          os padrões dele. Ligue um plugin na aba Plugins e suba o servidor — o arquivo aparece
          aqui.
        </p>
        <p className="mt-2 break-all text-2xs text-muted">{configDir}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="break-all text-2xs text-muted">{configDir}</p>

      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        {/* A lista vem da PASTA: a config sobrevive ao plugin, e a
            órfã é justamente a que alguém foi procurar. */}
        <ul className="divide-y divide-border border border-border bg-surface">
          {configs.map((config) => (
            <li key={config.plugin}>
              <button
                type="button"
                onClick={() => void open(config.plugin)}
                className={cn(
                  'w-full px-3 py-2 text-left',
                  selected === config.plugin ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
              >
                <span className="block truncate font-condensed text-sm font-bold">
                  {config.plugin}
                </span>

                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  {!config.inStore && <Etiqueta tone="amber">fora do acervo</Etiqueta>}
                  {config.inStore && !config.enabled && <Etiqueta tone="muted">desligado</Etiqueta>}
                  <span className="text-3xs text-muted">{formatBytes(config.bytes)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {selected === null ? (
          <div className="border border-border bg-surface p-4">
            <p className="text-sm text-muted">
              Escolha um plugin na lista para editar a configuração dele.
            </p>
          </div>
        ) : (
          <div className="border border-border bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <h3 className="font-condensed text-sm font-bold uppercase tracking-wide">
                {selected}.json
              </h3>

              {atual !== undefined && !atual.enabled && (
                <span className="text-2xs text-amber">
                  {atual.inStore
                    ? 'Este plugin está desligado aqui — o que você gravar vale quando ele for ligado.'
                    : 'Este plugin não está no acervo deste servidor. O arquivo continua editável.'}
                </span>
              )}
            </div>

            <div className="space-y-3 p-4">
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                spellCheck={false}
                rows={22}
                className="w-full resize-y border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed text-foreground"
              />

              {erro !== null && (
                <p className="border border-danger bg-surface-2 p-3 font-mono text-2xs leading-relaxed text-danger">
                  {erro}
                </p>
              )}

              {output !== null && output !== '' && (
                <div>
                  <p className="mb-1 font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                    O que o Oxide respondeu
                  </p>
                  {/* É aqui que aparece o campo que o plugin esperava
                      e não veio — o erro que a validação de sintaxe
                      não pega. */}
                  <pre className="max-h-48 overflow-auto border border-border bg-surface-2 p-3 font-mono text-2xs leading-relaxed">
                    {output}
                  </pre>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
              <ConfirmButton
                variant="danger"
                disabled={busy}
                icon={null}
                label="Voltar ao padrão"
                confirmLabel="Apagar a configuração"
                hint="Apaga o arquivo. O plugin o recria com os padrões dele — o que foi ajustado aqui se perde. Há cópia em Backups\\<id>\\oxide-config."
                onConfirm={() => void reset()}
              />

              <Button
                variant="primary"
                disabled={busy || erro !== null || !mudou}
                onClick={() => void save()}
              >
                {busy ? 'Gravando…' : mudou ? 'Gravar e recarregar' : 'Sem mudanças'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
