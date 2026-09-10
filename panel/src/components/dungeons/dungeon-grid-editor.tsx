'use client';

// ============================================================
//  dungeon-grid-editor.tsx  -  desenhar a masmorra, célula a célula.
//
//  ####  O GRID É UMA TELA DE PIXEL ART  ####
//
//  Cada célula é um quadrado de 3×3 metros no jogo, e a paleta tem
//  cinco cores: vazio, corredor, e as três cores de sala. O admin
//  pinta arrastando o mouse, como em qualquer editor de sprite —
//  e o que ele desenha é literalmente o que vai ser construído.
//
//  ####  AS PORTAS SÃO AUTOMÁTICAS, E ISSO É A DECISÃO  ####
//
//  Onde uma sala encosta no corredor, nasce porta. Sem exceção,
//  sem ferramenta, sem clique.
//
//  A alternativa — uma ferramenta "porta" — parece dar mais
//  controle e na prática só cria um jeito novo de errar: desenhar
//  uma sala inteira e esquecer a porta produz um cômodo perfeito
//  em que ninguém entra, e o erro só aparece no jogo. Com porta
//  automática, esse defeito deixa de existir.
//
//  ####  E AS SALAS SE DESCOBREM SOZINHAS  ####
//
//  O admin pinta COR, não sala. Quem separa "duas salas vermelhas"
//  de "uma sala vermelha grande" é o preenchimento por vizinhança
//  na hora de salvar: cada mancha contígua da mesma cor vira uma
//  sala, com sua letra.
//
//  Pedir para o admin nomear cada cômodo seria transformar um
//  desenho de dois minutos num formulário.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §4.2 e §11.0.
// ============================================================

import { Dices, Eraser, Grid2x2, Maximize2, Minimize2, Redo2, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { RoomColor } from '@/lib/api';
import { analyzeLayout, checkLayout } from '@/lib/dungeon-layout';
import { cn } from '@/lib/utils';

/** O que se pode pintar. `.` e `#` são os do formato salvo. */
type Brush = 'empty' | 'corridor' | RoomColor;

const BRUSHES: readonly {
  readonly id: Brush;
  readonly label: string;
  readonly color: string;
  readonly hint: string;
}[] = [
  { id: 'empty', label: 'Apagar', color: 'var(--bg)', hint: 'Tira a célula do desenho' },
  {
    id: 'corridor',
    label: 'Corredor',
    color: 'var(--surface-2)',
    hint: 'O caminho. Toda sala precisa encostar num.',
  },
  { id: 'green', label: 'Verde', color: 'var(--olive)', hint: 'Sala fácil: porta de madeira' },
  { id: 'blue', label: 'Azul', color: 'var(--chart-2)', hint: 'Sala média: porta de metal' },
  {
    id: 'red',
    label: 'Vermelha',
    color: 'var(--rust-red)',
    hint: 'Sala difícil: porta blindada, e o melhor loot',
  },
];

/**
 * A letra de cada cor, no formato salvo.
 *
 * ####  A LETRA GUARDA A COR, E NÃO O NÚMERO DA SALA  ####
 *
 * MEDIDO em 09/09/2026, apontado pelo dono: com uma letra por
 * SALA (A, B, C…), a cor se perdia — o formato não a carregava, e
 * todo desenho reaberto ou sorteado voltava inteiro em verde.
 *
 * Guardando a cor, quem separa "duas salas vermelhas" de "uma
 * vermelha grande" continua sendo o preenchimento por vizinhança
 * — que é o construtor, e não o arquivo.
 */
const CHAR_OF_COLOR: Readonly<Record<RoomColor, string>> = {
  green: 'G',
  blue: 'B',
  red: 'R',
};

const COLOR_OF_CHAR: Readonly<Record<string, RoomColor>> = {
  G: 'green',
  B: 'blue',
  R: 'red',
};

/** O lado de uma célula, em unidades de SVG. */
const CELL = 12;

/**
 * O tamanho da tela em branco, em células.
 *
 * 24×24 são 576 células — uma masmorra de 24×24×3 m, ou seja 72
 * metros de lado. É grande o bastante para qualquer coisa que um
 * grupo limpe numa sessão, e pequeno o bastante para o desenho
 * inteiro caber na tela sem rolagem.
 */
const BASE_SIZE = 24;

/**
 * O teto da tela.
 *
 * É o mesmo do formato (`dungeonGridSchema`: 64 linhas de até 64
 * caracteres). A tela cresce até aqui para caber um desenho que
 * chega grande — ver `boardFromRows`.
 */
const MAX_SIZE = 64;

type Canvas = Brush[][];

/**
 * A tela inteira: o tamanho, a entrada e as células.
 *
 * ####  OS TRÊS ANDAM JUNTOS, E ISSO É O CONSERTO  ####
 *
 * MEDIDO em 09/09/2026, apontado pelo dono: escolher o traçado
 * "Labirinto" (23×23, com a entrada no canto) mostrava 84 das 241
 * células. As outras 157 sumiam.
 *
 * A causa eram duas constantes: uma tela de 24×24 e uma entrada
 * CRAVADA no centro dela. Carregar um desenho alinhava tudo pela
 * entrada — e um desenho cuja entrada está no canto se estende 22
 * células para um lado só, ou seja, para fora da tela. O que não
 * cabia era descartado em silêncio.
 *
 * Pior: descartado só na TELA. O desenho inteiro continuava no
 * rascunho, então salvar sem tocar em nada gravava 241 células e
 * salvar depois de encostar no grid gravava 84 — o mesmo clique
 * com dois resultados.
 *
 * Agora a tela cresce até caber (`boardFromRows`) e a entrada é
 * onde o `E` do desenho está. Nada é cortado; quando o desenho é
 * maior que o próprio formato, a tela para em `MAX_SIZE` — e aí o
 * corte é o do formato, não uma surpresa do editor.
 */
export interface Board {
  readonly size: number;
  /** Onde o alçapão cospe o jogador. É o `E` do formato. */
  readonly entrance: { readonly x: number; readonly z: number };
  readonly cells: Canvas;
}

export interface DungeonGridEditorProps {
  /** O grid salvo, no formato de linhas. `null` = tela em branco. */
  readonly grid: readonly string[] | null;
  readonly onChange: (grid: string[]) => void;
  /**
   * Enche a tela com um traçado do gerador.
   *
   * ####  ENCARAR UM GRID VAZIO PARALISA  ####
   *
   * 576 quadradinhos em branco são tão intimidantes quanto trinta
   * campos vazios. Sortear é o PRIMEIRO TRAÇO: o gerador põe uma
   * masmorra completa na tela, e dali o admin apaga, estica e
   * repinta o que quiser.
   */
  readonly onRandomize?: () => void;
  /**
   * Para que lado a entrada aponta no jogo.
   *
   * `null` = automático: a masmorra gira sozinha para o corredor
   * sair de frente para a casinha. Ver `entranceFacing` em
   * `core/src/types/dungeons.ts`.
   */
  readonly facing?: 0 | 90 | 180 | 270 | null;
  /** Clicar na seta gira. `undefined` = a tela não oferece o gesto. */
  readonly onFacing?: (facing: 0 | 90 | 180 | 270 | null) => void;
}

export function DungeonGridEditor({
  grid,
  onChange,
  onRandomize,
  facing = null,
  onFacing,
}: DungeonGridEditorProps) {
  const [board, setBoard] = useState<Board>(() => boardFromRows(grid));
  const [brush, setBrush] = useState<Brush>('corridor');
  const [painting, setPainting] = useState(false);
  /**
   * A tela cheia.
   *
   * Desenhar num painel que ocupa metade da largura é apertado: com
   * 24 células de lado, cada quadradinho fica com uns 20 pixels, e
   * pintar uma sala de uma célula vira mira. Expandido, o mesmo
   * grid ganha o dobro — e o desenho é a única coisa que importa
   * naquele momento.
   */
  const [expanded, setExpanded] = useState(false);
  /** O desfazer. Guarda o estado ANTES de cada traço, não de cada célula. */
  const [undoStack, setUndoStack] = useState<Board[]>([]);
  const [redoStack, setRedoStack] = useState<Board[]>([]);
  /** Evita repintar a mesma célula cem vezes durante um arrasto. */
  const lastCell = useRef<string>('');
  const svgRef = useRef<SVGSVGElement>(null);

  /**
   * O último desenho que ESTE componente emitiu.
   *
   * ####  ELE EXISTE POR UM DEFEITO MEDIDO  ####
   *
   * O canvas é estado próprio, e `useState(() => …)` só roda o
   * inicializador UMA vez. Quando o grid mudava por fora — o botão
   * de sortear —, a tela continuava mostrando o desenho antigo: o
   * sorteio só aparecia depois de sair do passo e voltar, porque aí
   * o componente era remontado.
   *
   * Comparar com o que eu mesmo emiti separa "o pai mandou um
   * desenho novo" (ressincroniza) de "eu acabei de pintar" (ignora,
   * senão cada traço rebobinaria o canvas).
   */
  const mine = useRef<string>(signatureOf(grid));

  useEffect(() => {
    const incoming = signatureOf(grid);

    if (incoming === mine.current) return;

    const next = boardFromRows(grid);
    const rows = rowsOfBoard(next);
    const normalized = signatureOf(rows);

    mine.current = normalized;
    setBoard(next);
    setUndoStack([]);
    setRedoStack([]);

    // ####  O QUE A TELA MOSTRA É O QUE VAI SER SALVO  ####
    //
    // MEDIDO em 09/09/2026: carregar um traçado não emitia nada, e
    // o rascunho ficava com o desenho que chegou enquanto a tela
    // mostrava outro. Salvar sem encostar no grid gravava um;
    // encostar numa célula gravava o outro.
    //
    // Emitir aqui fecha isso. Só quando há diferença de verdade —
    // um desenho que entra e sai igual não pode marcar a masmorra
    // como alterada só por ter sido aberta.
    if (incoming !== normalized) onChange(rows);
  }, [grid, onChange]);

  const commit = useCallback(
    (next: Board) => {
      const rows = rowsOfBoard(next);

      mine.current = signatureOf(rows);
      setBoard(next);
      onChange(rows);
    },
    [onChange],
  );

  function beginStroke() {
    // O estado inteiro entra na pilha UMA vez por traço. Guardar
    // por célula faria "desfazer" voltar um quadradinho de cada
    // vez, o que é inútil depois de arrastar por vinte células.
    setUndoStack((stack) => [...stack.slice(-29), cloneBoard(board)]);
    setRedoStack([]);
    setPainting(true);
    lastCell.current = '';
  }

  function paint(x: number, z: number) {
    const id = `${String(x)},${String(z)}`;

    if (lastCell.current === id) return;

    lastCell.current = id;

    // A entrada não se apaga: ela é onde o alçapão cospe o
    // jogador, e sem ela a masmorra não tem chegada.
    if (x === board.entrance.x && z === board.entrance.z) return;

    setBoard((current) => {
      const cells = current.cells.map((row) => [...row]);
      const row = cells[z];

      if (row === undefined || row[x] === brush) return current;

      row[x] = brush;

      const next: Board = { ...current, cells };
      const rows = rowsOfBoard(next);

      // Marca ANTES de avisar o pai: o `useEffect` acima vai ver
      // este mesmo desenho voltar como prop, e precisa reconhecê-lo
      // como nosso.
      mine.current = signatureOf(rows);
      onChange(rows);

      return next;
    });
  }

  /**
   * Pinta a célula que está sob o ponteiro.
   *
   * ####  A CONTA É A MATRIZ DO SVG, E NÃO O RETÂNGULO DELE  ####
   *
   * MEDIDO em 09/09/2026, apontado pelo dono: o mouse na célula 0
   * pintava a 7.
   *
   * A causa é o `preserveAspectRatio` padrão. O `viewBox` é
   * quadrado; com `w-full` e `max-h`, a caixa do elemento fica
   * RETANGULAR, e o navegador desenha o conteúdo centralizado com
   * margens vazias dos lados. `getBoundingClientRect()` devolve a
   * caixa inteira — margens incluídas —, e uma regra de três sobre
   * ela erra exatamente o tamanho da margem.
   *
   * `getScreenCTM().inverse()` é a conversão que o próprio SVG
   * usa, e ela vale para qualquer enquadramento — inclusive o da
   * tela cheia, que tem margens diferentes.
   */
  function paintAt(clientX: number, clientY: number) {
    const svg = svgRef.current;

    if (svg === null) return;

    const matrix = svg.getScreenCTM();

    if (matrix === null) return;

    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;

    const local = point.matrixTransform(matrix.inverse());

    const x = Math.floor(local.x / CELL);
    const z = board.size - 1 - Math.floor(local.y / CELL);

    if (x < 0 || x >= board.size || z < 0 || z >= board.size) return;

    paint(x, z);
  }

  function undo() {
    setUndoStack((stack) => {
      const previous = stack[stack.length - 1];

      if (previous === undefined) return stack;

      setRedoStack((redo) => [...redo, cloneBoard(board)]);
      commit(previous);

      return stack.slice(0, -1);
    });
  }

  function redo() {
    setRedoStack((stack) => {
      const next = stack[stack.length - 1];

      if (next === undefined) return stack;

      setUndoStack((undoState) => [...undoState, cloneBoard(board)]);
      commit(next);

      return stack.slice(0, -1);
    });
  }

  // ####  A VERIFICAÇÃO É SOBRE AS LINHAS, NÃO SOBRE O CANVAS  ####
  //
  // As linhas são o formato canônico: é o que se salva, o que a
  // API recebe e o que o agente cobra em `dungeons/layout.ts`.
  // Verificar o canvas 24×24 daria uma terceira implementação das
  // mesmas cinco regras — e a que divergisse seria a que o admin
  // veria.
  const rows = useMemo(() => rowsOfBoard(board), [board]);

  /**
   * Para onde a entrada aponta, em graus de tela.
   *
   * ####  ELA É A MESMA REGRA DO CONSTRUTOR  ####
   *
   * `GridExitYaw`, no plugin: a escolha do admin ganha; sem ela,
   * manda a saída do corredor, na ordem frente, direita, esquerda,
   * trás. Escrever as duas de formas diferentes é o jeito de a seta
   * mentir — e ela já mentiu uma vez.
   *
   * `null` = a entrada não encosta em nada. Não há direção a
   * mostrar, e o verificador reclama disso por outro caminho.
   */
  const entranceArrow = useMemo(() => {
    if (facing !== null) return facing;

    const { entrance, cells, size } = board;
    const at = (x: number, z: number): boolean =>
      x >= 0 && x < size && z >= 0 && z < size && (cells[z]?.[x] ?? 'empty') !== 'empty';

    // 0° é para cima na tela, que é o norte do desenho.
    if (at(entrance.x, entrance.z + 1)) return 0;
    if (at(entrance.x + 1, entrance.z)) return 90;
    if (at(entrance.x - 1, entrance.z)) return 270;
    if (at(entrance.x, entrance.z - 1)) return 180;

    return null;
  }, [board, facing]);
  const problems = useMemo(() => checkLayout(rows), [rows]);
  const facts = useMemo(() => analyzeLayout(rows), [rows]);

  const body = (
    <div className="space-y-3">
      {/* A paleta. Rótulo E cor: identidade nunca vem só da cor, e
          aqui isso pesa porque verde e vermelho são o par que o
          daltonismo mais confunde. */}
      <div className="flex flex-wrap items-center gap-1">
        {BRUSHES.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setBrush(option.id)}
            aria-pressed={brush === option.id}
            title={option.hint}
            className={cn(
              'flex items-center gap-1.5 border px-2 py-1 font-condensed text-2xs uppercase tracking-wide transition-colors',
              brush === option.id
                ? 'border-amber bg-surface-2 text-foreground'
                : 'border-border text-muted hover:text-foreground',
            )}
          >
            {option.id === 'empty' ? (
              <Eraser aria-hidden="true" className="h-3 w-3" />
            ) : (
              <span
                aria-hidden="true"
                className="h-3 w-3 border border-border"
                style={{ backgroundColor: option.color }}
              />
            )}
            {option.label}
          </button>
        ))}

        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={undo} disabled={undoStack.length === 0}>
            <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={redo} disabled={redoStack.length === 0}>
            <Redo2 aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setUndoStack((stack) => [...stack, cloneBoard(board)]);
              commit(blankBoard());
            }}
            aria-label="Limpar o desenho"
          >
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant={expanded ? 'primary' : 'outline'}
            onClick={() => setExpanded((current) => !current)}
            aria-label={expanded ? 'Voltar ao tamanho normal' : 'Desenhar em tela cheia'}
          >
            {expanded ? (
              <Minimize2 aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Maximize2 aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            )}
            {expanded ? 'Reduzir' : 'Expandir'}
          </Button>
        </span>
      </div>

      <div className="relative">
        {facts.cellCount <= 2 && onRandomize !== undefined && (
          // Some no instante em que o admin pinta a terceira célula:
          // ele já começou, e o convite viraria estorvo.
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
            <div className="pointer-events-auto max-w-xs border border-border bg-surface p-4 text-center">
              <p className="font-condensed text-sm font-bold uppercase tracking-wide">
                Comece de algum lugar
              </p>
              <p className="mt-1 text-2xs text-muted">
                Arraste para pintar o corredor e as salas — ou deixe o gerador fazer o primeiro
                traçado, e mexa nele.
              </p>
              <Button size="sm" variant="primary" className="mt-3" onClick={onRandomize}>
                <Dices aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                Sortear um traçado
              </Button>
            </div>
          </div>
        )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${String(board.size * CELL)} ${String(board.size * CELL)}`}
        className={cn(
          'w-full cursor-crosshair touch-none select-none border border-border bg-background',
          expanded ? 'max-h-[76vh]' : 'max-h-[42vh]',
        )}
        role="application"
        aria-label={`Desenho da masmorra, ${String(board.size)} por ${String(board.size)} células`}
        // ####  A CÉLULA VEM DA POSIÇÃO, NÃO DO EVENTO DELA  ####
        //
        // MEDIDO: com `setPointerCapture` no SVG — que é o que faz o
        // arrasto continuar mesmo saindo da figura —, o
        // `pointerenter` dos <rect> filhos PARA DE DISPARAR. Todos
        // os eventos vão para o elemento que capturou.
        //
        // Era por isso que só o clique pintava, e arrastar não fazia
        // nada. Agora a célula é calculada da posição do ponteiro, o
        // que funciona com captura e ainda tira 576 handlers da
        // árvore.
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          beginStroke();
          paintAt(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (painting) paintAt(event.clientX, event.clientY);
        }}
        onPointerUp={() => setPainting(false)}
        onPointerCancel={() => setPainting(false)}
      >
        {board.cells.map((row, z) =>
          row.map((cell, x) => {
            const isEntrance = x === board.entrance.x && z === board.entrance.z;

            return (
              <rect
                key={`${String(x)},${String(z)}`}
                // ####  AS CÉLULAS SÃO INVISÍVEIS AO LEITOR DE TELA
                //
                // MEDIDO: sem isto, as 576 células viram 576 itens
                // na árvore de acessibilidade — e navegar a tela com
                // leitor vira ouvir "apagar" quinhentas vezes. O
                // `<title>` continua valendo como dica do mouse, que
                // é para quem ele serve; quem descreve o conjunto é
                // o `aria-label` do SVG.
                aria-hidden="true"
                x={x * CELL}
                // `z` cresce para o norte no jogo e para baixo na
                // tela — a mesma inversão do mapa.
                y={(board.size - 1 - z) * CELL}
                width={CELL}
                height={CELL}
                fill={isEntrance ? 'var(--amber)' : fillOf(cell)}
                stroke="var(--border)"
                strokeWidth={0.5}
              >
                <title>
                  {isEntrance
                    ? 'A entrada. É aqui que o alçapão cospe o jogador — ela não se apaga.'
                    : labelOf(cell)}
                </title>
              </rect>
            );
          }),
        )}

        {/* ####  A SETA DIZ PARA ONDE A CASINHA FICA VIRADA  ####

            MEDIDO em 09/09/2026, pelo dono, comparando o desenho com
            o jogo: "é a entrada, está virada ao lado contrário do
            corredor, 90 graus". A casinha da superfície apontava para
            um lado e o corredor saía para outro.

            O servidor passou a alinhar os dois sozinho — e esta seta
            é o que torna isso VISÍVEL enquanto se desenha: ela aponta
            para a mesma saída que o construtor vai usar. Sem ela, o
            admin só descobre a direção indo ao jogo.

            `null` = a entrada não encosta em nada, e aí não há
            direção nenhuma para mostrar. O verificador já reclama
            disso por outro caminho. */}
        {entranceArrow !== null && (
          <g
            // ####  CLICAR NA SETA GIRA A ENTRADA  ####
            //
            // Pedido do dono em 09/09/2026: "lá no desenho ter opção
            // para editar e girar na posição que queremos".
            //
            // Cada clique dá um quarto de volta; a quarta volta
            // devolve o automático, para o admin conseguir DESFAZER a
            // escolha sem procurar outro controle.
            role={onFacing === undefined ? undefined : 'button'}
            tabIndex={onFacing === undefined ? undefined : 0}
            aria-label={
              onFacing === undefined
                ? undefined
                : `A entrada aponta para ${ARROW_LABEL[entranceArrow] ?? '?'}. Clique para girar.`
            }
            onPointerDown={(event) => {
              if (onFacing === undefined) return;

              // Sem isto o clique vira um traço de pincel na célula.
              event.stopPropagation();
              onFacing(nextFacing(facing, entranceArrow));
            }}
            transform={
              `translate(${String(board.entrance.x * CELL + CELL / 2)} ` +
              `${String((board.size - 1 - board.entrance.z) * CELL + CELL / 2)}) ` +
              `rotate(${String(entranceArrow)})`
            }
            className={onFacing === undefined ? 'pointer-events-none' : 'cursor-pointer'}
          >
            {/* O alvo do clique é maior que o desenho da seta: a
                célula tem 12 unidades e mirar a ponta de um
                triângulo é pedir precisão que ninguém tem. */}
            <rect
              x={-CELL / 2}
              y={-CELL / 2}
              width={CELL}
              height={CELL}
              fill="transparent"
            />
            <path
              d={`M 0 ${String(-CELL * 0.32)} L ${String(CELL * 0.22)} ${String(CELL * 0.18)} ` +
                 `L 0 ${String(CELL * 0.05)} L ${String(-CELL * 0.22)} ${String(CELL * 0.18)} Z`}
              fill="var(--bg)"
              opacity={0.85}
            />
            <title>
              {facing === null
                ? 'A entrada aponta para o corredor, sozinha. Clique para escolher outro lado.'
                : `A entrada aponta para ${ARROW_LABEL[entranceArrow] ?? '?'}, por sua escolha. Clique para girar.`}
            </title>
          </g>
        )}
      </svg>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-2xs text-muted">
          <Grid2x2 aria-hidden="true" className="h-3.5 w-3.5" />
          {facts.cellCount} células · {facts.roomCount} sala(s) · cada célula é 3×3 metros
        </p>

        <p className="text-2xs text-muted">
          Arraste para pintar. A porta nasce sozinha onde uma sala encosta no corredor.
        </p>
      </div>

      {problems.length > 0 && (
        <ul className="space-y-1">
          {problems.map((problem) => (
            <li
              key={problem}
              className="border-l-2 border-amber bg-surface-2 px-3 py-1.5 text-2xs text-foreground"
            >
              {problem}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  if (!expanded) return body;

  // ####  A TELA CHEIA É O MESMO CORPO, NUM OVERLAY  ####
  //
  // Não é um segundo editor: é este, com mais espaço. Duplicar a
  // tela produziria dois lugares para corrigir cada defeito, e o
  // desenho num deles não estaria no outro.
  //
  // `fixed` funciona dentro do <dialog> porque o overlay é
  // descendente dele, e o diálogo está no top layer.
  return (
    <div className="fixed inset-0 z-50 flex flex-col gap-3 bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
          <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
          Desenhando a masmorra
        </h3>
        <p className="text-2xs text-muted">
          O desenho é o mesmo: fechar aqui não perde nada.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}

// ------------------------------------------------------------
//  O formato salvo
// ------------------------------------------------------------

/**
 * A assinatura de um desenho, para comparar dois.
 *
 * `JSON.stringify` e não `join`: as linhas podem conter qualquer
 * caractere da paleta, e um separador escolhido a dedo é um
 * separador que um dia aparece dentro do dado.
 */
function signatureOf(rows: readonly string[] | null): string {
  return rows === null ? '' : JSON.stringify(rows);
}

function emptyCells(size: number): Canvas {
  return Array.from({ length: size }, () => Array.from({ length: size }, (): Brush => 'empty'));
}

function cloneBoard(board: Board): Board {
  return { ...board, cells: board.cells.map((row) => [...row]) };
}

/** A tela em branco: a entrada no meio, e um passo de corredor. */
function blankBoard(): Board {
  const middle = Math.floor(BASE_SIZE / 2);
  const cells = emptyCells(BASE_SIZE);

  // A entrada e a célula à frente dela nascem como corredor: é a
  // chegada do alçapão, e o desenho começa de algum lugar.
  const entranceRow = cells[middle];
  const nextRow = cells[middle + 1];

  if (entranceRow !== undefined) entranceRow[middle] = 'corridor';
  if (nextRow !== undefined) nextRow[middle] = 'corridor';

  return { size: BASE_SIZE, entrance: { x: middle, z: middle }, cells };
}

/**
 * Lê as linhas salvas de volta para a tela.
 *
 * ####  A TELA SE AJUSTA AO DESENHO, E NÃO O CONTRÁRIO  ####
 *
 * Duas coisas saem daqui, e as duas eram constantes antes:
 *
 *   O TAMANHO. A tela cresce até caber o desenho inteiro, e nunca
 *   passa do teto do formato. Um traçado de 23×23 não é mais
 *   espremido numa tela de 24 com a entrada travada no meio —
 *   ver o cabeçalho de `Board` para o que isso custava.
 *
 *   A ENTRADA. É onde o `E` do desenho está, deslocado junto com
 *   ele. Sem `E` — um desenho antigo, um pedaço colado — ela cai
 *   no centro da tela, que é o comportamento de sempre.
 *
 * O desenho é centralizado no que sobrar de tela. Centralizar o
 * DESENHO, e não a entrada, é o que garante que ele caiba: uma
 * entrada de canto empurraria tudo para fora por um lado só.
 */
export function boardFromRows(rows: readonly string[] | null): Board {
  if (rows === null || rows.length === 0) return blankBoard();

  const height = rows.length;
  const width = Math.max(...rows.map((row) => row.length));

  // A tela cresce só o necessário, e o teto é o do formato: acima
  // dele, o corte é do schema — e ele recusa, em vez de aceitar
  // pela metade.
  const size = Math.min(MAX_SIZE, Math.max(BASE_SIZE, width, height));
  const cells = emptyCells(size);

  const offsetX = Math.max(0, Math.floor((size - width) / 2));
  const offsetZ = Math.max(0, Math.floor((size - height) / 2));

  let entrance: { x: number; z: number } | null = null;

  rows.forEach((row, index) => {
    // As linhas vêm do maior z para o menor: a primeira é a de
    // cima no desenho.
    const z = offsetZ + (height - 1 - index);

    [...row].forEach((char, column) => {
      const x = offsetX + column;
      const target = cells[z];

      if (target === undefined || x >= size) return;

      target[x] = brushOf(char);

      // O primeiro `E` é a entrada. Um segundo é desenho torto de
      // quem editou o JSON à mão, e vira corredor como qualquer
      // outra célula.
      if (char === 'E' && entrance === null) entrance = { x, z };
    });
  });

  const middle = Math.floor(size / 2);

  return { size, entrance: entrance ?? { x: middle, z: middle }, cells };
}

/**
 * Recorta o desenho e o converte para as linhas do formato.
 *
 * Só o retângulo que contém algo é salvo: guardar a tela inteira
 * de vazio faria toda masmorra pequena carregar centenas de
 * pontos inúteis.
 */
export function rowsOfBoard(board: Board): string[] {
  const { size, entrance, cells } = board;

  let minX = size;
  let maxX = -1;
  let minZ = size;
  let maxZ = -1;

  cells.forEach((row, z) => {
    row.forEach((cell, x) => {
      // A entrada entra no retângulo mesmo vazia: sem o `E` nas
      // linhas, o desenho perde a chegada do alçapão.
      if (cell === 'empty' && !(x === entrance.x && z === entrance.z)) return;

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    });
  });

  if (maxX < 0) return [];

  const rows: string[] = [];

  for (let z = maxZ; z >= minZ; z -= 1) {
    let line = '';

    for (let x = minX; x <= maxX; x += 1) {
      if (x === entrance.x && z === entrance.z) {
        line += 'E';
        continue;
      }

      const cell = cells[z]?.[x] ?? 'empty';

      // A letra guarda a COR, e não o número da sala. Ver
      // `CHAR_OF_COLOR`.
      if (cell === 'empty') line += '.';
      else if (cell === 'corridor') line += '#';
      else line += CHAR_OF_COLOR[cell];
    }

    rows.push(line);
  }

  return rows;
}

// ------------------------------------------------------------
//  As invariantes moram em `lib/dungeon-layout.ts`
//
//  ####  ELAS ERAM DAQUI, E ISSO ERA UM PROBLEMA  ####
//
//  Estavam escritas sobre o canvas 24×24 deste componente, e as
//  MESMAS cinco regras estavam escritas sobre as linhas no agente.
//  Duas implementações da mesma coisa, e a que divergisse seria a
//  que o admin veria enquanto desenha.
//
//  Agora este arquivo converte para linhas e chama `checkLayout`,
//  que é o porte fiel do `core/src/dungeons/layout.ts`. Sobrou uma
//  duplicação — a das duas pontas, que são compiladas separadamente
//  — em vez de três.
// ------------------------------------------------------------

function fillOf(cell: Brush): string {
  return BRUSHES.find((brush) => brush.id === cell)?.color ?? 'var(--bg)';
}

function labelOf(cell: Brush): string {
  return BRUSHES.find((brush) => brush.id === cell)?.label ?? 'Vazio';
}

function brushOf(char: string): Brush {
  if (char === '#' || char === 'E') return 'corridor';
  if (char === '.' || char === ' ') return 'empty';

  return COLOR_OF_CHAR[char] ?? 'green';
}

/** O nome de cada quarto de volta, na tela. */
const ARROW_LABEL: Readonly<Record<number, string>> = {
  0: 'cima',
  90: 'direita',
  180: 'baixo',
  270: 'esquerda',
};

/**
 * O próximo lado, a cada clique na seta.
 *
 * ####  A QUARTA VOLTA DEVOLVE O AUTOMÁTICO  ####
 *
 * Sem isso, escolher um lado é uma porta sem volta: o admin teria
 * de saber qual era o automático para reproduzi-lo à mão. Girando
 * quatro vezes ele passa pelos quatro lados e cai de novo no "deixa
 * o servidor decidir", que é onde começou.
 */
function nextFacing(
  current: 0 | 90 | 180 | 270 | null,
  shown: number,
): 0 | 90 | 180 | 270 | null {
  // Sem escolha ainda: o primeiro clique parte do que a seta já
  // mostra, e não do zero — girar tem de mover a seta um quarto,
  // não jogá-la para o norte.
  const from = current ?? (shown as 0 | 90 | 180 | 270);
  const next = ((from + 90) % 360) as 0 | 90 | 180 | 270;

  // Deu a volta inteira: volta ao automático.
  return current !== null && next === (shown as number) ? null : next;
}
