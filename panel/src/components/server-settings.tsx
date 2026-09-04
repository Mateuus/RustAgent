'use client';

// ============================================================
//  server-settings.tsx  -  a configuração daquele servidor.
//
//  Tudo o que mora no `Configs\<id>.ini`, separado por assunto.
//  Antes cada opção estava numa tela diferente (a janela de
//  console na Visão, o mapa em lugar nenhum) — e configuração
//  espalhada é a que ninguém acha na hora.
//
//  ####  O QUE SÓ VALE NO PRÓXIMO START  ####
//
//  Quase tudo. Um mundo já carregado não muda de mapa nem de
//  seed, e uma janela não aparece num processo que já está no ar.
//  O agente responde com `requiresRestart`, e a tela mostra isso
//  em vez de dizer "salvo" e deixar a pessoa concluindo que não
//  funcionou.
//
//  ####  E O QUE NÃO ESTÁ AQUI  ####
//
//  O `id` e a `identity`. O id nomeia o arquivo, as pastas e todo
//  o histórico daquele servidor; a identity nomeia a pasta de
//  saves DENTRO da instalação — trocá-la é começar um mundo novo.
//  Nenhum dos dois é campo de formulário: são operações, e cada
//  uma precisa mover coisa em disco.
// ============================================================

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { OxidePanel } from '@/components/oxide-panel';
import { PlayerPanel } from '@/components/player-panel';
import { ServerUiPanel } from '@/components/server-ui-panel';
import { PluginConfigs } from '@/components/plugin-configs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
// O interruptor mora em ui\ porque a lista de plugins também o usa.
import { Toggle } from '@/components/ui/toggle';
import {
  agent,
  type ServerView,
  type SiteConfig,
  type SiteStatus,
  type SiteVipMirrorView,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const MAPS = ['Procedural Map', 'Barren', 'HapisIsland', 'Craggy Island'];

type Section =
  | 'geral'
  | 'mundo'
  | 'rede'
  | 'rcon'
  | 'site'
  | 'steam'
  | 'plugins'
  | 'oxide'
  | 'interface'
  | 'player'
  | 'avancado';

const SECTIONS: readonly { key: Section; label: string }[] = [
  { key: 'geral', label: 'Geral' },
  { key: 'mundo', label: 'Mundo' },
  { key: 'rede', label: 'Rede' },
  { key: 'rcon', label: 'RCON' },
  { key: 'site', label: 'Site OrigemZ' },
  { key: 'steam', label: 'SteamCMD' },
  // ####  A CONFIGURAÇÃO DOS PLUGINS MORA AQUI, E NÃO NA ABA
  //       PLUGINS  ####
  //
  // A aba Plugins responde "o que este servidor usa" — liga,
  // desliga, aplica a versão nova. Isto aqui é configuração, que é o
  // assunto desta aba: o `oxide\config\<Nome>.json` fica ao lado do
  // mundo, das portas e do SteamCMD, que é onde se procura ajuste.
  { key: 'plugins', label: 'Plugins' },
  // ####  E O OXIDE FICA AO LADO DELA  ####
  //
  // A sub-aba Plugins ajusta o `.json` de CADA plugin; esta ajusta
  // o que o Oxide sabe sobre PESSOAS — os grupos, quem está neles
  // e o que cada um concede. É onde o VIP de fato acontece: o
  // nível é um grupo, e o plugin só o cria.
  { key: 'oxide', label: 'Oxide' },
  // ####  E A INTERFACE FECHA O TRIO  ####
  //
  // O DESENHO do menu é da rede e mora em /interface. Aqui está o
  // que é DESTE servidor: qual menu ele usa e o que ele esconde
  // dele — a mesma natureza das outras sub-abas, que ajustam este
  // servidor e não a rede.
  { key: 'interface', label: 'Interface' },
  // ####  E O JOGADOR VEM LOGO DEPOIS DO OXIDE  ####
  //
  // A ordem é a da pergunta: na sub-aba Oxide se decide QUEM está
  // em cada grupo, e aqui o que muda para quem está nele — o que
  // ele ganha ao nascer (Loadouts), em que estado acorda (Status) e
  // quanto tempo as coisas levam para ele (Timers). A lista das
  // três é derivada da daquela: grupo novo aparece aqui vazio, sem
  // ninguém precisar cadastrá-lo duas vezes.
  { key: 'player', label: 'Player' },
  { key: 'avancado', label: 'Avançado' },
];

/** O que o formulário edita. Espelha o corpo do PATCH. */
interface Draft {
  name: string;
  hostname: string;
  description: string;
  url: string;
  headerImage: string;
  map: string;
  seed: number;
  worldSize: number;
  maxPlayers: number;
  saveInterval: number;
  gamePort: number;
  queryPort: number;
  appPort: number;
  rconPort: number;
  steamAppId: string;
  steamLogin: string;
  steamBranch: string;
}

function draftOf(server: ServerView): Draft {
  return {
    name: server.name,
    hostname: server.hostname,
    description: server.description,
    url: server.url,
    headerImage: server.headerImage,
    map: server.map,
    seed: server.seed,
    worldSize: server.worldSize,
    maxPlayers: server.maxPlayers,
    saveInterval: server.saveInterval,
    gamePort: server.ports.game,
    queryPort: server.ports.query,
    appPort: server.ports.app,
    rconPort: server.ports.rcon,
    steamAppId: server.steam.appId,
    steamLogin: server.steam.login,
    steamBranch: server.steam.branch === 'public' ? '' : server.steam.branch,
  };
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint !== undefined && <p className="mt-1 text-2xs leading-relaxed text-muted">{hint}</p>}
    </div>
  );
}

function Card({
  title,
  warning,
  children,
  busy,
  disabled,
  saveLabel = 'Gravar',
  onSave,
}: {
  title: string;
  warning?: string;
  children: ReactNode;
  busy: boolean;
  disabled?: boolean;
  saveLabel?: string;
  /**
   * Ausente = cartão só de LEITURA, e o rodapé some junto.
   *
   * Um botão "Gravar" num cartão que não grava nada é pior que
   * nenhum botão: ele convida a clicar e não faz nada.
   */
  onSave?: () => void;
}) {
  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2">
        <h3 className="font-condensed text-sm font-bold uppercase tracking-wide">{title}</h3>
      </div>

      <div className="space-y-4 p-4">
        {warning !== undefined && (
          <p className="border border-amber bg-surface-2 p-3 text-2xs leading-relaxed">{warning}</p>
        )}

        {children}
      </div>

      {onSave !== undefined && (
        <div className="flex justify-end border-t border-border px-4 py-3">
          <Button variant="primary" disabled={busy || disabled === true} onClick={onSave}>
            {busy ? 'Gravando…' : saveLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

export function ServerSettings({
  server,
  onChanged,
}: {
  server: ServerView;
  onChanged: () => void;
}) {
  const [section, setSection] = useState<Section>('geral');
  const [draft, setDraft] = useState<Draft>(() => draftOf(server));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  // O polling da página traz o servidor a cada 5 s. Recarregar o
  // rascunho a cada volta apagaria o que a pessoa está digitando —
  // então ele só é refeito quando MUDA DE SERVIDOR.
  const serverId = server.id;

  useEffect(() => {
    setPassword('');
  }, [serverId]);

  async function save(patch: Record<string, unknown>, what: string): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.patchServer(server.id, patch);

      toast.success(`${what} gravado`, { description: response.message });
      onChanged();
    } catch (cause) {
      toast.error(`Não consegui gravar: ${what.toLowerCase()}`, {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* As sub-abas. Pílulas, e não a mesma barra sublinhada das
          abas de cima: dois níveis com o mesmo desenho fazem a
          pessoa perder de vista onde está. */}
      <div className="flex flex-wrap items-stretch border border-border bg-surface">
        {SECTIONS.map((item, index) => (
          <div key={item.key} className="flex items-stretch">
            {/* A divisória entre as seções, pela mesma razão das
                abas de cima: sem ela, seis rótulos em maiúsculas
                viram uma faixa contínua de texto. */}
            {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

            <button
              type="button"
              onClick={() => setSection(item.key)}
              className={cn(
                'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                section === item.key
                  ? 'bg-surface-2 text-foreground'
                  : 'text-muted hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>

      {section === 'geral' && (
        <Card
          title="Identificação"
          busy={busy}
          onSave={() =>
            void save(
              {
                name: draft.name,
                hostname: draft.hostname,
                description: draft.description,
                url: draft.url,
                headerImage: draft.headerImage,
              },
              'Identificação',
            )
          }
        >
          <Field label="Nome no painel" hint="Só o painel usa. Não aparece no jogo.">
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>

          <Field
            label="Hostname"
            hint="O que o jogador lê na lista de servidores do Rust. Vale no próximo start."
          >
            <Input
              value={draft.hostname}
              onChange={(event) => setDraft({ ...draft, hostname: event.target.value })}
            />
          </Field>

          <Field label="Descrição" hint="Aparece no menu do servidor, dentro do jogo.">
            <textarea
              value={draft.description}
              rows={3}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              className="w-full border border-border bg-surface-2 px-3 py-2 text-sm text-foreground"
            />
          </Field>

          <Field label="Site" hint="O botão de site no menu do servidor. Vazio não envia nada.">
            <Input
              value={draft.url}
              placeholder="https://…"
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            />
          </Field>

          <Field
            label="Imagem de cabeçalho"
            hint="512×256 px, servida por HTTP. Vazio não envia nada."
          >
            <Input
              value={draft.headerImage}
              placeholder="https://…/header.png"
              onChange={(event) => setDraft({ ...draft, headerImage: event.target.value })}
            />
          </Field>
        </Card>
      )}

      {section === 'mundo' && (
        <Card
          title="O mundo"
          busy={busy}
          warning="Mapa, seed e tamanho só valem num mundo NOVO. Trocar qualquer um deles e reiniciar equivale a um wipe de mapa — as construções somem."
          onSave={() =>
            void save(
              {
                map: draft.map,
                seed: draft.seed,
                worldSize: draft.worldSize,
                maxPlayers: draft.maxPlayers,
                saveInterval: draft.saveInterval,
              },
              'O mundo',
            )
          }
        >
          <Field label="Mapa">
            <select
              value={draft.map}
              onChange={(event) => setDraft({ ...draft, map: event.target.value })}
              className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
            >
              {MAPS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Seed" hint="0 a 2147483647. Mesma seed + mesmo tamanho = o mesmo mapa.">
            <Input
              type="number"
              value={draft.seed}
              onChange={(event) => setDraft({ ...draft, seed: Number(event.target.value) })}
            />
          </Field>

          <Field
            label="Tamanho do mundo"
            hint="1000 a 6000. Maior é mais para explorar — e minutos a mais para gerar a cada start."
          >
            <Input
              type="number"
              min={1000}
              max={6000}
              value={draft.worldSize}
              onChange={(event) => setDraft({ ...draft, worldSize: Number(event.target.value) })}
            />
          </Field>

          <Field label="Máximo de jogadores">
            <Input
              type="number"
              min={1}
              max={1000}
              value={draft.maxPlayers}
              onChange={(event) => setDraft({ ...draft, maxPlayers: Number(event.target.value) })}
            />
          </Field>

          <Field
            label="Intervalo do save (segundos)"
            hint="É o que se perde num 'parar à força' ou numa queda. 300 s é o padrão do Rust."
          >
            <Input
              type="number"
              min={30}
              max={86400}
              value={draft.saveInterval}
              onChange={(event) => setDraft({ ...draft, saveInterval: Number(event.target.value) })}
            />
          </Field>
        </Card>
      )}

      {section === 'rede' && (
        <Card
          title="Portas"
          busy={busy}
          warning="As quatro andam juntas, em blocos espaçados de 100. Repetir uma porta de outro servidor não dá erro na tela: o segundo carrega o mundo inteiro e fica sem aparecer na lista da Steam."
          onSave={() =>
            void save(
              {
                gamePort: draft.gamePort,
                queryPort: draft.queryPort,
                appPort: draft.appPort,
                rconPort: draft.rconPort,
              },
              'As portas',
            )
          }
        >
          <Field label="Jogo (UDP)">
            <Input
              type="number"
              value={draft.gamePort}
              onChange={(event) => setDraft({ ...draft, gamePort: Number(event.target.value) })}
            />
          </Field>

          <Field label="Query / Steam (UDP)" hint="Precisa ser diferente da porta do jogo.">
            <Input
              type="number"
              value={draft.queryPort}
              onChange={(event) => setDraft({ ...draft, queryPort: Number(event.target.value) })}
            />
          </Field>

          <Field
            label="Companion / Rust+ (TCP)"
            hint="Com mais de um servidor na máquina ela deixa de ser opcional: os dois tentariam o 28082 padrão e o companion do segundo ficaria mudo, sem erro nenhum."
          >
            <Input
              type="number"
              value={draft.appPort}
              onChange={(event) => setDraft({ ...draft, appPort: Number(event.target.value) })}
            />
          </Field>

          <Field label="RCON (TCP)">
            <Input
              type="number"
              value={draft.rconPort}
              onChange={(event) => setDraft({ ...draft, rconPort: Number(event.target.value) })}
            />
          </Field>
        </Card>
      )}

      {section === 'rcon' && (
        <Card
          title="Senha do RCON"
          busy={busy}
          warning="Quem tem esta senha executa QUALQUER comando neste servidor. Trocá-la vale no próximo start do jogo — os dois lados precisam do mesmo valor."
          saveLabel="Trocar a senha"
          disabled={password.trim().length < 8}
          onSave={() => {
            void save({ rconPassword: password }, 'A senha do RCON').then(() => setPassword(''));
          }}
        >
          <Field
            label="Nova senha"
            hint={
              <>
                Mínimo 8 caracteres. Não pode conter <code>/ \ ? #</code> nem espaço: o WebRCON
                transporta a senha no caminho da URL, e o Rust compara o caminho cru.
              </>
            }
          >
            <Input
              type="text"
              value={password}
              placeholder="deixe em branco para manter a atual"
              onChange={(event) => setPassword(event.target.value)}
              className="font-mono"
            />
          </Field>
        </Card>
      )}

      {section === 'site' && <SitePanel server={server} onChanged={onChanged} />}

      {section === 'steam' && (
        <Card
          title="SteamCMD"
          busy={busy}
          onSave={() =>
            void save(
              {
                steamAppId: draft.steamAppId,
                steamLogin: draft.steamLogin,
                steamBranch: draft.steamBranch,
              },
              'O SteamCMD',
            )
          }
        >
          <Field label="AppID" hint="258550 é o servidor dedicado do Rust — não é o AppID do jogo.">
            <Input
              value={draft.steamAppId}
              onChange={(event) => setDraft({ ...draft, steamAppId: event.target.value })}
            />
          </Field>

          <Field label="Login" hint="O dedicado do Rust é gratuito: login anônimo.">
            <Input
              value={draft.steamLogin}
              onChange={(event) => setDraft({ ...draft, steamLogin: event.target.value })}
            />
          </Field>

          <Field
            label="Branch"
            hint="Vazio = a pública, que é o que você quer. 'staging' baixa a versão de testes da Facepunch — ela quebra plugin com frequência."
          >
            <Input
              value={draft.steamBranch}
              placeholder="(pública)"
              onChange={(event) => setDraft({ ...draft, steamBranch: event.target.value })}
            />
          </Field>
        </Card>
      )}

      {section === 'plugins' && <PluginConfigs serverId={server.id} />}

      {section === 'oxide' && <OxidePanel serverId={server.id} />}

      {section === 'interface' && <ServerUiPanel serverId={server.id} />}
      {section === 'player' && <PlayerPanel serverId={server.id} />}

      {section === 'avancado' && (
        <div className="space-y-4">
          <div className="border border-border bg-surface p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-condensed text-sm font-bold uppercase tracking-wide">
                  Janela de console do jogo
                </p>
                <p className="mt-1 text-sm text-muted">
                  {server.consoleWindow
                    ? 'O servidor sobe numa janela própria, visível na barra de tarefas.'
                    : 'O servidor sobe sem janela. O log vai para o arquivo e para a aba Console.'}
                </p>
              </div>

              <Toggle
                on={server.consoleWindow}
                busy={busy}
                onChange={(value) => void save({ consoleWindow: value }, 'A janela de console')}
              />
            </div>

            {server.consoleWindow && (
              <p className="mt-3 border border-amber bg-surface-2 p-3 text-2xs leading-relaxed">
                <strong>Cuidado com o clique.</strong> O console do Windows vem com o Modo de
                Edição Rápida ligado: clicar dentro da janela põe o console em seleção e{' '}
                <strong>congela o servidor</strong> — com os jogadores dentro — até alguém apertar
                Enter ali.
              </p>
            )}
          </div>

          <div className="border border-border bg-surface p-4">
            <p className="font-condensed text-sm font-bold uppercase tracking-wide">
              O agente cuida deste servidor
            </p>
            <p className="mt-1 text-sm text-muted">
              {server.enabled
                ? 'O agente mantém o RCON e aceita operações. É o normal.'
                : 'O agente ignora este servidor: sem RCON, sem operações além de instalar.'}
            </p>

            <div className="mt-3 flex items-center justify-between gap-4">
              <p className="text-2xs leading-relaxed text-muted">
                Depois de instalar, o agente adota o servidor sozinho. Desligue só para fazer
                manutenção com ele fora do caminho.
              </p>

              <Toggle
                on={server.enabled}
                busy={busy}
                labels={['Cuidando', 'Ignorando']}
                onChange={(value) => void save({ enabled: value }, 'Cuidar do servidor')}
              />
            </div>
          </div>

          <dl className="divide-y divide-border border border-border bg-surface text-sm">
            {(
              [
                ['id', server.id],
                ['identity (pasta de saves)', server.identity],
                ['arquivo de configuração', server.paths.configPath],
                ['instalação', server.paths.installDir],
                ['logs', server.paths.logsDir],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex gap-4 px-4 py-2">
                <dt className="w-56 shrink-0 text-muted">{label}</dt>
                <dd className="min-w-0 break-all">{value}</dd>
              </div>
            ))}
          </dl>

          <p className="text-2xs leading-relaxed text-muted">
            O <code>id</code> e a <code>identity</code> não se editam aqui: o id nomeia o arquivo,
            as pastas e todo o histórico deste servidor, e a identity nomeia a pasta de saves —
            trocá-la é começar um mundo novo. Os dois são operações que movem coisa em disco, não
            campos de formulário.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * O painel do site OrigemZ, dentro da aba Configuração.
 *
 * Três coisas em ordem de dependência, e a ordem é o ensino:
 *
 *   1. o ENDEREÇO do site — global do agente, um só para todos;
 *   2. o PAREAMENTO deste servidor — id lá, e o bearer;
 *   3. o ESTADO — está conectado? desde quando? o que falhou?
 *
 * Sem (1) nada acontece; sem (2) este servidor não cobra; e (3) é a
 * primeira tela de "a loja parou", porque "o agente está pending",
 * "o token foi rotacionado" e "o site caiu" produzem o MESMO sintoma
 * para o jogador.
 */
function SitePanel({ server, onChanged }: { server: ServerView; onChanged: () => void }) {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [status, setStatus] = useState<SiteStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [siteServerId, setSiteServerId] = useState(server.site.serverId);
  const [siteToken, setSiteToken] = useState('');
  /** O token recém-gerado. Ele aparece UMA vez, e some ao sair. */
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const serverId = server.id;

  const load = useCallback((): void => {
    void agent.siteConfig().then((value) => {
      setConfig(value);
      setBaseUrl(value.baseUrl);
    });
    void agent.siteStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    load();
    setSiteToken('');
    setFresh(null);
    setSiteServerId(server.site.serverId);
    // `server.site` fora das deps: o polling traz o servidor a cada
    // 5 s, e relê-lo aqui apagaria o que a pessoa está digitando.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, load]);

  const mine = status?.servers.find((item) => item.serverId === serverId) ?? null;

  async function run(what: string, action: () => Promise<{ message?: string }>): Promise<void> {
    setBusy(true);

    try {
      const response = await action();

      toast.success(`${what} gravado`, { description: response.message });
      load();
      onChanged();
    } catch (cause) {
      toast.error(`Não consegui gravar: ${what.toLowerCase()}`, {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card
        title="Endereço do site"
        busy={busy}
        saveLabel="Gravar endereço"
        onSave={() => void run('O endereço do site', () => agent.saveSiteConfig(baseUrl))}
      >
        <Field
          label="URL do site"
          hint={
            <>
              Só o endereço, <strong>sem o /api no fim</strong> — o agente acrescenta{' '}
              <code>/api/agent/…</code> sozinho. Vale para <strong>todos</strong> os servidores
              deste agente: o site é um só. Vazio desliga a integração inteira.
              {config?.source === 'env' && config.envBaseUrl !== null && (
                <> Hoje ele vem do <code>.env</code> da instalação.</>
              )}
            </>
          }
        >
          <Input
            type="text"
            value={baseUrl}
            placeholder="https://origemznetwork.com"
            onChange={(event) => setBaseUrl(event.target.value)}
            className="font-mono"
          />
        </Field>

        {config?.restartPending === true && (
          <p className="border border-amber bg-surface-2 p-3 text-2xs leading-relaxed">
            <strong>Gravado, e ainda não em uso.</strong> O agente está falando com{' '}
            <code>{config.activeBaseUrl === '' ? '(nenhum site)' : config.activeBaseUrl}</code>{' '}
            até o próximo restart — o cliente, o beacon e a fila de cada servidor são
            montados no boot, a partir deste valor.
          </p>
        )}
      </Card>

      <Card
        title="Pareamento deste servidor"
        busy={busy}
        warning="Este bearer move o saldo de QUALQUER jogador no site — trate-o como segredo de dinheiro, não de configuração. Colar, gerar ou trocar vale a partir do próximo restart do AGENTE."
        saveLabel="Gravar pareamento"
        disabled={siteServerId.trim() === '' && siteToken.trim() === ''}
        onSave={() =>
          void run('O pareamento', () =>
            agent.patchServer(server.id, {
              siteServerId: siteServerId.trim(),
              // Campo vazio = manter o que está lá. Só um valor
              // digitado substitui o bearer — senão, salvar o id
              // apagaria o token sem ninguém pedir.
              ...(siteToken.trim() === '' ? {} : { siteToken: siteToken.trim() }),
            }),
          ).then(() => setSiteToken(''))
        }
      >
        <Field
          label="ID do servidor no site"
          hint={
            <>
              O id que <strong>este</strong> servidor tem no site, e não o daqui (
              <code>{server.id}</code>). Ele casa por texto exato, maiúsculas incluídas.
            </>
          }
        >
          <Input
            type="text"
            value={siteServerId}
            placeholder="RUST01"
            onChange={(event) => setSiteServerId(event.target.value)}
            className="font-mono"
          />
        </Field>

        <Field
          label="Bearer"
          hint={
            <>
              Gere aqui e <strong>cole no cadastro deste servidor no site</strong> — é o mesmo
              caminho que o painel do Conan usa. Ele{' '}
              <strong>nunca volta</strong> para esta tela: quem perder a janela gera outro, e o
              anterior deixa de valer assim que o site aceitar o novo.{' '}
              {server.site.hasToken
                ? 'Há um token gravado; deixe em branco para mantê-lo.'
                : 'Ainda NÃO há token: a loja deste servidor continua na carteira local.'}
            </>
          }
        >
          <div className="flex gap-2">
            <Input
              type="password"
              value={siteToken}
              placeholder={
                server.site.hasToken ? 'deixe em branco para manter o atual' : 'cole ou gere'
              }
              onChange={(event) => setSiteToken(event.target.value)}
              className="font-mono"
            />
            <Button
              disabled={busy}
              onClick={() =>
                void run('O token novo', async () => {
                  const created = await agent.generateSiteToken(server.id);

                  setFresh(created.token);
                  setSiteToken('');

                  return created;
                })
              }
            >
              Gerar
            </Button>
          </div>
        </Field>

        {fresh !== null && (
          <div className="mx-4 mb-4 border border-rust bg-surface-2 p-3">
            <p className="mb-2 text-2xs font-bold uppercase tracking-wide text-rust">
              Copie agora — ele não aparece de novo
            </p>
            <code className="block break-all font-mono text-sm">{fresh}</code>
            <p className="mt-2 text-2xs leading-relaxed text-muted">
              Já está gravado aqui. Cole-o no cadastro deste servidor no site e reinicie o agente.
            </p>
          </div>
        )}
      </Card>

      <Card title="Estado" busy={false}>
        {status === null ? (
          <p className="px-4 pb-4 text-sm text-muted">Não consegui ler o estado da integração.</p>
        ) : mine === null ? (
          <p className="px-4 pb-4 text-sm text-muted">
            Este servidor não está pareado: sem <code>SITE_SERVER_ID</code>, o agente não fala com o
            site por ele, e a loja usa a carteira local.
          </p>
        ) : (
          <>
            {mine.status === 'restart-pending' && (
              <p className="mx-4 mb-4 border border-amber bg-surface-2 p-3 text-2xs leading-relaxed">
                <strong>O pareamento está gravado e ainda não está em uso.</strong> O beacon, a
                carteira e a fila deste servidor são montados no <strong>boot</strong> do
                agente — reinicie-o para ele começar a falar com o site. Até lá, a loja
                continua na carteira local.
              </p>
            )}
          <dl className="pb-2 text-sm">
            <StatusRow
              label="Pareamento"
              value={PAIRING_LABEL[mine.status] ?? mine.status}
              tone={mine.status === 'active' ? 'ok' : 'warn'}
            />
            <StatusRow label="ID no site" value={mine.siteServerId || '—'} />
            <StatusRow
              label="Token"
              value={mine.hasToken ? 'gravado' : 'ausente'}
              tone={mine.hasToken ? 'ok' : 'warn'}
            />
            <StatusRow
              label="Último beacon"
              value={mine.lastBeaconAt === null ? 'nunca' : new Date(mine.lastBeaconAt).toLocaleString('pt-BR')}
              tone={mine.lastBeaconAt === null ? 'warn' : 'ok'}
            />
            {mine.lastBeaconError !== null && (
              <StatusRow
                label="Erro do beacon"
                value={`${mine.lastBeaconErrorCode ?? ''} ${mine.lastBeaconError}`.trim()}
                tone="bad"
              />
            )}
            <StatusRow
              label="Carteira"
              value={
                mine.wallet.source === 'local'
                  ? 'local (o saldo é do banco deste agente)'
                  : mine.wallet.lastOkAt === null
                    ? 'do site, ainda sem resposta'
                    : `do site, última resposta em ${new Date(mine.wallet.lastOkAt).toLocaleString('pt-BR')}`
              }
              tone={mine.wallet.source === 'remote' && mine.wallet.lastError !== null ? 'warn' : 'ok'}
            />
            {mine.wallet.lastError !== null && (
              <StatusRow label="Erro da carteira" value={mine.wallet.lastError} tone="bad" />
            )}
            <StatusRow
              label="Compras presas"
              value={
                `${String(status.purchases.chargeUnknown)} indeterminada(s) · ` +
                `${String(status.purchases.pendingOrphan)} órfã(s) · ` +
                `${String(status.purchases.unprovable)} sem prova`
              }
              tone={
                status.purchases.chargeUnknown + status.purchases.unprovable > 0 ? 'warn' : 'ok'
              }
            />
            <StatusRow
              label="Espelho de VIP"
              value={vipMirrorLabel(status.vipMirror, serverId)}
              // `routeMissing` fica em AMARELO, e não em vermelho: o
              // trabalho está na fila do site, e pintar de defeito
              // faria alguém procurar conserto aqui.
              tone={
                status.vipMirror.inSync === true
                  ? 'ok'
                  : status.vipMirror.routeMissing || !status.vipMirror.running
                    ? 'warn'
                    : status.vipMirror.lastPushError === null
                      ? 'warn'
                      : 'bad'
              }
            />
          </dl>
          </>
        )}

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button onClick={() => load()}>Atualizar</Button>
          <Button
            // Sem pareamento carregado não há beacon para forçar:
            // o botão diria "não pareado" num servidor que está
            // gravado e só esperando restart.
            disabled={busy || mine === null || mine.status === 'restart-pending'}
            onClick={() =>
              void run('O beacon', async () => {
                await agent.forceSiteBeacon(server.id);

                return { message: 'Batida enviada.' };
              })
            }
          >
            Beaconar agora
          </Button>
        </div>
      </Card>
    </div>
  );
}

/**
 * O espelho de VIP em uma frase.
 *
 * ####  A CONTAGEM VEM ANTES DO RESTO  ####
 *
 * "12 VIPs" é a única parte que alguém consegue conferir olhando a
 * lista de VIPs ao lado. Um hash e um horário não se conferem contra
 * nada — eles servem para o depois, quando já se desconfia de algo.
 *
 * A data é a do ESTE servidor (`mirrored`), e não a do último push
 * global: com N pareamentos, o push que saiu há um minuto pode ter
 * sido para outro, e mostrar o global diria "em dia" para um destino
 * que está dias atrás.
 */
function vipMirrorLabel(mirror: SiteVipMirrorView, serverId: string): string {
  if (!mirror.running) {
    return 'não construído — o site não sabe quem tem VIP no jogo';
  }

  const count = `${String(mirror.count ?? 0)} VIP(s)`;

  if (mirror.routeMissing) {
    return `${count} — o site ainda não tem a rota; nada a fazer aqui`;
  }

  const at = mirror.mirrored.find((entry) => entry.serverId === serverId)?.at ?? null;

  if (mirror.inSync === true) {
    return at === null
      ? `${count}, em dia`
      : `${count}, confirmado em ${new Date(at).toLocaleString('pt-BR')}`;
  }

  return `${count} — ${mirror.reason ?? 'ainda não confirmado pelo site'}`;
}

/** O que cada estado de pareamento quer dizer, em português. */
const PAIRING_LABEL: Readonly<Record<string, string>> = {
  active: 'ativo — a loja cobra no site',
  'restart-pending': 'gravado — falta reiniciar o agente',
  pending: 'pendente — falta ativar este agente no site',
  banned: 'banido — o site recusou este agente',
  orphan: 'órfão — o site não conhece este ID',
  unknown: 'desconhecido — ainda não houve batida',
};

function StatusRow({
  label,
  value,
  tone = 'ok',
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  return (
    <div className="flex gap-4 px-4 py-1.5">
      <dt className="w-40 shrink-0 text-muted">{label}</dt>
      <dd
        className={cn(
          'min-w-0 break-all',
          tone === 'warn' && 'text-amber',
          tone === 'bad' && 'text-rust',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
