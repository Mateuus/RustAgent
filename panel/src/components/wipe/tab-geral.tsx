'use client';

// ============================================================
//  tab-geral.tsx  -  "quando é o próximo, e o que ele leva?"
//
//  É a sub-aba de LEITURA: o admin abre, olha de relance e sabe
//  se anuncia o wipe hoje ou amanhã. Quem configura é a Agenda.
//
//  ####  ESTA TELA NÃO EXECUTA WIPE — E CONTINUA NÃO EXECUTANDO  ####
//
//  A faixa que dizia isso saiu quando a execução entrou, porque ela
//  tinha virado mentira: o agente zera o servidor sozinho agora.
//  Mas o BOTÃO continua não estando aqui, e de propósito: wipar
//  exige ver a lista de arquivos que vão sumir e digitar o identity
//  do servidor, e as duas coisas moram na sub-aba Execução, ao lado
//  do log e da retomada. Um botão vermelho no meio de uma tela de
//  leitura é clicado por reflexo.
//
//  ####  A CONTAGEM SAI DO RELÓGIO DO AGENTE  ####
//
//  Ver use-agent-clock.ts. O quadro ESTADO mostra a diferença
//  entre os dois relógios de propósito: é a única maneira de
//  alguém descobrir que o navegador dele está fora de hora antes
//  de brigar com a agenda.
// ============================================================

import { AlertTriangle, Check, Minus, ShieldCheck, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import {
  BP_POLICY_LABEL,
  COLLISION_LABEL,
  KIND_LABEL,
  MAP_SOURCE_LABEL,
  formatMoment,
  isPending,
  nextForcedWipe,
  nextWipe,
} from '@/components/wipe/labels';
import { describeSkew, formatCountdown, type AgentClock } from '@/components/wipe/use-agent-clock';
import type { ServerView, WipePlan, WipeSettings } from '@/lib/api';
import { EM_DASH } from '@/lib/format';

export interface TabGeralProps {
  readonly server: ServerView;
  readonly settings: WipeSettings;
  readonly plans: readonly WipePlan[];
  readonly clock: AgentClock;
  readonly busy: boolean;
  readonly onPostpone: (plan: WipePlan, hours: number) => void;
  readonly onSkip: (plan: WipePlan) => void;
}

export function TabGeral({
  server,
  settings,
  plans,
  clock,
  busy,
  onPostpone,
  onSkip,
}: TabGeralProps) {
  const now = clock.now;
  const next = now === null ? null : nextWipe(plans, now);
  const forced = now === null ? null : nextForcedWipe(plans, now);

  // O que ainda VAI acontecer. A janela lida traz também o passado
  // recente, e contar tudo faria a tela anunciar wipes que já
  // aconteceram como se estivessem marcados.
  const pendentes =
    now === null ? 0 : plans.filter((plan) => isPending(plan) && plan.scheduledAt >= now).length;

  // O forçado é o MESMO wipe que o próximo? Então os dois quadros
  // não repetem a mesma data com palavras diferentes.
  const nextIsForced = next !== null && forced !== null && next.id === forced.id;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Próximo wipe">
          {next === null ? (
            <StateBlock
              variant="empty"
              title="Nenhum wipe marcado."
              detail="Ligue a cadência na sub-aba Agenda, ou marque um wipe manual por lá. O wipe forçado da Facepunch entra sozinho assim que o agente materializar a agenda."
            />
          ) : (
            <div className="space-y-3">
              <Countdown target={next.scheduledAt} now={now} />

              <dl className="space-y-1 text-sm">
                <Row label="Quando" value={formatMoment(next.scheduledAt)} />
                <Row label="Tipo" value={KIND_LABEL[next.kind]} />
                <Row label="Blueprints" value={BP_POLICY_LABEL[next.bpPolicy]} />
                <Row
                  label="Mapa"
                  value={
                    MAP_SOURCE_LABEL[next.mapSource] +
                    (next.mapPoolId === null ? '' : ` (#${String(next.mapPoolId)})`)
                  }
                />
                {next.note !== null && <Row label="Anotação" value={next.note} />}
              </dl>

              <p className="text-2xs leading-relaxed text-muted">
                Qual mundo entra no lugar, com prévia e monumentos, é a sub-aba{' '}
                <strong>Mapas</strong>.
              </p>

              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  title="Empurra este wipe 24 horas para a frente. A data original não volta sozinha: o agente respeita o que foi mexido à mão."
                  onClick={() => {
                    onPostpone(next, 24);
                  }}
                >
                  Adiar 24 h
                </Button>

                {/* ####  O FORÇADO NÃO TEM BOTÃO DE PULAR  ####
                    Ele não é escolha nossa: sem zerar, o servidor
                    não sobe com o mundo antigo depois da
                    atualização mensal. Um botão que o agente
                    sempre recusa só ensinaria a ignorar recusa. */}
                {next.kind !== 'forced' && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    title="Este wipe não acontece. A cadência continua valendo para os seguintes."
                    onClick={() => {
                      onSkip(next);
                    }}
                  >
                    Pular este
                  </Button>
                )}
              </div>
            </div>
          )}
        </Section>

        <Section title="O que ele leva">
          {next === null ? (
            <StateBlock
              variant="empty"
              title="Sem wipe marcado, não há o que listar."
              detail="A lista sai da política do wipe que estiver marcado."
            />
          ) : (
            <div className="space-y-3">
              <ul className="space-y-1.5 text-sm">
                <Leva state="apaga" label="Mapa, construções e o que estava nelas" />
                <Leva state="apaga" label="Tela de morte (onde cada um morreu)" />
                <Leva state="apaga" label="Arquivos enviados: placas e imagens" />

                <Leva
                  state={next.bpPolicy === 'keep' ? 'mantem' : 'apaga'}
                  label={
                    next.bpPolicy === 'keep'
                      ? 'Blueprints — MANTIDOS, cada um recomeça sabendo o que já sabia'
                      : next.bpPolicy === 'wipe'
                        ? 'Blueprints — ZERADOS para todo mundo'
                        : 'Blueprints — zerados, e devolvidos a quem tem VIP'
                  }
                />

                <Leva state="mantem" label="Identidade do jogador: nome e SteamID" />
                <Leva
                  state="depende"
                  label="Dados de plugin (clãs, economia, VIP) — só no full wipe, por lista escolhida"
                />
              </ul>

              {next.bpPolicy === 'wipe_except_vip' && (
                <p className="flex items-start gap-2 border border-border bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-muted">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
                  <span>
                    Guardar e devolver blueprint de VIP depende da sub-aba{' '}
                    <strong>Blueprints</strong>, que ainda está sendo construída. Até ela entrar,
                    esta escolha declara a intenção — no jogo, o efeito é o de{' '}
                    <strong>zerar para todos</strong>.
                  </span>
                </p>
              )}

              {/* ####  ESTA LISTA AINDA NÃO FOI LIDA DO DISCO  ####
                  A lista definitiva vem de `GET /wipe/preview`, com
                  nome de arquivo e tamanho de verdade — é ela que
                  deixa alguém perceber que a identity aponta para o
                  servidor errado. Enquanto essa rota não existe, o
                  que está acima é a POLÍTICA, e a tela diz isso em
                  vez de fingir que conferiu a pasta. */}
              <p className="text-2xs leading-relaxed text-muted">
                Isto é o que a <strong>política</strong> deste wipe determina. A conferência contra
                a pasta <code>{server.paths.installDir}</code> — nome de arquivo e tamanho, lidos
                do disco antes de qualquer coisa ser apagada — entra com a sub-aba{' '}
                <strong>Execução</strong>.
              </p>
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Forçado (Facepunch)">
          {forced === null ? (
            <StateBlock
              variant="empty"
              title="O forçado ainda não está na agenda."
              detail="Ele acontece de qualquer forma — a primeira quinta de cada mês, às 19:00 UTC. Ele aparece aqui assim que o agente materializar a agenda deste servidor."
            />
          ) : (
            <div className="space-y-3">
              {!nextIsForced && <Countdown target={forced.scheduledAt} now={now} />}

              <dl className="space-y-1 text-sm">
                <Row label="Quando" value={formatMoment(forced.scheduledAt)} />
                <Row label="Regra" value="Primeira quinta do mês, 19:00 UTC" />
                <Row label="Blueprints" value={BP_POLICY_LABEL[settings.forced.bpPolicy]} />
                {nextIsForced && <Row label="Observação" value="é o próximo wipe" />}
              </dl>

              <p className="flex items-start gap-2 border border-border bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-muted">
                <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-olive" />
                <span>
                  Este acontece <strong>com ou sem o agente</strong>: a atualização mensal do Rust
                  muda o protocolo, e o mundo antigo não carrega mais. Não dá para desligá-lo — só
                  para escolher o que ele faz com os blueprints.
                </span>
              </p>
            </div>
          )}
        </Section>

        <Section title="Estado">
          <dl className="space-y-1 text-sm">
            <Row
              label="Processo"
              value={
                server.running === null
                  ? 'ainda não varremos'
                  : server.running
                    ? `no ar (pid ${String(server.pid ?? 0)})`
                    : 'parado'
              }
            />
            <Row
              label="RCON"
              value={
                server.rcon === null
                  ? 'o agente não cuida deste servidor'
                  : server.rcon.connected
                    ? 'conectado'
                    : `caído (${server.rcon.state})`
              }
            />
            <Row label="Relógio" value={describeSkew(clock.skewMs)} />
            <Row label="Na agenda" value={`${String(pendentes)} wipe(s) daqui para a frente`} />
            <Row
              label="Cadência"
              value={
                settings.cadence.enabled
                  ? `a cada ${String(settings.cadence.everyDays)} dia(s), às ${
                      settings.cadence.timeOfDay
                    } (${settings.cadence.timeZone})`
                  : 'desligada — só o forçado'
              }
            />
            <Row label="Se os dois colidirem" value={COLLISION_LABEL[settings.collision.policy]} />
          </dl>

          {/* O wipe lê a agenda do banco, não do jogo: com o
              servidor parado e o RCON caído esta tela continua
              valendo inteira. Dizer isso evita a conclusão de que
              a agenda "não está funcionando" porque o servidor
              está fora do ar. */}
          <p className="mt-3 text-2xs leading-relaxed text-muted">
            A agenda mora no banco do agente. Com o servidor parado ou o RCON caído, tudo aqui
            continua valendo — o que para é o aviso no chat, que precisa de alguém para ouvir.
          </p>
        </Section>
      </div>
    </div>
  );
}

/**
 * A contagem regressiva.
 *
 * Passado o instante, ela vira "já passou" em vez de números
 * negativos: um wipe atrasado dois minutos não é um wipe daqui a
 * menos dois minutos.
 */
function Countdown({ target, now }: { readonly target: number; readonly now: number | null }) {
  if (now === null) {
    return (
      <p className="font-condensed text-3xl font-bold tabular-nums text-muted">{EM_DASH}</p>
    );
  }

  const remaining = target - now;

  if (remaining <= 0) {
    return (
      <p className="font-condensed text-3xl font-bold uppercase tracking-wide text-amber">
        já passou
      </p>
    );
  }

  return (
    <p className="font-condensed text-3xl font-bold tabular-nums text-foreground">
      {formatCountdown(remaining)}
    </p>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-1 last:border-b-0">
      <dt className="shrink-0 text-2xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-foreground">{value}</dd>
    </div>
  );
}

/**
 * Uma linha do "o que ele leva".
 *
 * Ícone E palavra, nunca só a cor: "apaga" e "mantém" são o tipo
 * de par que ninguém pode ter de adivinhar pelo verde e pelo
 * vermelho.
 */
function Leva({
  state,
  label,
}: {
  readonly state: 'apaga' | 'mantem' | 'depende';
  readonly label: string;
}) {
  const icon: ReactNode =
    state === 'apaga' ? (
      <X aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-rust" />
    ) : state === 'mantem' ? (
      <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-olive" />
    ) : (
      <Minus aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
    );

  const prefix = state === 'apaga' ? 'Apaga: ' : state === 'mantem' ? 'Mantém: ' : 'Depende: ';

  return (
    <li className="flex items-start gap-2">
      {icon}
      <span className="min-w-0">
        <span className="sr-only">{prefix}</span>
        {label}
      </span>
    </li>
  );
}
