'use client';

// ============================================================
//  ranking-picker.tsx  -  escolher o ranking, em vez de digitá-lo.
//
//  ####  O DEFEITO QUE ELE EXISTE PARA NÃO REPETIR  ####
//
//  O campo era texto livre. O dono escreveu `quest.completed` — que
//  parece o nome certo, e não é ranking nenhum —, a missão salvou,
//  o jogador concluiu, os 50 OZCoin caíram e os 5 pontos viraram
//  pendência no painel com "o ranking não existe". Medido em
//  14/09/2026.
//
//  ####  E ELE É UM CONTROLE SÓ  ####
//
//  A primeira versão pôs uma caixa de busca EM CIMA de um `select`,
//  e o dono viu na hora: "o buscar tem que ser o select". Dois
//  controles para uma escolha obrigam a pessoa a entender a relação
//  entre eles antes de escolher — e não há relação nenhuma para
//  entender: é uma pergunta só.
//
//  Agora é o mesmo desenho do `ItemCombobox`: digita, a lista
//  filtra, seta e Enter escolhem. Fechado, o campo mostra o que
//  está escolhido.
//
//  ####  DOIS USOS, DUAS LISTAS  ####
//
//    award  a recompensa ESCREVE no ranking -> só os que aceitam
//           ponto concedido (`rankings/awards.ts`)
//    read   o objetivo LÊ o ranking -> todos servem, inclusive
//           minério e abates
//
//  Misturar os dois foi o que deixou "dar 5 pontos em Metal" ser
//  escrito: somar à mão num ranking que o jogo MEDE é uma mentira
//  sobre uma medição.
//
//  ####  O QUE JÁ ESTÁ GRAVADO NUNCA SOME  ####
//
//  Mesmo fora do catálogo — ranking apagado, desligado, ou a
//  métrica errada que este seletor veio consertar. Um seletor que
//  troca o valor sozinho faz a quest passar a pagar em outro lugar
//  sem ninguém pedir; aqui ele aparece com o aviso do que está
//  errado, e trocar continua sendo um ato de quem está olhando.
// ============================================================

import { Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';

import { RankingDialog } from '@/components/ranking/ranking-dialog';
import { Input } from '@/components/ui/input';
import { agent, type RankingDefinition, type RankingDefinitionInput } from '@/lib/api';
import { cn } from '@/lib/utils';

import { eligibleRankings, searchRankings, type RankingPickerMode } from './ranking-choice';

/**
 * O ranking que nasce pelo atalho daqui.
 *
 * `source: 'item'` é o valor que quer dizer CONCEDIDO — o mesmo do
 * Troféu Bleik. É ele que faz o ranking novo já aparecer na lista
 * de destinos assim que é criado.
 */
const QUEST_POINTS_PRESET: Partial<RankingDefinitionInput> = {
  source: 'item',
  valueKind: 'counter',
  // A temporada é a janela da premiação: pontos de missão são de
  // quem jogou NESTA temporada, e não de quem jogou em 2024.
  window: 'season',
};

export interface RankingPickerProps {
  /** A métrica gravada. String vazia = nada escolhido ainda. */
  readonly value: string;
  readonly onChange: (metric: string) => void;
  /**
   * `award` = destino de pontos; `read` = alvo de um objetivo.
   *
   * Ver o cabeçalho: são duas perguntas diferentes, e a lista de
   * respostas válidas é diferente em cada uma.
   */
  readonly mode: RankingPickerMode;
  readonly id?: string;
  readonly disabled?: boolean;
}

export function RankingPicker({ value, onChange, mode, id, disabled = false }: RankingPickerProps) {
  const listboxId = useId();
  const [rankings, setRankings] = useState<readonly RankingDefinition[]>([]);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [criando, setCriando] = useState(false);

  const carregar = useCallback(async (): Promise<void> => {
    try {
      const response = await agent.rankingMetrics({ enabledOnly: true });

      setRankings(response.rankings);
      setFailed(false);
    } catch {
      // ####  A LISTA SOME; O QUE JÁ FOI ESCOLHIDO FICA  ####
      //
      // Sem catálogo o admin perde a OFERTA, e não o cadastro.
      // Derrubar o diálogo por uma rota que não respondeu levaria
      // junto os objetivos e as regras que ele acabou de escrever.
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // As duas decisões moram em `ranking-choice.ts`: o vitest do
  // painel roda em node puro e não monta React, então o que se
  // prova é a função.
  const elegiveis = useMemo(() => eligibleRankings(rankings, mode), [rankings, mode]);
  const options = useMemo(() => searchRankings(elegiveis, query), [elegiveis, query]);

  const escolhido = rankings.find((entry) => entry.metric === value) ?? null;
  const foraDaLista = value !== '' && !elegiveis.some((entry) => entry.metric === value);

  const select = (ranking: RankingDefinition): void => {
    onChange(ranking.metric);
    setQuery('');
    setIsOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (event.key === 'Enter') {
      const active = activeIndex >= 0 ? options[activeIndex] : undefined;

      if (active !== undefined) {
        // Só engole o Enter quando ele SELECIONA algo. Sem opção
        // ativa, o Enter tem de continuar enviando o formulário.
        event.preventDefault();
        select(active);
      }

      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }

    if (options.length === 0) {
      return;
    }

    event.preventDefault();
    setIsOpen(true);

    const step = event.key === 'ArrowDown' ? 1 : -1;

    setActiveIndex((currentIndex) => {
      const next = currentIndex + step;

      // Circula: de baixo volta ao topo.
      if (next < 0) {
        return options.length - 1;
      }

      return next >= options.length ? 0 : next;
    });
  };

  const activeOptionId = activeIndex >= 0 ? `${listboxId}-option-${String(activeIndex)}` : undefined;

  // Fechado, o campo mostra a ESCOLHA; aberto, mostra o que se está
  // digitando. É o que faz um controle só responder as duas coisas:
  // "o que está escolhido?" e "o que estou procurando?".
  const texto = isOpen ? query : (labelOf(escolhido, value) ?? '');

  return (
    <div className="space-y-1">
      <div className="relative">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
          />

          <Input
            {...(id === undefined ? {} : { id })}
            role="combobox"
            type="text"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={texto}
            placeholder={value === '' ? 'Escolha um ranking…' : 'Buscar outro ranking…'}
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-autocomplete="list"
            {...(activeOptionId === undefined ? {} : { 'aria-activedescendant': activeOptionId })}
            className="pl-7 text-2xs"
            onChange={(event) => {
              setQuery(event.target.value);
              setIsOpen(true);
              setActiveIndex(-1);
            }}
            // Abrir com a busca LIMPA: quem clica no campo quer ver
            // as opções, e não apagar o nome do que já escolheu para
            // então vê-las.
            onFocus={() => {
              setQuery('');
              setIsOpen(true);
            }}
            onBlur={() => setIsOpen(false)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <ul
          id={listboxId}
          role="listbox"
          aria-label="Rankings"
          className={cn(
            'absolute left-0 right-0 top-full z-20 mt-px max-h-64 overflow-y-auto',
            'border border-border bg-surface-2',
            !isOpen && 'hidden',
          )}
        >
          {options.length === 0 && (
            <li role="presentation" className="px-2 py-2 text-2xs leading-relaxed text-muted">
              {elegiveis.length === 0
                ? mode === 'award'
                  ? 'Nenhum ranking de pontos cadastrado ainda.'
                  : 'Nenhum ranking cadastrado ainda.'
                : `Nenhum ranking com “${query}”.`}
            </li>
          )}

          {options.map((option, index) => (
            <li
              key={option.id}
              id={`${listboxId}-option-${String(index)}`}
              role="option"
              aria-selected={option.metric === value}
              // O mousedown do clique dispararia o blur do input
              // ANTES do click, fechando a lista e cancelando a
              // seleção. Prevenir o padrão mantém o foco.
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => select(option)}
              onMouseEnter={() => setActiveIndex(index)}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-2xs',
                index === activeIndex && 'bg-surface',
                option.metric === value && 'text-rust',
              )}
            >
              <span className="truncate font-condensed font-bold uppercase tracking-wide">
                {option.label}
              </span>

              {/* O código técnico junto: quem já o conhece confere, e
                  é ele que viaja no cadastro. */}
              <span className="shrink-0 font-mono text-muted">{option.metric}</span>
            </li>
          ))}

          {/* ####  CRIAR SEM PERDER O QUE ESTÁ ESCRITO  ####

              Descobrir no meio do formulário que o ranking não
              existe custaria a missão inteira se a saída fosse "vá
              à página de rankings". */}
          {mode === 'award' && (
            <li
              role="option"
              aria-selected={false}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                setIsOpen(false);
                setCriando(true);
              }}
              className="flex cursor-pointer items-center gap-1 border-t border-border px-2 py-1.5 text-2xs uppercase tracking-wide text-rust"
            >
              <Plus className="h-3.5 w-3.5" />
              Criar um ranking de pontos
            </li>
          )}
        </ul>
      </div>

      {failed && (
        <p className="text-2xs text-muted">
          O catálogo de rankings não carregou. O que já está escolhido continua valendo.
        </p>
      )}

      {/* O que está gravado e não serve: dito com o motivo, porque
          "não pode" sem motivo faz o admin tentar o próximo da lista
          até acertar por eliminação. */}
      {mode === 'award' && foraDaLista && (
        <p className="text-2xs text-rust">
          {escolhido === null
            ? `“${value}” não é um ranking. A missão não vai conseguir pagar esses pontos.`
            : `“${escolhido.label}” é medido pelo jogo e não aceita pontos de missão.`}
        </p>
      )}

      {mode === 'read' && foraDaLista && (
        <p className="text-2xs text-rust">“{value}” não é um ranking.</p>
      )}

      <RankingDialog
        open={criando}
        ranking={null}
        preset={QUEST_POINTS_PRESET}
        onClose={() => setCriando(false)}
        onSaved={(created) => {
          setRankings((current) => [...current, created]);
          onChange(created.metric);
          setCriando(false);
        }}
      />
    </div>
  );
}

/**
 * O que o campo fechado mostra.
 *
 * `null` quando não há nada escolhido. Com a métrica gravada e o
 * ranking fora do catálogo, mostra a métrica crua — é ela que está
 * salva, e escondê-la faria o campo parecer vazio numa quest que
 * tem valor.
 */
function labelOf(ranking: RankingDefinition | null, value: string): string | null {
  if (ranking !== null) {
    return `${ranking.label} (${ranking.metric})`;
  }

  return value === '' ? null : value;
}
