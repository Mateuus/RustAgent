'use client';

// ============================================================
//  wipe-panel.tsx  -  a casca da aba WIPE, com as seis sub-abas.
//
//  Cada uma responde uma pergunta diferente, e é por isso que são
//  seis e não uma tela só (ver Docs\16 §9.1):
//
//      Geral        quando é o próximo, e o que ele leva?
//      Agenda       com que frequência, e o que já está marcado?
//      Mapas        qual mundo entra no lugar, e como ele é?
//      Blueprints   quem recomeça sabendo o quê?
//      Configuração como o agente executa — avisa, espera, apaga?
//      Execução     o que aconteceu, passo a passo?
//
//  ------------------------------------------------------------
//  ####  AS QUE AINDA NÃO EXISTEM DIZEM QUE NÃO EXISTEM  ####
//
//  A regra da casa é que aba nova não abre vazia: uma tela em
//  branco promete o que não há, e quem clica fica esperando um
//  carregamento que nunca vem. Enquanto a frente de cada sub-aba
//  não entra, ela mostra o que vai ser e por que ainda não é.
//
//  A alternativa — esconder as abas não prontas — foi descartada
//  de propósito: o mapa da tela mudaria a cada semana, e ninguém
//  conseguiria dizer onde uma coisa vai estar.
// ============================================================

import {
  CalendarDays,
  ClipboardList,
  Gauge,
  Map,
  PlayCircle,
  SlidersHorizontal,
} from 'lucide-react';
import { useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { TabMapas } from '@/components/wipe/tab-mapas';

type SubTab = 'geral' | 'agenda' | 'mapas' | 'blueprints' | 'configuracao' | 'execucao';

/**
 * A ordem é a do uso, e não a da construção: quem abre a aba
 * quer primeiro saber quando é o próximo wipe, e só depois mexer
 * em como ele acontece.
 */
const SUB_TABS = [
  { key: 'geral', label: 'Geral', Icon: Gauge },
  { key: 'agenda', label: 'Agenda', Icon: CalendarDays },
  { key: 'mapas', label: 'Mapas', Icon: Map },
  { key: 'blueprints', label: 'Blueprints', Icon: ClipboardList },
  { key: 'configuracao', label: 'Configuração', Icon: SlidersHorizontal },
  { key: 'execucao', label: 'Execução', Icon: PlayCircle },
] as const;

/** O que cada sub-aba ainda não construída vai responder. */
const EM_CONSTRUCAO: Readonly<Record<Exclude<SubTab, 'mapas'>, string>> = {
  geral:
    'Aqui vai ficar a contagem regressiva para o próximo wipe, com o que ele leva (mapa, tela ' +
    'de morte, blueprints) lido do disco — e não um texto fixo dizendo o que deveria estar lá.',
  agenda:
    'Aqui vai ficar a cadência (a cada N dias, no horário e no fuso que o dono escolher), o ' +
    'wipe forçado da Facepunch e o calendário dos próximos 90 dias.',
  blueprints:
    'Aqui vai ficar o que acontece com o que o jogador aprendeu: manter, apagar, ou devolver a ' +
    'quem tem VIP — com a régua por nível e o atraso em horas.',
  configuracao:
    'Aqui vai ficar como o agente executa o wipe: os avisos antes, o tempo de esvaziar, o ' +
    'backup, e a lista explícita de dados de plugin do full wipe.',
  execucao:
    'Aqui vai ficar o passo a passo de cada wipe — avisar, esvaziar, parar, backup, apagar, ' +
    'configurar, subir, pós-wipe — com o log e o botão de retomar do passo que falhou.',
};

export function WipePanel({ serverId }: { readonly serverId: string }) {
  const [tab, setTab] = useState<SubTab>('geral');

  return (
    <div className="space-y-4">
      {/* A mesma faixa de abas da página do servidor, um nível
          abaixo: divisória vertical entre os alvos de clique, e o
          sublinhado marcando o ativo. */}
      <nav className="flex overflow-x-auto border-b border-border">
        {SUB_TABS.map(({ key, label, Icon }, index) => (
          <div key={key} className="flex shrink-0 items-stretch">
            {index > 0 && <span aria-hidden className="my-2 w-px bg-border" />}

            <button
              type="button"
              onClick={() => setTab(key)}
              className={
                'flex items-center gap-2 px-4 py-2 text-sm ' +
                (tab === key
                  ? 'border-b-2 border-rust text-foreground'
                  : 'border-b-2 border-transparent text-muted hover:text-foreground')
              }
            >
              <Icon aria-hidden="true" className={'h-4 w-4' + (tab === key ? ' text-rust' : '')} />
              {label}
            </button>
          </div>
        ))}
      </nav>

      {tab === 'mapas' ? (
        <TabMapas serverId={serverId} />
      ) : (
        <StateBlock variant="empty" title="Ainda em construção" detail={EM_CONSTRUCAO[tab]} />
      )}
    </div>
  );
}
