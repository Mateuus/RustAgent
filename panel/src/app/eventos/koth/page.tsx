'use client';

// ============================================================
//  /eventos/koth  -  O DOMÍNIO DE TERRITÓRIO.
//
//  ####  DUAS ABAS, E A PRIMEIRA JÁ FUNCIONA  ####
//
//    Ao vivo       as vagas, e o que está de pé agora
//    Territórios   onde o KOTH pode acontecer, marcados no mapa
//    O que falta   as frentes que ainda não existem, na ordem
//
//  "Ao vivo" vem primeiro porque é a pergunta que se faz com mais
//  frequência — "tem KOTH acontecendo?" —, e cadastrar território é
//  coisa que se faz uma vez.
//
//  A segunda aba não é enfeite: metade desta família ainda não foi
//  escrita, e uma tela que escondesse isso faria o admin cadastrar
//  territórios esperando recompensa automática — que não existe.
//
//  ####  NADA DE FORMULÁRIO DE MENTIRA  ####
//
//  Campo que salva numa tabela que ninguém lê é pior que campo
//  nenhum: alguém preenche, fecha, e espera o evento acontecer.
//
//  ####  A ORDEM DA LISTA NÃO É DECORATIVA  ####
//
//  É a ordem em que as coisas dependem umas das outras: sem equipe
//  com nome não há placar de quem está ganhando; sem território
//  cadastrado não há onde nascer; sem barra na tela o jogador não
//  sabe que está capturando. Ver Docs/KOTH/ e Docs/OrigemZTeam/.
// ============================================================

import { ArrowLeft, Flag } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { ArenasPanel } from '@/components/koth/arenas-panel';
import { LivePanel } from '@/components/koth/live-panel';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { agent } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function KothPage() {
  return (
    <RequireSession>
      <Koth />
    </RequireSession>
  );
}

/** Uma frente do KOTH, e onde ela está. */
interface Frente {
  readonly title: string;
  readonly detail: string;
  /** `true` = já existe algo funcionando hoje. */
  readonly done: boolean;
}

const FRENTES: readonly Frente[] = [
  {
    title: 'Equipe com nome (OrigemZTeam)',
    detail:
      'O KOTH pontua por LADO, e um lado sem nome não aparece em placar nenhum. O nome da equipe já é do agente, editável na aba Equipes do servidor.',
    done: true,
  },
  {
    title: 'Territórios no mapa',
    detail:
      'Onde o domínio acontece: centro, raio, altura, tempo de captura e duração. É o cadastro próprio desta família — o ponto da masmorra não serve, ele não tem volume.',
    done: true,
  },
  {
    title: 'A captura, no servidor do jogo',
    detail:
      'Quem está dentro, quem contesta, quanto o progresso sobe e quanto ele decai. É conta do plugin — painel e cliente só mostram.',
    done: true,
  },
  {
    title: 'A barra na tela de quem joga',
    detail:
      'Ela enche para quem está dentro, diz quem domina e avisa quem está sem equipe. Falta o placar dos lados quando há disputa.',
    done: true,
  },
  {
    title: 'A bandeira do território',
    detail:
      'Um Large Banner on pole no centro, indestrutível. Falta trocar a textura dela pela da equipe que domina — o que depende de medir se dá para fazer isso sem recriar a bandeira.',
    done: true,
  },
  {
    title: 'A agenda própria',
    detail:
      'O KOTH tem relógio: ele sorteia um território ligado e ergue sozinho, respeitando as VAGAS do servidor e adiando enquanto houver masmorra de pé.',
    done: true,
  },
  {
    title: 'Recompensas e entrega',
    detail:
      'OZCoins, troféus, kits, VIP e itens, com registro de entrega individual para não pagar duas vezes nem esquecer ninguém. Hoje o agente registra quem venceu e não paga nada.',
    done: false,
  },
  {
    title: 'Perfis',
    detail:
      'Dificuldade, tempo de domínio e contestação reutilizáveis entre territórios. Hoje cada território carrega os próprios números, o que basta enquanto forem poucos.',
    done: false,
  },
];

function Koth() {
  const [tab, setTab] = useState<'live' | 'territorios' | 'falta'>('live');
  const [servers, setServers] = useState<readonly { id: string; name: string }[] | null>(null);
  const [serverId, setServerId] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await agent.servers();

      setServers(response.servers.map((server) => ({ id: server.id, name: server.name })));
    } catch {
      setServers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ####  O TERRITÓRIO É DE UM MAPA  ####
  //
  // E um mapa é de um servidor — a mesma razão pela qual a aba
  // "Onde nasce" da masmorra também pergunta o servidor antes de
  // qualquer outra coisa.
  const current = serverId === '' ? (servers?.[0]?.id ?? '') : serverId;

  return (
    <div>
      <PageHeader
        title="KOTH"
        description="Um território no mapa aberto, e quem aguentar ficar nele"
        aside={
          <div className="flex items-center gap-3">
            {servers !== null && servers.length > 1 && (
              <label className="flex items-center gap-2">
                <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
                  Servidor
                </span>
                <select
                  value={current}
                  onChange={(event) => setServerId(event.target.value)}
                  className="h-8 border border-border bg-background px-2 text-sm"
                >
                  {servers.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <Link
              href="/eventos/"
              className="flex items-center gap-1 font-condensed text-2xs uppercase tracking-wide text-muted hover:text-foreground"
            >
              <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
              Eventos
            </Link>
          </div>
        }
      />

      <div className="mt-4 border-b border-border">
        <div className="flex">
          <TabButton active={tab === 'live'} onClick={() => setTab('live')}>
            Ao vivo
          </TabButton>
          <TabButton active={tab === 'territorios'} onClick={() => setTab('territorios')}>
            Territórios
          </TabButton>
          <TabButton active={tab === 'falta'} onClick={() => setTab('falta')}>
            O que falta
          </TabButton>
        </div>
      </div>

      <div className="mt-4">
        {/* As duas primeiras abas são de um servidor; a guarda é a
            mesma, e escrevê-la duas vezes faria uma delas envelhecer. */}
        {tab !== 'falta' &&
          (servers === null ? (
            <StateBlock variant="loading" title="Lendo os servidores…" />
          ) : current === '' ? (
            <StateBlock
              variant="empty"
              title="Nenhum servidor cadastrado"
              detail="Um território é um lugar no mapa, e um mapa é de um servidor."
            />
          ) : tab === 'live' ? (
            <LivePanel key={current} serverId={current} />
          ) : (
            <ArenasPanel key={current} serverId={current} />
          ))}

        {tab === 'falta' && <Falta />}
      </div>
    </div>
  );
}

/**
 * O que ainda não existe.
 *
 * Ela continua aqui depois de os territórios funcionarem porque a
 * família NÃO está pronta: sem recompensa e sem agenda própria, um
 * admin que só visse a primeira aba concluiria que basta cadastrar.
 */
function Falta() {
  return (
    <div className="space-y-4">
      <div className="border border-border bg-surface p-6">
        <h2 className="flex items-center gap-2 font-condensed text-lg font-bold uppercase tracking-wide">
          <Flag aria-hidden="true" className="h-5 w-5 text-rust" />
          O que o KOTH já faz
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-muted">
          O território nasce no mapa com uma bandeira e um círculo, quem está dentro dele é contado
          por equipe, a barra enche na tela de quem participa, e a captura fecha o evento e entra no
          histórico com o nome da equipe que venceu.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-muted">
          Quem entra <strong className="text-foreground">sem equipe</strong> vê um aviso e não faz a
          barra andar — é a regra da casa, e é o que faz o placar ter nome.
        </p>
      </div>

      <section>
        <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
          <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
          As frentes, na ordem
        </h3>

        <ul className="mt-3 space-y-2">
          {FRENTES.map((frente) => (
            <li key={frente.title} className="flex gap-3 border border-border bg-surface p-3">
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 h-4 w-[3px] shrink-0',
                  frente.done ? 'bg-olive' : 'bg-border',
                )}
              />

              <div className="min-w-0">
                <p className="font-condensed text-sm font-bold">
                  {frente.title}
                  <span
                    className={cn(
                      'ml-2 text-2xs font-normal uppercase tracking-wide',
                      frente.done ? 'text-olive' : 'text-muted',
                    )}
                  >
                    {frente.done ? 'já existe' : 'a fazer'}
                  </span>
                </p>
                <p className="mt-1 text-2xs text-muted">{frente.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        '-mb-px border-b-2 px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
        active
          ? 'border-rust text-foreground'
          : 'border-transparent text-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
