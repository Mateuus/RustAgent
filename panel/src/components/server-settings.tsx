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

import { useEffect, useState, type ReactNode } from 'react';

import { LoadoutPanel } from '@/components/loadout-panel';
import { OxidePanel } from '@/components/oxide-panel';
import { PluginConfigs } from '@/components/plugin-configs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
// O interruptor mora em ui\ porque a lista de plugins também o usa.
import { Toggle } from '@/components/ui/toggle';
import { agent, type ServerView } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const MAPS = ['Procedural Map', 'Barren', 'HapisIsland', 'Craggy Island'];

type Section =
  | 'geral'
  | 'mundo'
  | 'rede'
  | 'rcon'
  | 'steam'
  | 'plugins'
  | 'oxide'
  | 'loadouts'
  | 'avancado';

const SECTIONS: readonly { key: Section; label: string }[] = [
  { key: 'geral', label: 'Geral' },
  { key: 'mundo', label: 'Mundo' },
  { key: 'rede', label: 'Rede' },
  { key: 'rcon', label: 'RCON' },
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
  // ####  E O LOADOUT VEM LOGO DEPOIS DO OXIDE  ####
  //
  // A ordem é a da pergunta: na sub-aba Oxide se decide QUEM está
  // em cada grupo, e aqui o que cada grupo GANHA ao nascer. A
  // lista desta é derivada da daquela — grupo novo aparece aqui
  // vazio, sem ninguém precisar cadastrá-lo duas vezes.
  { key: 'loadouts', label: 'Loadouts' },
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
  onSave: () => void;
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

      <div className="flex justify-end border-t border-border px-4 py-3">
        <Button variant="primary" disabled={busy || disabled === true} onClick={onSave}>
          {busy ? 'Gravando…' : saveLabel}
        </Button>
      </div>
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

      {section === 'loadouts' && <LoadoutPanel serverId={server.id} />}

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
