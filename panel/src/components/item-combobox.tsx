'use client';

// ============================================================
//  item-combobox.tsx  -  buscar um item no catálogo do agente.
//
//  ####  O CAMPO VALE O SHORTNAME; A BUSCA É POR NOME  ####
//
//  O shortname é o que a entrega no jogo exige — `inventory.give`
//  recebe ele, e nada mais. Mas ninguém decora
//  `wall.frame.garagedoor`, e digitar de cabeça é como o item
//  errado entra num kit que só vai ser conferido quando chegar ao
//  jogador.
//
//  Então a busca é pelo NOME ("assault", "porta"), cada opção
//  mostra os dois, e o ícone vem antes do texto: reconhecer a arma
//  pela figura é mais rápido do que ler `rifle.ak`.
//
//  E ela funciona com TODOS OS SERVIDORES PARADOS — o catálogo
//  mora no banco do agente, que é a razão de ele existir.
//
//  ------------------------------------------------------------
//  ####  A LISTA TEM DUAS NATUREZAS  ####
//
//  Em cima, os itens que NÓS criamos (`custom_items`); embaixo, os
//  do jogo (`items`). Antes só existia a segunda metade, e o
//  sintoma era o pior possível: digitar "blei" na tela de dar item
//  não achava NADA — o Troféu Bleik Store existe, está cadastrado
//  e funciona, mas mora na outra tabela.
//
//  O jeito de entregá-lo era escolher `discord.trophy` e digitar
//  `1552602728526292` à mão no campo Skin. Ninguém faz isso, e
//  quem fizesse erraria um dígito sem nunca saber.
//
//  ####  ESCOLHER UM ITEM NOSSO PREENCHE OS DOIS CAMPOS  ####
//
//  É a razão de existir desta lista misturada. Um item nosso é o
//  par `(shortname, skinId)`: o shortname é o corpo emprestado, a
//  skin é a marca. Preencher um sem o outro entrega um item sem
//  identidade — e nada avisa. Por isso a escolha sai daqui como um
//  `ItemChoice`, com os dois juntos, e o campo Skin da tela fica
//  travado enquanto ela valer (ver `skin-input.tsx`).
//
//  ------------------------------------------------------------
//  ####  ACESSIBILIDADE: É O PADRÃO COMBOBOX DA WAI-ARIA  ####
//
//  O foco NÃO sai do input; quem anda pela lista é o
//  `aria-activedescendant` apontando para a opção ativa. Fazer o
//  foco pular para o `<li>` quebraria a digitação, que é o ponto
//  do autocomplete.
// ============================================================

import { Loader2, Search } from 'lucide-react';
import { Fragment, useEffect, useId, useState, type KeyboardEvent } from 'react';

import {
  buildItemOptions,
  choiceKey,
  excludedCustomItems,
  type ExcludedCustomItem,
  type ItemChoice,
} from '@/components/item-choice';
import { CustomItemIcon, ItemIcon } from '@/components/item-icon';
import { Input } from '@/components/ui/input';
import { agent, type CatalogItem } from '@/lib/api';
import { useCustomItems } from '@/lib/hooks/use-custom-items';
import { cn } from '@/lib/utils';

const SEARCH_DEBOUNCE_MS = 250;

/** Quantos itens do JOGO a lista mostra. */
const RESULTS = 20;

interface ItemComboboxProps {
  /** Shortname digitado ou escolhido. É o valor do formulário. */
  readonly value: string;
  readonly onValueChange: (shortname: string) => void;
  /**
   * A escolha inteira. `null` = o texto foi digitado à mão.
   *
   * Traz `shortname` e `skinId` juntos de propósito: ver o
   * cabeçalho. Quem não escutar isto entrega item nosso sem marca.
   */
  readonly onChoiceChange?: (choice: ItemChoice | null) => void;
  /**
   * Em qual servidor esta escolha vai valer.
   *
   * Ausente = a tela não sabe (a loja e o editor de interface são
   * da REDE, não de um servidor). Aí os itens nossos aparecem
   * todos, e o cabeçalho do grupo diz isso.
   */
  readonly serverId?: string;
  readonly inputId?: string;
  readonly disabled?: boolean;
  readonly describedById?: string;
  readonly placeholder?: string;
}

export function ItemCombobox({
  value,
  onValueChange,
  onChoiceChange,
  serverId,
  inputId,
  disabled = false,
  describedById,
  // ####  O NOME É EM INGLÊS, E O EXEMPLO PRECISA DIZER ISSO  ####
  //
  // Os nomes vêm do jogo: "Assault Rifle", "Wood". Um exemplo em
  // português ("madeira") não acharia nada — MEDIDO: zero
  // resultados — e a primeira busca de quem lesse o campo daria em
  // lista vazia, que se lê como catálogo quebrado.
  //
  // Os itens NOSSOS são a exceção, e por isso entram no exemplo: o
  // nome deles é o que nós demos, em português.
  placeholder = 'nome do item (assault, wood, troféu) ou shortname',
}: ItemComboboxProps) {
  const listboxId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [items, setItems] = useState<readonly CatalogItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Os nossos vêm de uma lista só, guardada em módulo: são dezenas,
  // e a rota não aceita busca. Filtrar em memória é instantâneo —
  // eles aparecem antes mesmo de o debounce do catálogo vencer.
  const { items: customItems, error: customError } = useCustomItems();

  // Texto que já corresponde a um item escolhido. Escolher uma
  // opção troca o valor do campo pelo shortname dela, e sem isto o
  // efeito dispararia uma busca nova pelo texto que acabou de ser
  // resolvido — a lista reabriria dizendo "nenhum item encontrado"
  // para um item que existe.
  const [resolved, setResolved] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ItemChoice | null>(null);

  const query = value.trim();

  useEffect(() => {
    if (query === '' || query === resolved) {
      setItems([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    const controller = new AbortController();

    setIsSearching(true);
    setSearchError(null);

    const timer = setTimeout(() => {
      void agent
        .items({ query, limit: RESULTS, signal: controller.signal })
        .then((page) => {
          setItems(page.items);
          setActiveIndex(-1);
        })
        .catch((cause: unknown) => {
          // Busca cancelada não é erro: é a tecla seguinte.
          if (controller.signal.aborted) {
            return;
          }

          setItems([]);
          setSearchError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsSearching(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // Aborta a busca anterior a cada tecla: sem isso a resposta
      // de "wo" pode chegar depois da de "wood" e sobrescrever a
      // lista certa.
      controller.abort();
    };
  }, [query, resolved]);

  const options = buildItemOptions({
    customItems,
    catalogItems: items,
    query,
    serverId,
  });

  // A escolha só vale enquanto o campo ainda mostra o shortname
  // dela. Derivar em vez de guardar evita o estado velho de quando
  // a TELA troca o `value` por fora — um formulário que reabre para
  // outro item não pode continuar exibindo a marca do anterior.
  const current = resolved !== null && query === resolved ? chosen : null;

  /** O item NOSSO em jogo agora, quando é um deles. */
  const ours = current === null ? null : current.customItem;

  const select = (choice: ItemChoice): void => {
    setResolved(choice.shortname);
    setChosen(choice);
    onValueChange(choice.shortname);
    onChoiceChange?.(choice);
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

    // `step` é lido AQUI, e não dentro do atualizador: o atualizador
    // roda no próximo render, e depender do objeto de evento lá
    // dentro é frágil.
    const step = event.key === 'ArrowDown' ? 1 : -1;

    setActiveIndex((currentIndex) => {
      const next = currentIndex + step;

      // Circula: de baixo volta ao topo. Numa lista de vinte itens,
      // rolar até o fim para voltar é pior.
      if (next < 0) {
        return options.length - 1;
      }

      return next >= options.length ? 0 : next;
    });
  };

  const showList = isOpen && query !== '' && query !== resolved;
  const activeOptionId = activeIndex >= 0 ? `${listboxId}-option-${String(activeIndex)}` : undefined;

  // Os itens nossos que casam a busca e a tela não pode oferecer.
  // Vale para a lista CHEIA também: achar "trophy" e ver só o corpo
  // do jogo, sem uma palavra sobre o item nosso que ficou de fora,
  // é a mesma armadilha de antes com outra roupa.
  const excluded = excludedCustomItems(customItems, { query, serverId });

  return (
    <div className="relative">
      <div className="relative flex items-center gap-2">
        {/* O ícone do que ESTÁ escolhido, fora do campo: ele é a
            confirmação de que o shortname digitado é mesmo o item
            que a pessoa tinha em mente. Sendo um item nosso, é a
            arte DELE — o campo mostra o corpo emprestado, e só o
            ícone diria que ali está o Troféu, e não uma taça. */}
        {ours === null ? (
          <ItemIcon shortname={resolved ?? query} size="sm" />
        ) : (
          <CustomItemIcon iconFile={ours.iconFile} baseShortname={ours.baseShortname} size="sm" />
        )}

        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
          />

          <Input
            {...(inputId === undefined ? {} : { id: inputId })}
            role="combobox"
            type="text"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={value}
            placeholder={placeholder}
            aria-expanded={showList}
            aria-controls={listboxId}
            aria-autocomplete="list"
            {...(activeOptionId === undefined ? {} : { 'aria-activedescendant': activeOptionId })}
            {...(describedById === undefined ? {} : { 'aria-describedby': describedById })}
            className="pl-7 font-mono text-2xs"
            onChange={(event) => {
              setResolved(null);
              setChosen(null);
              onValueChange(event.target.value);
              onChoiceChange?.(null);
              setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onBlur={() => setIsOpen(false)}
            onKeyDown={handleKeyDown}
          />

          {isSearching && (
            <Loader2
              aria-hidden="true"
              className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-amber"
            />
          )}
        </div>
      </div>

      {/* ####  O CAMPO MOSTRA O CORPO; ESTA LINHA MOSTRA O ITEM  ####

          Escolher "Troféu Bleik Store" põe `discord.trophy` no
          campo, porque é isso que a entrega exige. Sem esta linha,
          o admin acabaria de escolher o troféu e leria um item que
          ele não pediu — e o desfaria achando que errou. */}
      {ours !== null && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs leading-relaxed text-muted">
          <strong className="text-foreground">{ours.displayName}</strong>

          <OurMark />

          <span>
            corpo <span className="font-mono">{ours.baseShortname}</span> · skin{' '}
            <span className="font-mono text-amber">{ours.skinId}</span>
          </span>
        </p>
      )}

      {/* Contagem anunciada em separado: `aria-live` num container
          que só aparece e some não é lido de forma confiável. */}
      <span role="status" aria-live="polite" className="sr-only">
        {showList && !isSearching ? `${String(options.length)} itens encontrados` : ''}
      </span>

      <ul
        id={listboxId}
        role="listbox"
        aria-label="Itens"
        className={cn(
          'absolute left-0 right-0 top-full z-20 mt-px max-h-64 overflow-y-auto',
          'border border-border bg-surface-2',
          !showList && 'hidden',
        )}
      >
        {isSearching && options.length === 0 && (
          <li role="presentation" className="px-2 py-2 text-2xs text-muted">
            Buscando…
          </li>
        )}

        {!isSearching && searchError !== null && (
          <li
            role="presentation"
            className="border-l-2 border-l-rust px-2 py-2 text-2xs text-foreground"
          >
            {searchError}
          </li>
        )}

        {!isSearching && searchError === null && options.length === 0 && (
          <li role="presentation" className="px-2 py-2 text-2xs leading-relaxed text-muted">
            {/* ####  "NÃO EXISTE" É DIFERENTE DE "ESTÁ FORA DAQUI"  ####

                Uma lista vazia não separa as duas, e foi assim que
                este defeito começou: o dono digitou "blei", não
                veio nada, e concluiu que o seletor não conhecia o
                item. Quando o que fechou a porta foi um filtro
                NOSSO, a tela diz qual foi. */}
            {excluded.length === 0 ? (
              <>
                Nenhum item com “{query}”. O catálogo é lido do jogo — se ele estiver vazio, um
                servidor precisa subir uma vez.
              </>
            ) : (
              <>
                Nenhum item entregável com “{query}”. Mas existe no cadastro:
                <ul className="mt-1 space-y-0.5">
                  {excluded.map((entry) => (
                    <li key={entry.item.id}>
                      <strong className="text-foreground">{entry.item.displayName}</strong>{' '}
                      {describeExclusion(entry, serverId)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
        )}

        {options.map((option, index) => {
          const isOurs = option.customItem !== null;
          // O cabeçalho do grupo entra ANTES da primeira linha de
          // cada natureza, e não como uma lista separada: o
          // `activeIndex` das setas conta opções, e uma segunda
          // lista faria a navegação pular do fim de uma para o
          // começo da outra sem passar por nada.
          const startsGroup = index === 0 || isOurs !== (options[index - 1]?.customItem !== null);

          return (
            <Fragment key={choiceKey(option)}>
              {startsGroup && (
                <li
                  role="presentation"
                  className="border-b border-border bg-surface px-2 py-1 text-muted"
                >
                  <span className="font-condensed text-2xs font-bold uppercase tracking-wide">
                    {isOurs ? 'Itens nossos' : 'Do jogo'}
                  </span>

                  {/* ####  DIZER DE QUE RECORTE A LISTA É  ####

                      Um seletor que esconde itens sem explicar por
                      quê manda o admin procurar um item que ele
                      SABE que cadastrou. A frase fica no cabeçalho
                      do grupo, e não no rodapé da lista: no rodapé
                      ela apareceria vinte linhas depois do assunto
                      de que fala. */}
                  {isOurs && (
                    <span className="ml-2 normal-case text-2xs">
                      {serverId === undefined
                        ? '— de todos os servidores: esta tela não sabe onde a entrega vai cair.'
                        : `— só os que valem em ${serverId}. Desligados não entram.`}
                    </span>
                  )}
                </li>
              )}

              <li
                id={`${listboxId}-option-${String(index)}`}
                role="option"
                aria-selected={index === activeIndex}
                // O mousedown do clique dispararia o blur do input
                // ANTES do click, fechando a lista e cancelando a
                // seleção. Prevenir o padrão mantém o foco.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => select(option)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-2xs',
                  index === activeIndex && 'bg-surface',
                )}
              >
                {/* O ícone entra ANTES do texto: reconhecer a arma
                    pela figura é mais rápido do que ler "rifle.ak",
                    e é a diferença entre escolher o item certo de
                    primeira e descobrir o engano quando o kit chega
                    ao jogador. */}
                {option.customItem === null ? (
                  <ItemIcon shortname={option.shortname} size="sm" />
                ) : (
                  <CustomItemIcon
                    iconFile={option.customItem.iconFile}
                    baseShortname={option.customItem.baseShortname}
                    size="sm"
                  />
                )}

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-foreground">{option.displayName}</span>
                    {isOurs && <OurMark />}
                  </span>

                  {/* Um item nosso mostra a MARCA, e não só o corpo:
                      é o par que o identifica, e ver a skin aqui é o
                      que separa dois itens nossos que emprestam o
                      mesmo corpo. */}
                  <span className="block truncate font-mono text-muted">
                    {option.shortname}
                    {option.skinId === '0' ? '' : ` · skin ${option.skinId}`}
                  </span>
                </span>

                {isOurs ? (
                  option.customItem?.baseMissing === true && (
                    <span
                      className="shrink-0 uppercase text-rust"
                      title="O corpo emprestado sumiu desta versão do jogo. Enquanto ele não voltar, este item não pode ser entregue."
                    >
                      corpo fora do jogo
                    </span>
                  )
                ) : option.catalogItem?.removed === true ? (
                  <span
                    className="shrink-0 uppercase text-rust"
                    title="O jogo não lista mais este item nesta versão."
                  >
                    fora do jogo
                  </span>
                ) : (
                  <span className="shrink-0 uppercase text-muted">
                    {option.catalogItem?.category}
                  </span>
                )}
              </li>
            </Fragment>
          );
        })}

        {/* A mesma explicação, quando a lista NÃO veio vazia: o
            item nosso ficou de fora, e sem esta linha o admin veria
            só o corpo do jogo e concluiria que o cadastro sumiu. */}
        {options.length > 0 && excluded.length > 0 && (
          <li
            role="presentation"
            className="border-t border-border px-2 py-1 text-2xs leading-relaxed text-muted"
          >
            Fora da lista:{' '}
            {excluded.map((entry, index) => (
              <Fragment key={entry.item.id}>
                {index > 0 && ' · '}
                <strong className="text-foreground">{entry.item.displayName}</strong>{' '}
                {describeExclusion(entry, serverId)}
              </Fragment>
            ))}
          </li>
        )}

        {/* Falha ao ler os NOSSOS não apaga a busca do jogo — mas
            também não pode passar calada, ou um seletor sem os
            itens da casa parece um cadastro vazio. */}
        {customError !== null && (
          <li
            role="presentation"
            className="border-t border-l-2 border-border border-l-rust px-2 py-1 text-2xs text-foreground"
          >
            Não consegui ler os itens nossos: {customError}
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * Por que aquele item nosso não está na lista, em uma frase.
 *
 * O texto mora AQUI, e não no módulo puro: o motivo é um código,
 * e quem sabe transformá-lo em conselho é a tela — ela é que
 * conhece o servidor de que se está falando.
 */
function describeExclusion(entry: ExcludedCustomItem, serverId: string | undefined): string {
  if (entry.reason === 'disabled') {
    return 'está desligado — um item desligado não é entregue. Ligue-o em Itens → Nossos.';
  }

  if (entry.reason === 'no-server') {
    return 'não vale em servidor nenhum. Marque um em Itens → Nossos.';
  }

  return `não vale em ${serverId ?? 'neste servidor'}. Entregue por aqui, ele chegaria sem a marca.`;
}

/** A etiqueta que separa o que é da casa do que é do jogo. */
function OurMark() {
  return (
    <span
      className="shrink-0 border border-amber px-1 font-condensed text-2xs font-bold uppercase tracking-wide text-amber"
      title="Item nosso: um item do jogo com a marca da casa. Escolhê-lo preenche o shortname e a skin juntos."
    >
      nosso
    </span>
  );
}
