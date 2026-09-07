'use client';

// ============================================================
//  coverage-block.tsx  -  desde quando é medido, e quem estava
//  medindo.
//
//  ####  ISTO NÃO É TOOLTIP  ####
//
//  Docs/Ranking/20 §10 é explícito: `measuredSince` e `coverage`
//  aparecem NA TELA. Um ranking premiado que não diz desde quando
//  mede é um ranking que vai ser contestado — e a contestação
//  chega justamente de quem não viu o rodapé escondido atrás do
//  mouse.
//
//  ####  "SEM DADOS" E "NINGUÉM PONTUOU" SÃO COISAS DIFERENTES  ####
//
//  É a única razão de `coverage` existir. Um servidor em
//  `not-loaded` some da lista igualzinho a um servidor onde
//  ninguém jogou — e a tela precisa dizer qual dos dois é, com
//  todas as letras, antes da tabela.
//
//  ####  E "AINDA NÃO MEDIU" NÃO É "PAROU DE MEDIR"  ####
//
//  São quatro estados, e só dois deles são defeito. Um ranking
//  recém-criado nasce com todos os servidores em `never`: se ele
//  aparecesse com a mesma tarja de "a coleta não responde", o
//  admin iria caçar uma falha que não existe — e, da segunda vez
//  que visse a tarja, ignoraria a de verdade.
//
//  A FRASE de cada estado vem pronta da API (`message`), do mesmo
//  módulo que a tela do jogo lê. O que esta tela decide é o PESO:
//  tarja para a falha, linha discreta para o que só ainda não
//  aconteceu.
// ============================================================

import { Hourglass, Snowflake } from 'lucide-react';

import { StateBlock } from '@/components/state-block';
import {
  coverageSentence,
  COVERAGE_LABELS,
  formatUntil,
  isCoverageFault,
  WINDOW_LABELS,
} from '@/components/ranking/labels';
import type { RankingCoverage, RankingCoverageServer, RankingPeriodView } from '@/lib/api';
import { EM_DASH, formatDateTime, formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';

interface CoverageBlockProps {
  readonly coverage: RankingCoverage;
  readonly measuredSince: string | null;
  readonly updatedAt: string | null;
  readonly period: RankingPeriodView;
  /** A lista veio do pódio congelado? Aí ela não muda mais. */
  readonly frozen?: boolean;
}

export function CoverageBlock({
  coverage,
  measuredSince,
  updatedAt,
  period,
  frozen = false,
}: CoverageBlockProps) {
  // Um servidor que não estava medindo não vira zero na lista: ele
  // vira esta frase, acima da tabela. Em dois pesos: o que quebrou
  // e o que ainda não começou.
  const faults = coverage.servers.filter((server) => isCoverageFault(server.status));
  const pending = coverage.servers.filter((server) => server.status === 'never');

  return (
    <div className="space-y-3">
      <dl className="grid gap-x-6 gap-y-1 border border-border bg-surface px-3 py-2 text-2xs sm:grid-cols-2 lg:grid-cols-4">
        <Fact
          label="Medido desde"
          value={measuredSince === null ? EM_DASH : formatDateTime(measuredSince)}
          hint={measuredSince === null ? undefined : formatWhen(measuredSince)}
        />
        <Fact
          label="Janela"
          value={period.label ?? WINDOW_LABELS[period.kind]}
          hint={period.startedAt === null ? undefined : `aberta em ${formatDateTime(period.startedAt)}`}
        />
        <Fact
          label={frozen ? 'Fechada em' : 'Vira em'}
          value={
            frozen
              ? period.endedAt === null
                ? EM_DASH
                : formatDateTime(period.endedAt)
              : period.turnsAt === null
                ? 'sem data'
                : formatDateTime(period.turnsAt)
          }
          hint={
            frozen
              ? 'o valor não muda mais'
              : period.turnsAt === null
                ? 'esta janela só fecha na mão'
                : formatUntil(period.turnsAt)
          }
        />
        <Fact
          label="Último lote"
          value={updatedAt === null ? EM_DASH : formatWhen(updatedAt)}
          hint={updatedAt === null ? 'nenhum lote aplicado' : formatDateTime(updatedAt)}
        />
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
          Coleta
        </span>

        {coverage.servers.length === 0 ? (
          <span className="text-2xs text-muted">
            nenhum servidor neste escopo {EM_DASH} não há o que medir
          </span>
        ) : (
          coverage.servers.map((server) => (
            <span
              key={server.serverId}
              // Sem `title` no `ok`: a API não manda frase quando não
              // há o que avisar, e inventar uma aqui seria escrever
              // a segunda versão de um texto que é do core.
              title={coverageSentence(server) ?? undefined}
              className={cn(
                'flex items-center gap-1.5 border bg-surface-2 px-2 py-0.5 text-2xs',
                isCoverageFault(server.status) ? 'border-amber' : 'border-border',
              )}
            >
              {/* A forma diz o estado, e não só a cor — a mesma
                  regra do ponto da lista de jogadores. E aqui são
                  TRÊS formas, porque são três respostas diferentes:

                    disco cheio    estava medindo;
                    anel tracejado ainda não mediu nenhuma vez;
                    anel âmbar     media e parou (ou nem carregou).

                  Um anel só para os dois últimos daria ao ranking
                  recém-criado a mesma cara de um coletor caído. */}
              <span
                aria-hidden="true"
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  server.status === 'ok' && 'bg-olive',
                  server.status === 'never' && 'border border-dashed border-muted',
                  isCoverageFault(server.status) && 'border-2 border-amber',
                )}
              />
              <span className="text-foreground">{server.serverId}</span>
              <span className={cn(isCoverageFault(server.status) ? 'text-amber' : 'text-muted')}>
                {COVERAGE_LABELS[server.status]}
              </span>
              <span className="text-muted">
                {server.lastBatchAt === null ? EM_DASH : formatWhen(server.lastBatchAt)}
              </span>
            </span>
          ))
        )}
      </div>

      {faults.length > 0 && (
        <StateBlock
          variant="offline"
          title="Nem todo servidor deste escopo estava medindo."
          detail={
            <>
              {sentencesOf(faults)} A lista abaixo <strong>não fala por ele</strong>: ausência aqui
              é falta de coleta, e não jogador sem ponto.
            </>
          }
        />
      )}

      {/* ####  ISTO NÃO É UMA TARJA  ####

          `never` é informativo: ninguém precisa consertar nada, só
          esperar o primeiro lote. Uma tarja aqui gastaria o alarme
          — e quem vê alarme demais para de ler o alarme. */}
      {pending.length > 0 && (
        <p className="flex items-start gap-2 border border-border bg-surface-2 px-3 py-2 text-2xs text-muted">
          <Hourglass aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span>
            {sentencesOf(pending)} <strong>Não há o que consertar</strong>: a lista abaixo se
            preenche sozinha assim que o primeiro lote chegar.
          </span>
        </p>
      )}

      {frozen && (
        <p className="flex items-start gap-2 border border-border bg-surface-2 px-3 py-2 text-2xs text-muted">
          <Snowflake aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          <span>
            Esta lista é o <strong>pódio congelado</strong> daquela temporada: ela foi gravada no
            fechamento e <strong>não muda mais</strong> — nem se o jogador trocar de nome, nem se o
            número dele mudar depois.
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * As frases daqueles servidores, emendadas numa só.
 *
 * O texto de cada uma é o da API — aqui só se junta. O ponto
 * final fecha a emenda para quem for continuar a frase depois.
 */
function sentencesOf(servers: readonly RankingCoverageServer[]): string {
  const sentences = servers
    .map((server) => coverageSentence(server))
    .filter((sentence): sentence is string => sentence !== null);

  return sentences.length === 0 ? '' : `${sentences.join('; ')}.`;
}

function Fact({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string | undefined;
}) {
  return (
    <div className="flex flex-col py-1">
      <dt className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="text-foreground">
        {value}
        {hint !== undefined && <span className="ml-2 text-muted">{hint}</span>}
      </dd>
    </div>
  );
}
