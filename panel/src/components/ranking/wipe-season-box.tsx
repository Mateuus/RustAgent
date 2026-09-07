'use client';

// ============================================================
//  wipe-season-box.tsx  -  o ranking, na tela que apaga o mundo.
//
//  ####  MOSTRAR, E NÃO PERGUNTAR DE NOVO  ####
//
//  Quem zera e quem não zera JÁ ESTÁ declarado na `window` de cada
//  ranking. A tela de wipe LISTA — "vão zerar: Minério, Enxofre…" —
//  e não repete a pergunta. Repetir a decisão a cada wipe é como se
//  perde a configuração: alguém marca diferente uma vez, e ninguém
//  descobre por que o ranking zerou. Ver Docs/Ranking/20 §3.4.
//
//  ####  A ÚNICA PERGUNTA QUE SOBRA TEM TRÊS RESPOSTAS  ####
//
//  "esta execução abre temporada nova?" — herdar, forçar sim,
//  forçar não. E o terceiro estado NÃO é o "não": herdar significa
//  "não decidi", e aí vale `ranking_settings.season_on_wipe`
//  daquele servidor. Um booleano de dois estados transformaria toda
//  execução em que ninguém tocou na caixa numa decisão explícita de
//  não virar a temporada.
// ============================================================

import { useEffect, useState } from 'react';

import { WINDOW_LABELS } from '@/components/ranking/labels';
import { agent, type RankingDefinition } from '@/lib/api';
import { cn } from '@/lib/utils';

interface WipeSeasonBoxProps {
  readonly serverId: string;
  /** `null` = herdar a configuração do servidor. */
  readonly value: boolean | null;
  readonly onChange: (value: boolean | null) => void;
}

export function WipeSeasonBox({ serverId, value, onChange }: WipeSeasonBoxProps) {
  const [rankings, setRankings] = useState<readonly RankingDefinition[] | null>(null);
  const [seasonOnWipe, setSeasonOnWipe] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const [catalog, settings] = await Promise.all([
          agent.rankingMetrics({ enabledOnly: true }),
          agent.rankingSettings(serverId),
        ]);

        if (alive) {
          setRankings(catalog.rankings);
          setSeasonOnWipe(settings.settings.seasonOnWipe);
        }
      } catch {
        // O ranking não pode impedir um wipe: sem a lista, a caixa
        // mostra o que sabe e some com o resto. O botão de wipar
        // continua onde estava.
        if (alive) setRankings([]);
      }
    })();

    return () => {
      alive = false;
    };
  }, [serverId]);

  if (rankings === null) {
    return (
      <p className="border border-border bg-surface-2 px-3 py-2 text-2xs text-muted">
        Lendo os rankings deste servidor…
      </p>
    );
  }

  /** O que vai acontecer de verdade: a execução manda, a configuração é o padrão. */
  const turning = value ?? seasonOnWipe ?? false;

  // O wipe zera os rankings de janela `wipe`. Se a temporada TAMBÉM
  // virar nesta execução, os de janela `season` zeram junto — e é
  // por isso que a lista muda quando se mexe no seletor acima.
  const zeroes = (ranking: RankingDefinition): boolean =>
    ranking.window === 'wipe' || (turning && ranking.window === 'season');

  const reset = rankings.filter(zeroes);
  const kept = rankings.filter((ranking) => !zeroes(ranking));

  return (
    <div className="space-y-3 border border-border bg-surface-2 p-3">
      <div className="space-y-2">
        <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
          Abrir temporada nova do ranking?
        </p>

        <div className="flex flex-col gap-1.5">
          <Choice
            checked={value === null}
            onChange={() => onChange(null)}
            label="Herdar a configuração do servidor"
            hint={
              seasonOnWipe === null
                ? 'Não consegui ler a configuração deste servidor agora — o agente decide na hora, pela regra dele.'
                : seasonOnWipe
                  ? 'Hoje ela diz que SIM: a temporada vira junto com o mundo.'
                  : 'Hoje ela diz que NÃO: a temporada segue o calendário dela.'
            }
          />

          <Choice
            checked={value === true}
            onChange={() => onChange(true)}
            label="Forçar: abrir temporada nova"
            hint="Só nesta execução, mesmo que a configuração diga que não."
          />

          <Choice
            checked={value === false}
            onChange={() => onChange(false)}
            label="Forçar: NÃO abrir"
            hint="Só nesta execução, mesmo que a configuração diga que sim."
          />
        </div>
      </div>

      {/* A LISTA, lida da `window` de cada ranking. Ela não é uma
          pergunta: é o que vai acontecer. */}
      <p className="text-2xs leading-relaxed">
        <span className="text-muted">Vão zerar neste wipe: </span>
        <strong className="text-foreground">
          {reset.length === 0 ? 'nenhum' : reset.map((ranking) => ranking.label).join(', ')}
        </strong>
        <span className="text-muted"> · Continuam: </span>
        <strong className="text-foreground">
          {kept.length === 0 ? 'nenhum' : kept.map((ranking) => ranking.label).join(', ')}
        </strong>
      </p>

      <p className="text-2xs leading-relaxed text-muted">
        Quem zera é a <strong>janela</strong> de cada ranking ({WINDOW_LABELS.wipe.toLowerCase()},{' '}
        {WINDOW_LABELS.season.toLowerCase()}, {WINDOW_LABELS.lifetime.toLowerCase()}), escolhida uma
        vez em <strong>Ranking → Rankings</strong>. E zerar aqui não é apagar: o número antigo fica
        no período fechado, congelado no pódio e consultável no histórico.
      </p>
    </div>
  );
}

function Choice({
  checked,
  onChange,
  label,
  hint,
}: {
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly label: string;
  readonly hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      {/* Rádio de verdade, e não três botões: são três respostas
          MUTUAMENTE exclusivas para uma pergunta só, e é isso que o
          leitor de tela precisa anunciar. */}
      <input
        type="radio"
        name="wipe-ranking-season"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-4 w-4 shrink-0 accent-rust"
      />
      <span className="text-2xs leading-relaxed">
        <span
          className={cn(
            'font-condensed font-bold uppercase tracking-wide',
            checked ? 'text-foreground' : 'text-muted',
          )}
        >
          {label}
        </span>
        <span className="block text-muted">{hint}</span>
      </span>
    </label>
  );
}
