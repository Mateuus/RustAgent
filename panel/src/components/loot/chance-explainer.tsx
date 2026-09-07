'use client';

// ============================================================
//  chance-explainer.tsx  -  a tradução da chance, ao vivo.
//
//  ####  É O BLOCO CENTRAL DESTA TELA  ####
//
//  O admin vai digitar "1 em 5.000" sem fazer ideia do que isso
//  produz — e "0,0002" ao lado não ajuda em nada. O que responde
//  a pergunta dele é uma frase: "≈ 2 por semana, com 400 caixas
//  dessas por dia".
//
//  Sem isso, a tela é um editor de números, e balancear vira
//  tentativa e erro de wipe em wipe. O concorrente vende
//  exatamente esta função como diferencial (05 §7.1).
//
//  ####  O DENOMINADOR É EDITÁVEL PORQUE ELE É UM PALPITE  ####
//
//  Quantas caixas daquele tipo o mapa popula por dia NÃO é medido
//  (05 §9.6). Fixar um número aqui e apresentá-lo como fato seria
//  mentir com precisão de quatro casas. Então ele é um campo: o
//  admin mexe, vê a frase mudar, e entende de que a conta depende.
//
//  Ele NÃO viaja com a regra: não é configuração, é a suposição
//  desta conversa. Guardá-lo faria o painel afirmar amanhã um
//  palpite que alguém deu hoje.
// ============================================================

import { Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  CONTAINERS_PER_DAY_PRESETS,
  formatApprox,
  formatInterval,
  formatRate,
  oneInFromChance,
  parseCount,
  projectChance,
} from '@/components/loot/chance';
import { Input } from '@/components/ui/input';
import type { LootRuleMode } from '@/lib/api';
import { EM_DASH } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ChanceExplainerProps {
  /** A chance da regra, 0 a 1. `null` = ainda não dá para saber. */
  readonly chance: number | null;
  readonly containersPerDay: number;
  readonly onContainersPerDayChange: (value: number) => void;
  readonly dailyCap: number | null;
  readonly mode: LootRuleMode;
  /** Quantos contêineres a regra marcou. Zero muda a leitura toda. */
  readonly containerCount: number;
  readonly className?: string;
}

export function ChanceExplainer({
  chance,
  containersPerDay,
  onContainersPerDayChange,
  dailyCap,
  mode,
  containerCount,
  className,
}: ChanceExplainerProps) {
  const projection = projectChance({ chance, containersPerDay, dailyCap });
  const oneIn = oneInFromChance(chance);

  const headline =
    projection === null
      ? EM_DASH
      : formatRate(projection.capped ? (projection.cappedPerWeek ?? 0) : projection.perWeek);

  return (
    <div className={cn('border border-border bg-surface-2 p-3', className)}>
      <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
        O que essa chance produz
      </p>

      {/* O leitor de tela precisa ouvir a frase mudar quando o
          número muda: é a informação inteira do bloco. */}
      <p aria-live="polite" className="mt-1 font-condensed text-2xl font-bold text-amber">
        {headline}
      </p>

      <ContainersPerDayInput
        id="loot-per-day"
        value={containersPerDay}
        onChange={onContainersPerDayChange}
        className="mt-2"
      />


      <dl className="mt-3 grid gap-x-4 gap-y-1 text-2xs sm:grid-cols-2">
        <Row
          term="Por caixa"
          value={
            oneIn === null
              ? EM_DASH
              : `1 em ${formatApprox(oneIn)}${
                  chance === null ? '' : ` (${formatApprox(chance * 100)} %)`
                }`
          }
        />
        <Row
          term="Intervalo"
          value={projection === null ? EM_DASH : formatInterval(projection.hoursBetween)}
        />
        <Row
          term="Por dia"
          value={
            projection === null
              ? EM_DASH
              : formatApprox(projection.capped ? (projection.cappedPerDay ?? 0) : projection.perDay)
          }
        />
        {/* ####  A SEMANA SECA PRECISA SER DITA ANTES  ####

            Com 2 por semana, uma semana em cada sete passa em
            branco — é o que "raro" significa, e é aritmética de
            Poisson, não defeito (04 §6.3). Quem não lê isto aqui
            lê no chat, na forma de "o spawn raro está quebrado". */}
        <Row
          term="Semana seca"
          value={
            projection === null || projection.drySpellOneIn === null
              ? EM_DASH
              : `1 semana em cada ${formatApprox(projection.drySpellOneIn)} não sai nenhum`
          }
        />
      </dl>

      {containerCount === 0 && (
        <Note variant="warning">
          Nenhum contêiner escolhido: a regra não dispara em lugar nenhum, e a conta acima é só
          hipótese.
        </Note>
      )}

      {projection !== null && projection.capped && (
        <Note variant="warning">
          O teto de {String(dailyCap ?? 0)} por dia está cortando: a chance sozinha daria{' '}
          {formatApprox(projection.perDay)} por dia, e o que sai são{' '}
          {formatApprox(projection.cappedPerDay ?? 0)}. Para o teto virar folga em vez de tampa,
          baixe a chance.
        </Note>
      )}

      {mode === 'measuring' && (
        <Note variant="warning">
          <strong className="text-foreground">Em medição, nada disso cai na caixa.</strong> A conta
          acima é o que a regra <em>teria</em> soltado — é ela que a aba de contagem confere contra
          a realidade antes de você pôr para valer.
        </Note>
      )}

      <Note variant="info">
        As caixas por dia são <strong className="text-foreground">um palpite seu</strong>, e não um
        número medido: só os 400 contêineres de mundo aberto vivos foram medidos (Docs/CustomItem/04
        §6.3), e quantas vezes por dia eles são repostos ninguém sabe. Este número não é salvo com a
        regra — ele só traduz a chance nesta tela.
      </Note>
    </div>
  );
}

/**
 * O denominador da conta, num campo.
 *
 * Mora aqui, e não em cada tela, porque a lista e o formulário
 * precisam supor a MESMA coisa: duas telas projetando a mesma
 * regra com denominadores diferentes fariam o admin desconfiar
 * das duas.
 */
export function ContainersPerDayInput({
  id,
  value,
  onChange,
  className,
}: {
  readonly id: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 text-2xs text-muted', className)}>
      <label htmlFor={id} className="shrink-0">
        supondo
      </label>

      <Input
        id={id}
        type="text"
        inputMode="numeric"
        value={value.toLocaleString('pt-BR')}
        onChange={(event) => {
          const parsed = parseCount(event.target.value);

          // Texto vazio ou inválido não zera o denominador: um
          // zero aqui apagaria a projeção inteira no meio de uma
          // digitação, e a frase que o admin está lendo sumiria.
          if (parsed !== null) {
            onChange(Math.round(parsed));
          }
        }}
        className="h-7 w-24 text-2xs"
      />

      <span>caixas dessas populadas por dia</span>

      <span className="flex flex-wrap items-center gap-1">
        {CONTAINERS_PER_DAY_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            aria-pressed={value === preset}
            className={cn(
              'border px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide',
              value === preset
                ? 'border-amber text-foreground'
                : 'border-border text-muted hover:text-foreground',
            )}
          >
            {preset.toLocaleString('pt-BR')}
          </button>
        ))}
      </span>
    </div>
  );
}

function Row({ term, value }: { readonly term: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/60 py-0.5">
      <dt className="font-condensed uppercase tracking-wide text-muted">{term}</dt>
      <dd className="text-right text-foreground">{value}</dd>
    </div>
  );
}

function Note({
  variant,
  children,
}: {
  readonly variant: 'warning' | 'info';
  readonly children: ReactNode;
}) {
  const Icon = variant === 'warning' ? TriangleAlert : Info;

  return (
    <p
      className={cn(
        'mt-2 flex items-start gap-2 text-2xs leading-relaxed',
        variant === 'warning' ? 'text-amber' : 'text-muted',
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
