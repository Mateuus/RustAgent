'use client';

// ============================================================
//  /eventos/koth  -  O DOMÍNIO DE TERRITÓRIO.
//
//  ####  ESTA TELA NÃO CONFIGURA NADA AINDA, E DIZ ISSO  ####
//
//  Ela existe antes do evento de propósito: a rota é o lugar em que
//  a família mora, e o hub já aponta para cá. O que ela NÃO tem é
//  um formulário de mentira — campo que salva numa tabela que
//  ninguém lê é pior que campo nenhum, porque alguém preenche,
//  fecha, e espera o evento acontecer.
//
//  O que ela faz é responder a pergunta de quem clicou no cartão:
//  o que vai ser isto, o que já existe (a agenda e o histórico são
//  do guarda-chuva e já funcionam) e o que falta para o primeiro
//  KOTH nascer.
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

import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';

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
      'O KOTH pontua por LADO, e um lado sem nome não aparece em placar nenhum. O jogo já tem equipe; falta dar nome a ela, deixar editar no /menu e saber quem é líder.',
    done: false,
  },
  {
    title: 'Territórios no mapa',
    detail:
      'Onde o domínio acontece: centro, volume de captura (raio e altura, ou caixa orientada), peso do sorteio e cooldown. É o cadastro próprio desta família — o ponto da masmorra não serve, ele não tem volume.',
    done: false,
  },
  {
    title: 'Perfis',
    detail:
      'Dificuldade, tempo de domínio, contestação, abandono e duração máxima, reutilizáveis entre territórios. Uma execução leva uma cópia congelada do perfil.',
    done: false,
  },
  {
    title: 'A captura, no servidor do jogo',
    detail:
      'Quem está dentro, quem contesta, quanto o progresso sobe e quanto ele decai. É conta do plugin — painel e cliente só mostram.',
    done: false,
  },
  {
    title: 'A barra na tela de quem joga',
    detail:
      'Sem ela o jogador não sabe que está capturando, nem quanto falta, nem quem está na frente. Entra pelo CUI, junto do que o OrigemZUI já desenha.',
    done: false,
  },
  {
    title: 'A bandeira do território',
    detail:
      'Um Large Banner on pole no centro, que mostra de quem é o domínio agora. Depende da equipe ter nome.',
    done: false,
  },
  {
    title: 'Recompensas e entrega',
    detail:
      'OZCoins, troféus, kits, VIP e itens, com registro de entrega individual para não pagar duas vezes nem esquecer ninguém.',
    done: false,
  },
  {
    title: 'Agenda e histórico',
    detail:
      'Já existem, e são do guarda-chuva: assim que houver KOTH para erguer, ele entra na mesma agenda e aparece no mesmo histórico, sem tela nova.',
    done: true,
  },
];

function Koth() {
  return (
    <div>
      <PageHeader
        title="KOTH"
        description="Um território no mapa aberto, e quem aguentar ficar nele"
        aside={
          <Link
            href="/eventos/"
            className="flex items-center gap-1 font-condensed text-2xs uppercase tracking-wide text-muted hover:text-foreground"
          >
            <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
            Eventos
          </Link>
        }
      />

      <div className="mt-4 border border-border bg-surface p-6">
        <h2 className="flex items-center gap-2 font-condensed text-lg font-bold uppercase tracking-wide">
          <Flag aria-hidden="true" className="h-5 w-5 text-rust" />
          Ainda não há o que configurar aqui
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-muted">
          O KOTH escolhe uma região do mapa, anuncia, e quem ficar dentro dela tempo suficiente —
          defendendo de quem chegar — leva o prêmio. Os jogadores vão a pé, com o inventário que
          têm; não há arena, teleporte nem inventário emprestado.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-muted">
          A agenda e o histórico da tela anterior já valem para ele: são do guarda-chuva, e não da
          masmorra. O que falta é o evento em si.
        </p>
      </div>

      <section className="mt-4">
        <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
          <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
          O que falta, na ordem
        </h3>

        <ul className="mt-3 space-y-2">
          {FRENTES.map((frente) => (
            <li key={frente.title} className="flex gap-3 border border-border bg-surface p-3">
              <span
                aria-hidden="true"
                className={
                  frente.done
                    ? 'mt-0.5 h-4 w-[3px] shrink-0 bg-olive'
                    : 'mt-0.5 h-4 w-[3px] shrink-0 bg-border'
                }
              />

              <div className="min-w-0">
                <p className="font-condensed text-sm font-bold">
                  {frente.title}
                  <span
                    className={
                      frente.done
                        ? 'ml-2 font-normal text-2xs uppercase tracking-wide text-olive'
                        : 'ml-2 font-normal text-2xs uppercase tracking-wide text-muted'
                    }
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
