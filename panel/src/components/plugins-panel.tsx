'use client';

// ============================================================
//  plugins-panel.tsx  -  o acervo deste servidor, e o que está
//  valendo nele.
//
//  ####  DUAS COLUNAS, PORQUE SÃO DUAS PERGUNTAS  ####
//
//    DISPONÍVEIS   o que dá para ligar aqui: a biblioteca do
//                  agente mais os plugins custom deste servidor
//    ATIVOS        o que está rodando agora
//
//  Numa lista só, com interruptor por linha, "o que está no ar?"
//  exigia varrer trinta linhas lendo o estado de cada uma. Separado,
//  a resposta é uma coluna — e ligar/desligar vira mover de lado, o
//  que é o gesto que a cabeça já faz.
//
//  ####  O UPLOAD AQUI É CUSTOM  ####
//
//  O `.cs` arrastado nesta tela entra como plugin DESTE servidor:
//  nenhum outro o enxerga, e ele não aparece na tela de rede. É o
//  evento de um fim de semana, o teste que não vai para os outros.
//  Para valer em todos, o lugar é Plugins na barra lateral.
//
//  ####  DESLIGAR NÃO APAGA A CONFIGURAÇÃO  ####
//
//  `oxide\config\<Nome>.json` fica onde está. A tela DIZ isso, e
//  não é zelo com o texto: sem essa frase, tirar um plugin para
//  testar parece uma decisão cara — e ninguém usa um botão do qual
//  tem medo.
// ============================================================

import { AlertTriangle, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { agent, type ServerPlugin } from '@/lib/api';
import { EM_DASH } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export function PluginsPanel({ serverId }: { serverId: string }) {
  const [plugins, setPlugins] = useState<ServerPlugin[] | null>(null);
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** O id do plugin em voo, ou `null`. Trava só a linha dele. */
  const [busy, setBusy] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  /** Os OUTROS servidores deste agente — a origem da cópia. */
  const [outros, setOutros] = useState<readonly string[]>([]);
  const [copySource, setCopySource] = useState('');
  const [copying, setCopying] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.serverPlugins(serverId);

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

  // Só os outros: copiar de si mesmo é a única origem que o agente
  // recusa, e oferecê-la seria oferecer um erro.
  useEffect(() => {
    void agent
      .servers()
      .then((response) => {
        setOutros(response.servers.map((server) => server.id).filter((id) => id !== serverId));
      })
      .catch(() => {
        // Sem a lista, a faixa de copiar não aparece. É o suficiente:
        // ela é atalho, e o resto da tela funciona sem ela.
        setOutros([]);
      });
  }, [serverId]);

  async function setEnabled(plugin: ServerPlugin, enabled: boolean, force = false): Promise<void> {
    setBusy(plugin.id);
    setNotice(null);

    try {
      const response = await agent.setServerPlugin(serverId, plugin.id, enabled, force);

      toast.success(response.message);

      // O que o Oxide respondeu fica NA TELA, e não no toast: é
      // onde aparece o erro de compilação, e esse precisa poder ser
      // lido com calma.
      if (response.reload.output !== null && response.reload.output.trim() !== '') {
        setNotice(`Oxide: ${response.reload.output}`);
      }

      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      toast.error(enabled ? 'Não consegui ligar' : 'Não consegui tirar', { description: message });
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Liga o plugin E o que falta, na ordem que o agente decide.
   *
   * A ordem mora no core de propósito: aqui ela não teria teste, e é
   * a diferença entre o conjunto entrar inteiro e o servidor passar
   * um intervalo com metade dele no ar.
   */
  async function enableWithDeps(plugin: ServerPlugin): Promise<void> {
    setBusy(plugin.id);
    setNotice(null);

    try {
      const response = await agent.enableWithDeps(serverId, plugin.id);

      toast.success(response.message);

      // O que o Oxide respondeu a CADA um: com três plugins ligados
      // de uma vez, "deu erro" sem dizer em qual não ajuda ninguém.
      const saida = response.reloads
        .filter((reload) => reload.output !== null && reload.output.trim() !== '')
        .map((reload) => `${reload.plugin}: ${String(reload.output)}`)
        .join('\n');

      if (saida !== '') {
        setNotice(saida);
      }

      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      toast.error('Não consegui ligar o conjunto', { description: message });
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Tira o custom do acervo deste servidor.
   *
   * `force` porque o botão já é uma confirmação em dois passos, e o
   * aviso dele diz o que se perde. Um segundo 409 aqui só faria a
   * pessoa clicar duas vezes na mesma decisão.
   */
  async function removeCustom(plugin: ServerPlugin): Promise<void> {
    setBusy(plugin.id);
    setNotice(null);

    try {
      const response = await agent.removePlugin(plugin.id, true);

      toast.success(response.message);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      toast.error('Não consegui remover', { description: message });
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  /** Liga aqui o mesmo conjunto que outro servidor usa. */
  async function copyFrom(): Promise<void> {
    if (copySource === '') return;

    setCopying(true);
    setNotice(null);

    try {
      const response = await agent.copyPluginsFrom(serverId, copySource);

      toast.success(`Plugins copiados de ${copySource}`, { description: response.message });

      // O que NÃO veio fica na tela, e não no toast: é a lista de
      // arquivos que ainda precisam ser enviados aqui, e ela precisa
      // poder ser lida com calma.
      if (response.skipped.length > 0) {
        setNotice(
          response.skipped.map((item) => `${item.plugin}: ${item.reason}`).join('\n'),
        );
      }

      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      toast.error('Não consegui copiar', { description: message });
      setError(message);
    } finally {
      setCopying(false);
    }
  }

  async function upload(file: File): Promise<void> {
    setUploading(true);
    setNotice(null);

    try {
      const response = await agent.uploadServerPlugin(serverId, file);

      toast.success(`${response.plugin.name} adicionado a este servidor`, {
        description:
          response.plugin.version === null ? undefined : `versão ${response.plugin.version}`,
      });

      setNotice(response.message);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      toast.error('O envio foi recusado', { description: message });
      setError(message);
    } finally {
      setUploading(false);
    }
  }

  const available = plugins?.filter((plugin) => !plugin.enabled) ?? [];
  const active = plugins?.filter((plugin) => plugin.enabled) ?? [];

  return (
    <div>
      {error !== null && <p className="mb-4 border border-rust bg-surface-2 p-3 text-sm">{error}</p>}

      {notice !== null && (
        <pre className="mb-4 whitespace-pre-wrap border border-border bg-surface-2 p-3 text-2xs">
          {notice}
        </pre>
      )}

      {plugins === null && error === null && (
        <StateBlock variant="loading" title="Lendo o acervo deste servidor…" />
      )}

      {plugins !== null && (
        // Empilha abaixo de lg: duas colunas numa tela estreita
        // deixariam cada linha com meia dúzia de caracteres úteis.
        <div className="grid gap-4 lg:grid-cols-2">
          <Column
            title="Disponíveis"
            count={available.length}
            hint="A biblioteca do agente e os plugins custom deste servidor."
          >
            <DropZone busy={uploading} onFile={(file) => void upload(file)} />

            {available.length === 0 && (
              <p className="px-4 py-6 text-center text-2xs text-muted">
                Nada a ligar. Arraste um <code>.cs</code> aqui, ou envie um em{' '}
                <strong>Plugins</strong>, na barra lateral, para deixá-lo disponível a todos os
                servidores.
              </p>
            )}

            {available.map((plugin) => (
              <AvailableRow
                key={plugin.id}
                plugin={plugin}
                busy={busy === plugin.id}
                onEnable={() => void setEnabled(plugin, true)}
                onEnableWithDeps={() => void enableWithDeps(plugin)}
                onRemove={() => void removeCustom(plugin)}
              />
            ))}
          </Column>

          <Column
            title="Ativos neste servidor"
            count={active.length}
            hint="O que o Oxide carrega. Tirar preserva a configuração do plugin."
          >
            {active.length === 0 && (
              <p className="px-4 py-6 text-center text-2xs text-muted">
                Nenhum plugin ativo. Ligue um da coluna ao lado — com o servidor parado, ele carrega
                no próximo start.
              </p>
            )}

            {active.map((plugin) => (
              <ActiveRow
                key={plugin.id}
                plugin={plugin}
                busy={busy === plugin.id}
                onApply={() => void setEnabled(plugin, true)}
                // `force` quando há dependentes: o botão já escreveu
                // quem cai junto, então a confirmação foi dada ali.
                onDisable={(force) => void setEnabled(plugin, false, force)}
              />
            ))}
          </Column>
        </div>
      )}

      {/* ####  UM SERVIDOR NOVO NÃO PODE SER SEIS CLIQUES  ####

          O "conjunto" aqui é um servidor que já funciona. Uma lista
          salva no banco envelheceria sozinha: no dia em que o
          servidor de verdade ganhasse o sétimo plugin, o conjunto
          continuaria com seis. */}
      {plugins !== null && outros.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border border-border bg-surface p-3">
          <p className="min-w-0 flex-1 text-2xs leading-relaxed text-muted">
            <strong className="text-foreground">Copiar de outro servidor.</strong> Liga aqui os
            mesmos plugins que outro servidor usa, com as dependências na ordem certa. A
            configuração de cada um não vem junto — ela é de lá.
          </p>

          <select
            value={copySource}
            onChange={(event) => setCopySource(event.target.value)}
            className="h-8 border border-border bg-surface-2 px-2 text-2xs text-foreground"
          >
            <option value="">escolha o servidor…</option>
            {outros.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>

          <Button
            size="sm"
            variant="outline"
            disabled={copying || copySource === ''}
            onClick={() => void copyFrom()}
          >
            {copying ? 'Copiando…' : 'Copiar plugins'}
          </Button>
        </div>
      )}

      <p className="mt-3 text-2xs leading-relaxed text-muted">
        Tirar um plugin descarrega e apaga o <code>.cs</code> deste servidor, mas{' '}
        <strong>preserva a configuração dele</strong> (<code>oxide\config\&lt;Nome&gt;.json</code> e{' '}
        <code>oxide\data\</code>) — voltar atrás não custa o que você ajustou.
      </p>

      {dir !== '' && <p className="mt-1 truncate text-2xs text-muted">{dir}</p>}
    </div>
  );
}

function Column({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count: number;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-border bg-surface">
      <header className="border-b border-border px-4 py-2">
        <h3 className="font-condensed text-sm font-bold uppercase tracking-wide">
          {title} <span className="text-muted">({count})</span>
        </h3>
        <p className="mt-0.5 text-2xs text-muted">{hint}</p>
      </header>

      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

/**
 * A área de arrastar-e-soltar.
 *
 * Também é um botão: arrastar não é descobrível sozinho, e num
 * navegador com a janela pequena chega a ser incômodo. O clique
 * abre o seletor de sempre.
 */
function DropZone({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  return (
    <div className="p-3">
      <input
        ref={input}
        type="file"
        accept=".cs"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];

          if (file !== undefined) {
            onFile(file);
          }

          event.target.value = '';
        }}
      />

      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        // `preventDefault` no dragOver é o que faz o navegador
        // aceitar o drop: sem ele, soltar o arquivo abre o `.cs`
        // numa aba nova e o painel some da tela.
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);

          const file = event.dataTransfer.files[0];

          if (file !== undefined) {
            onFile(file);
          }
        }}
        className={cn(
          'flex w-full flex-col items-center gap-1 border border-dashed px-4 py-5 text-center transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          over ? 'border-amber bg-surface-2' : 'border-border hover:border-muted',
        )}
      >
        <Upload aria-hidden="true" className={cn('h-4 w-4', over ? 'text-amber' : 'text-muted')} />
        <span className="font-condensed text-2xs font-bold uppercase tracking-wide">
          {busy ? 'Enviando…' : 'Arraste um .cs aqui, ou clique'}
        </span>
        <span className="text-2xs text-muted">
          Entra como plugin <strong>custom deste servidor</strong> — os outros não o veem.
        </span>
      </button>
    </div>
  );
}

/** Nome, versão e de onde o plugin vem. Comum às duas colunas. */
function PluginIdentity({ plugin }: { plugin: ServerPlugin }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm">
        {plugin.title ?? plugin.name} <span className="text-muted">v{plugin.version ?? EM_DASH}</span>
      </p>

      <p className="truncate text-2xs text-muted">
        {plugin.serverId === null ? 'biblioteca' : 'custom deste servidor'} ·{' '}
        {plugin.author ?? EM_DASH} · {(plugin.bytes / 1024).toFixed(1)} KB
      </p>
    </div>
  );
}

function AvailableRow({
  plugin,
  busy,
  onEnable,
  onEnableWithDeps,
  onRemove,
}: {
  plugin: ServerPlugin;
  busy: boolean;
  onEnable: () => void;
  /** Liga este e as dependências que faltam, na ordem do agente. */
  onEnableWithDeps: () => void;
  /** Só para o custom deste servidor. Ver o botão. */
  onRemove: () => void;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <PluginIdentity plugin={plugin} />

        <div className="flex shrink-0 items-start gap-2">
          {/* ####  O CUSTOM SAI POR AQUI, E SÓ POR AQUI  ####

              Ele é deste servidor: nenhuma outra tela o enxerga, e
              sem este botão um custom que ninguém mais usa ficaria
              na coluna de disponíveis para sempre.

              O da BIBLIOTECA não tem botão aqui de propósito —
              removê-lo tira de todos os servidores, e essa decisão
              é da tela de rede, onde se vê quem usa o quê. */}
          {plugin.serverId !== null && (
            <ConfirmButton
              variant="danger"
              disabled={busy}
              icon={null}
              label="Remover"
              confirmLabel="Apagar o .cs"
              hint="Apaga o .cs deste servidor e tira o plugin do acervo. A configuração em oxide\config fica."
              onConfirm={onRemove}
            />
          )}

          <Button size="sm" disabled={busy || plugin.blockedBy !== null} onClick={onEnable}>
            {busy ? 'Ligando…' : 'Ligar'}
          </Button>
        </div>
      </div>

      {/* ####  O HOMÔNIMO JÁ OCUPA O LUGAR  ####

          Os dois gravariam o mesmo `<Nome>.cs` e o Oxide carrega um
          só. Sem esta frase, o botão desabilitado seria um mistério
          — e a pessoa tentaria de novo achando que travou. */}
      {plugin.blockedBy !== null && (
        <p className="mt-2 text-2xs leading-relaxed text-amber">
          Já há um <strong>{plugin.name}</strong> ligado neste servidor, vindo{' '}
          {plugin.blockedBy === 'biblioteca' ? 'da biblioteca' : 'dos plugins custom daqui'}. Tire
          aquele para poder ligar este.
        </p>
      )}

      {/* ####  LIGAR NÃO BASTA: FALTA DE QUEM ELE DEPENDE  ####

          O Oxide segura o plugin até a dependência aparecer. Ligar
          é permitido — o que não pode é a tela dizer "ativo" e nada
          acontecer no jogo, sem explicação. */}
      {plugin.blockedBy === null && plugin.missingRequires.length > 0 && (
        <div className="mt-2 space-y-2">
          <p className="text-2xs leading-relaxed text-muted">
            Depende de <strong>{plugin.missingRequires.join(', ')}</strong>, que não está ligado
            aqui. Dá para ligar assim mesmo — o Oxide só o carrega quando a dependência entrar.
          </p>

          {/* ####  RESOLVER É MELHOR QUE AVISAR  ####

              Avisar e deixar a pessoa ligar três plugins na mão, na
              ordem certa, é passar a regra para quem não a conhece.
              O agente sabe a ordem: dependência primeiro. */}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEnableWithDeps}>
            {busy ? 'Ligando…' : `Ligar junto com ${plugin.missingRequires.join(', ')}`}
          </Button>
        </div>
      )}
    </div>
  );
}

function ActiveRow({
  plugin,
  busy,
  onApply,
  onDisable,
}: {
  plugin: ServerPlugin;
  busy: boolean;
  onApply: () => void;
  onDisable: (force: boolean) => void;
}) {
  const { hard, soft } = plugin.dependents;
  const arrastaOutros = hard.length > 0 || soft.length > 0;
  const naoCompilou = plugin.lastReload?.failed === true;

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <PluginIdentity plugin={plugin} />

        {/* ####  TIRAR ESTE MEXE EM OUTROS  ####

            Com dependentes, o botão vira confirmação em dois passos
            e o aviso diz os NOMES de quem cai. Sem isso, tirar o
            OrigemZAgent derrubaria três plugins em silêncio — e o
            sintoma apareceria no jogo, sem nada ligando uma coisa à
            outra. */}
        {arrastaOutros ? (
          <ConfirmButton
            variant="danger"
            disabled={busy}
            icon={null}
            label="Tirar"
            confirmLabel="Tirar mesmo"
            hint={[
              hard.length > 0 ? `${hard.join(', ')} sai do ar junto.` : null,
              soft.length > 0 ? `${soft.join(', ')} perde a parte que usa este.` : null,
            ]
              .filter((parte): parte is string => parte !== null)
              .join(' ')}
            onConfirm={() => onDisable(true)}
          />
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onDisable(false)}>
            {busy ? 'Tirando…' : 'Tirar'}
          </Button>
        )}
      </div>

      {/* Quem depende dele fica visível ANTES de alguém pensar em
          tirar: descobrir a dependência no meio da confirmação é
          tarde para quem estava só olhando a lista. */}
      {arrastaOutros && (
        <p className="mt-2 text-2xs leading-relaxed text-muted">
          {hard.length > 0 && (
            <>
              <strong>{hard.join(', ')}</strong> {hard.length > 1 ? 'dependem' : 'depende'} deste
              para carregar.{' '}
            </>
          )}
          {soft.length > 0 && <>{soft.join(', ')} usa este quando ele está no ar.</>}
        </p>
      )}

      {/* ####  ATIVO NÃO É O MESMO QUE RODANDO  ####

          O arquivo está no lugar, o interruptor diz "ativo" — e o
          Oxide recusou o plugin. Antes, isso voltava dentro do
          `reload.output`, num bloco de dez linhas que rolava para
          fora da tela: quem clicou ia embora achando que aplicou, e
          o sintoma aparecia no jogo horas depois.

          A frase do compilador fica junto porque é ela que diz a
          LINHA do erro — e é o que se manda para quem escreveu o
          plugin. */}
      {naoCompilou && (
        <div className="mt-3 border border-rust bg-surface-2 p-3">
          <p className="flex items-start gap-2 text-2xs font-bold leading-relaxed text-rust">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              O Oxide não conseguiu carregar este plugin. Ele está no servidor, mas não está
              rodando.
            </span>
          </p>

          {plugin.lastReload?.output !== null && plugin.lastReload !== null && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-3xs leading-relaxed text-muted">
              {plugin.lastReload.output}
            </pre>
          )}
        </div>
      )}

      {/* ####  O sha256 DIVERGIU  ####

          O acervo tem uma versão e este servidor está com outra.
          Sem este aviso, a única pista seria a versão da tela de
          rede não bater com a de cá — e ninguém compara duas
          telas. */}
      {plugin.updateAvailable && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border border-amber bg-surface-2 p-3">
          <p className="flex min-w-0 items-start gap-2 text-2xs leading-relaxed">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
            <span>
              O acervo tem uma versão diferente da que está neste servidor. Aplicar recopia o
              arquivo e manda o Oxide recarregar.
            </span>
          </p>

          <Button size="sm" variant="primary" disabled={busy} onClick={onApply}>
            {busy ? 'Aplicando…' : 'Aplicar atualização'}
          </Button>
        </div>
      )}
    </div>
  );
}
