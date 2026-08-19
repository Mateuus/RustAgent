'use client';

// ============================================================
//  use-agent-clock.ts  -  a contagem regressiva sai do relógio
//  do AGENTE, e não do relógio de quem está olhando a tela.
//
//  ####  POR QUE ISSO NÃO É PREZIOSISMO  ####
//
//  A aba WIPE existe para responder uma coisa: quanto falta. Um
//  navegador adiantado em dez minutos mostraria "faltam 3 min"
//  para um wipe que ainda tem uma hora — e a tela estaria
//  mentindo justamente na única informação que ela existe para
//  dar. O agente é quem vai executar o wipe; é o relógio dele que
//  decide a hora.
//
//  ####  O `now` DA RESPOSTA ENVELHECE  ####
//
//  Toda resposta do wipe traz `now`. Sozinho ele congela: entre
//  uma busca e outra o navegador continua andando, e a contagem
//  ficaria parada no instante da última resposta. Por isso o que
//  se guarda é um PAR — o `now` do agente e o instante local em
//  que ele chegou — e o "agora" é projetado a partir dos dois.
//
//  Não há relógio próprio aqui, nem polling: o `setInterval` de
//  1 s só re-renderiza. Quem busca dados é a tela.
// ============================================================

import { useEffect, useState } from 'react';

/**
 * De quanto em quanto a contagem anda.
 *
 * 1 s porque ela é a informação principal da tela, e um relógio
 * que pula de cinco em cinco parece travado.
 */
const TICK_MS = 1_000;

/**
 * A diferença até a qual os dois relógios são "o mesmo".
 *
 * Dois segundos porque a medida inclui a viagem da resposta pela
 * rede: o agente carimba `now` antes de o JSON sair, e o
 * navegador só o lê depois. Numa máquina local isso é
 * milissegundos; num agente do outro lado do país, pode ser
 * décimos. Nada disso é relógio errado.
 */
const SKEW_TOLERANCE_MS = 2_000;

/** O `now` do agente, e quando ele chegou aqui. */
export interface AgentClockAnchor {
  /** O epoch ms que o agente carimbou na resposta. */
  readonly agentNow: number;
  /** `Date.now()` do navegador no instante em que a resposta chegou. */
  readonly receivedAt: number;
}

export interface AgentClock {
  /**
   * O "agora" do agente, projetado para este instante.
   *
   * `null` só enquanto nenhuma resposta chegou — e nesse caso a
   * tela mostra travessão, nunca o relógio local disfarçado de
   * relógio do agente.
   */
  readonly now: number | null;
  /**
   * Quanto o relógio do navegador está à frente do relógio do
   * agente, em ms. Negativo = atrasado. `null` = ainda não dá
   * para saber.
   */
  readonly skewMs: number | null;
}

/**
 * O `now` do agente projetado para o instante local informado.
 *
 * `localNow` é `null` no primeiro render (o painel é export
 * estático e a página é pré-renderizada no build): sem ele, o
 * valor honesto é o próprio carimbo do agente, sem projeção.
 */
export function projectNow(anchor: AgentClockAnchor, localNow: number | null): number {
  if (localNow === null) {
    return anchor.agentNow;
  }

  return anchor.agentNow + (localNow - anchor.receivedAt);
}

/**
 * Quanto falta, em `06d 04h 12m 33s`.
 *
 * As unidades vazias da frente somem — "12m 33s" é o que se lê
 * quando falta pouco, e não "00d 00h 12m 33s". A da direita
 * nunca some: um contador sem segundos parece travado.
 *
 * Passado o instante, devolve zero em todas as casas; dizer
 * "faltam -2 minutos" seria pior que dizer "já passou", e quem
 * decide entre as duas frases é a tela.
 */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));

  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;

  const pad = (value: number): string => String(value).padStart(2, '0');

  if (days > 0) {
    return `${pad(days)}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  }

  if (hours > 0) {
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  }

  if (minutes > 0) {
    return `${pad(minutes)}m ${pad(seconds)}s`;
  }

  return `${pad(seconds)}s`;
}

/**
 * A linha "relógio" do quadro de estado.
 *
 * Ela não acusa ninguém de estar errado: diz de quanto é a
 * diferença e qual dos dois manda. O relógio que manda é sempre o
 * do agente — é ele que vai executar o wipe.
 */
export function describeSkew(skewMs: number | null): string {
  if (skewMs === null) {
    return 'ainda não medido';
  }

  const seconds = Math.abs(skewMs) / 1000;

  // Vírgula decimal, como todo número do painel: `toFixed` traria
  // o ponto do inglês para uma tela escrita em português.
  if (Math.abs(skewMs) <= SKEW_TOLERANCE_MS) {
    const exact = seconds.toLocaleString('pt-BR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });

    return `ok (±${exact} s)`;
  }

  const lado = skewMs > 0 ? 'adiantado' : 'atrasado';
  const rounded = Math.round(seconds).toLocaleString('pt-BR');

  return `o seu navegador está ${rounded} s ${lado} — a contagem usa o relógio do agente`;
}

/**
 * O relógio do agente, andando.
 *
 * `sample` é o `now` da última resposta lida. Mudou, o par é
 * refeito; enquanto não muda, o valor é projetado com o relógio
 * local — que serve para medir a PASSAGEM do tempo mesmo estando
 * fora de hora.
 */
export function useAgentClock(sample: number | null): AgentClock {
  const [anchor, setAnchor] = useState<AgentClockAnchor | null>(null);
  const [localNow, setLocalNow] = useState<number | null>(null);

  useEffect(() => {
    if (sample === null) {
      return;
    }

    setAnchor({ agentNow: sample, receivedAt: Date.now() });
  }, [sample]);

  useEffect(() => {
    setLocalNow(Date.now());

    const timer = setInterval(() => {
      setLocalNow(Date.now());
    }, TICK_MS);

    return () => {
      clearInterval(timer);
    };
  }, []);

  if (sample === null) {
    return { now: null, skewMs: null };
  }

  // O par ainda não foi montado (o efeito roda depois deste
  // render): o carimbo cru já é melhor que travessão, e no quadro
  // seguinte ele vira contagem.
  if (anchor === null) {
    return { now: sample, skewMs: null };
  }

  return {
    now: projectNow(anchor, localNow),
    skewMs: anchor.receivedAt - anchor.agentNow,
  };
}
