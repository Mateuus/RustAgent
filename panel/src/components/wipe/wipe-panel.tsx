'use client';

// ============================================================
//  wipe-panel.tsx  -  a aba WIPE da página do servidor.
//
//  ####  SEIS SUB-ABAS, E CADA UMA RESPONDE UMA PERGUNTA  ####
//
//    Geral         quando é o próximo, e o que ele leva?
//    Agenda        com que frequência, e o que já está marcado?
//    Mapas         qual mundo entra no lugar, e como ele é?
//    Blueprints    quem recomeça sabendo o quê?
//    Configuração  como o agente executa: avisa, espera, apaga o quê?
//    Execução      o que aconteceu, passo a passo?
//
//  As seis estão montadas. Cada uma entrou trocando UMA linha lá
//  embaixo, no bloco dos pontos de montagem — que é o que permitiu
//  quatro frentes construírem sub-abas diferentes sem se
//  encontrarem neste arquivo.
//
//  ####  ELA CARREGA OS DADOS, AS SUB-ABAS SÓ DESENHAM  ####
//
//  A configuração e a agenda são as mesmas para Geral e Agenda.
//  Buscá-las duas vezes daria duas verdades na mesma tela — a
//  contagem regressiva de um quadro discordando da lista do outro
//  ao lado.
//
//  ####  POR QUE NÃO HÁ POLLING AQUI  ####
//
//  A agenda mora no banco do agente e só muda quando alguém a
//  muda: salvar a cadência, adiar, pular. Cada uma dessas ações já
//  recarrega. O que precisa andar de segundo em segundo é a
//  contagem regressiva, e ela anda com o relógio projetado (ver
//  use-agent-clock.ts) sem custar uma requisição por segundo.
// ============================================================

import { useCallback, useEffect, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { TabAgenda } from '@/components/wipe/tab-agenda';
import { TabBlueprints } from '@/components/wipe/tab-blueprints';
import { TabConfiguracao } from '@/components/wipe/tab-configuracao';
import { TabExecucao } from '@/components/wipe/tab-execucao';
import { TabGeral } from '@/components/wipe/tab-geral';
import { TabMapas } from '@/components/wipe/tab-mapas';
import { useAgentClock } from '@/components/wipe/use-agent-clock';
import {
  agent,
  type BpPolicy,
  type ServerView,
  type WipePlan,
  type WipeSettings,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Os ids são o contrato entre as frentes que constroem as
 * sub-abas. Sem acento e sem espaço: eles viajam em `data-`,
 * em chave de reação e (um dia) em query string.
 */
export type WipeTab = 'geral' | 'agenda' | 'mapas' | 'blueprints' | 'configuracao' | 'execucao';

const TABS: readonly { readonly id: WipeTab; readonly label: string }[] = [
  { id: 'geral', label: 'Geral' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'mapas', label: 'Mapas' },
  { id: 'blueprints', label: 'Blueprints' },
  { id: 'configuracao', label: 'Configuração' },
  { id: 'execucao', label: 'Execução' },
];

/**
 * A janela da agenda que a tela lê.
 *
 * Trinta dias para trás para o histórico recente aparecer na grade
 * do mês, e cento e oitenta para a frente porque o agente
 * materializa cerca de noventa — a janela cobre tudo o que existe,
 * com folga, numa requisição só.
 */
const PAST_MS = 30 * 24 * 60 * 60 * 1_000;
const FUTURE_MS = 180 * 24 * 60 * 60 * 1_000;

export function WipePanel({ server }: { readonly server: ServerView }) {
  const [tab, setTab] = useState<WipeTab>('geral');

  const [settings, setSettings] = useState<WipeSettings | null>(null);
  const [plans, setPlans] = useState<readonly WipePlan[]>([]);
  /** O `now` da última resposta do agente. Alimenta o relógio. */
  const [sample, setSample] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const clock = useAgentClock(sample);
  const serverId = server.id;

  const load = useCallback(async () => {
    // A faixa é calculada com o relógio local de propósito: aqui
    // ela é só um recorte de busca, e não a hora de um wipe. Quem
    // não pode sair do relógio do agente é a contagem regressiva.
    const from = Date.now() - PAST_MS;
    const to = Date.now() + FUTURE_MS;

    try {
      const response = await agent.wipeSettings(serverId);

      setSettings(response.settings);
      setSample(response.now);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }

    try {
      const response = await agent.wipePlans(serverId, { from, to });

      setPlans(response.plans);
      setSample(response.now);
      setPlanError(null);
    } catch (cause) {
      // A agenda é o segundo pedido: sem ela a configuração ainda
      // vale, e a tela diz que não conseguiu ler as datas em vez
      // de mostrar uma agenda vazia que pareceria "não há wipes".
      setPlanError(cause instanceof Error ? cause.message : String(cause));
      setPlans([]);
    }

    setLoading(false);
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Toda ação segue o mesmo caminho: agir, avisar, reler. */
  const run = useCallback(
    async (what: string, action: () => Promise<{ readonly ok: true; readonly message?: string }>) => {
      setBusy(true);

      try {
        const response = await action();

        toast.success(what, { description: response.message });
        await load();
      } catch (cause) {
        toast.error(`Não deu: ${what.toLowerCase()}`, {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const saveSettings = useCallback(
    (next: WipeSettings) => {
      void run('Calendário salvo', () => agent.saveWipeSettings(serverId, next));
    },
    [run, serverId],
  );

  const postpone = useCallback(
    (plan: WipePlan, hours: number) => {
      void run(`Wipe adiado ${String(hours)} h`, () =>
        agent.updateWipePlan(serverId, plan.id, {
          scheduledAt: plan.scheduledAt + hours * 60 * 60 * 1_000,
        }),
      );
    },
    [run, serverId],
  );

  const skip = useCallback(
    (plan: WipePlan) => {
      void run('Wipe pulado', () => agent.removeWipePlan(serverId, plan.id));
    },
    [run, serverId],
  );

  const create = useCallback(
    (input: { scheduledAt: number; bpPolicy: BpPolicy; note: string | null }) => {
      void run('Wipe manual marcado', () => agent.createWipePlan(serverId, input));
    },
    [run, serverId],
  );

  return (
    <div className="space-y-4">
      {/* Pílulas, e não a barra sublinhada das abas de cima: dois
          níveis com o mesmo desenho fazem a pessoa perder de vista
          onde está. É o mesmo padrão das sub-abas de Configurações. */}
      <div
        role="tablist"
        aria-label="Seções do wipe"
        className="flex flex-wrap items-stretch border border-border bg-surface"
      >
        {TABS.map((item, index) => (
          // `presentation` na divisória: sem ele, o <div> ficaria
          // entre o tablist e os tabs na árvore de acessibilidade,
          // e o leitor de tela deixaria de anunciar "aba 3 de 6".
          <div key={item.id} role="presentation" className="flex items-stretch">
            {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

            <button
              type="button"
              role="tab"
              id={`wipe-tab-${item.id}`}
              aria-selected={tab === item.id}
              onClick={() => {
                setTab(item.id);
              }}
              className={cn(
                'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                tab === item.id ? 'bg-surface-2 text-foreground' : 'text-muted hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>

      <div role="tabpanel" aria-labelledby={`wipe-tab-${tab}`} className="space-y-4">
        {loading && settings === null && error === null && (
          <StateBlock variant="loading" title="Consultando o agente…" />
        )}

        {error !== null && (
          <StateBlock
            variant="error"
            title="Não consegui ler o calendário deste servidor."
            detail={error}
          />
        )}

        {planError !== null && settings !== null && (
          <StateBlock
            variant="error"
            title="Não consegui ler as datas marcadas."
            detail={
              <>
                {planError} A configuração abaixo continua valendo — o que está faltando é a lista
                do que já foi materializado.
              </>
            }
          />
        )}

        {settings !== null && tab === 'geral' && (
          <TabGeral
            server={server}
            settings={settings}
            plans={plans}
            clock={clock}
            busy={busy}
            onPostpone={postpone}
            onSkip={skip}
          />
        )}

        {settings !== null && tab === 'agenda' && (
          <TabAgenda
            settings={settings}
            plans={plans}
            clock={clock}
            busy={busy}
            onSave={saveSettings}
            onPostpone={postpone}
            onSkip={skip}
            onCreate={create}
          />
        )}

        {/* ####  OS PONTOS DE MONTAGEM DAS OUTRAS FRENTES  ####

            Cada linha abaixo é de outra frente, e cada uma é UMA
            linha de propósito: quem construir a sub-aba troca o
            <EmConstrucao/> pelo componente dela e não encosta em
            mais nada deste arquivo. Mapas, Configuração e Execução
            já entraram assim.

            E as duas últimas carregam os PRÓPRIOS dados, em vez de
            recebê-los daqui: a lista de arquivos que o wipe vai
            apagar é lida do disco a cada abertura, e o log de uma
            execução em curso anda de dois em dois segundos — nada
            disso é a agenda, que este componente carrega uma vez. */}

        {tab === 'mapas' && <TabMapas serverId={serverId} />}
        {tab === 'blueprints' && <TabBlueprints serverId={serverId} />}
        {tab === 'configuracao' && <TabConfiguracao serverId={serverId} />}
        {tab === 'execucao' && <TabExecucao serverId={serverId} />}
      </div>
    </div>
  );
}

/*  ####  NÃO HÁ MAIS SUB-ABA EM CONSTRUÇÃO  ####

    As seis estão montadas. O bloco que dizia "esta parte está
    sendo construída" saiu junto com a última delas (Blueprints):
    deixá-lo aqui sem ninguém para mostrar seria código morto num
    arquivo que quatro frentes leem para saber onde encaixar a
    delas.  */
