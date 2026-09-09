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
 * O tamanho da tela, em células.
 *
 * 24×24 são 576 células — uma masmorra de 24×24×3 m, ou seja 72
 * metros de lado. É grande o bastante para qualquer coisa que um
 * grupo limpe numa sessão, e pequeno o bastante para o desenho
 * inteiro caber na tela sem rolagem.
 */
const SIZE = 24;

/** O centro da tela é a entrada. Ver o §3 do plano. */
const ENTRANCE = { x: Math.floor(SIZE / 2), z: Math.floor(SIZE / 2) };

type Canvas = Brush[][];

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
}

export function DungeonGridEditor({ grid, onChange, onRandomize }: DungeonGridEditorProps) {
  const [canvas, setCanvas] = useState<Canvas>(() => fromRows(grid));
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
  const [undoStack, setUndoStack] = useState<Canvas[]>([]);
  const [redoStack, setRedoStack] = useState<Canvas[]>([]);
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

    mine.current = incoming;
    setCanvas(fromRows(grid));
    setUndoStack([]);
    setRedoStack([]);
  }, [grid]);

  const commit = useCallback(
    (next: Canvas) => {
      const rows = toRows(next);

      mine.current = signatureOf(rows);
      setCanvas(next);
      onChange(rows);
    },
    [onChange],
  );

  function beginStroke() {
    // O estado inteiro entra na pilha UMA vez por traço. Guardar
    // por célula faria "desfazer" voltar um quadradinho de cada
    // vez, o que é inútil depois de arrastar por vinte células.
    setUndoStack((stack) => [...stack.slice(-29), canvas.map((row) => [...row])]);
    setRedoStack([]);
    setPainting(true);
    lastCell.current = '';
  }

  function paint(x: number, z: number) {
    const id = `${String(x)},${String(z)}`;

    if (lastCell.current === id) return;

    lastCell.current = id;

    // A entrada é fixa: ela é onde o alçapão cospe o jogador, e
    // apagá-la produziria uma masmorra sem chegada.
    if (x === ENTRANCE.x && z === ENTRANCE.z) return;

    setCanvas((current) => {
      const next = current.map((row) => [...row]);
      const row = next[z];

      if (row === undefined || row[x] === brush) return current;

      row[x] = brush;

      const rows = toRows(next);

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
    const z = SIZE - 1 - Math.floor(local.y / CELL);

    if (x < 0 || x >= SIZE || z < 0 || z >= SIZE) return;

    paint(x, z);
  }

  function undo() {
    setUndoStack((stack) => {
      const previous = stack[stack.length - 1];

      if (previous === undefined) return stack;

      setRedoStack((redo) => [...redo, canvas.map((row) => [...row])]);
      commit(previous);

      return stack.slice(0, -1);
    });
  }

  function redo() {
    setRedoStack((stack) => {
      const next = stack[stack.length - 1];

      if (next === undefined) return stack;

      setUndoStack((undoState) => [...undoState, canvas.map((row) => [...row])]);
      commit(next);

      return stack.slice(0, -1);
    });
  }

  const problems = useMemo(() => validateCanvas(canvas), [canvas]);
  const counts = useMemo(() => countCanvas(canvas), [canvas]);

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
              setUndoStack((stack) => [...stack, canvas.map((row) => [...row])]);
              commit(blankCanvas());
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
        {counts.cells <= 2 && onRandomize !== undefined && (
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
        viewBox={`0 0 ${String(SIZE * CELL)} ${String(SIZE * CELL)}`}
        className={cn(
          'w-full cursor-crosshair touch-none select-none border border-border bg-background',
          expanded ? 'max-h-[76vh]' : 'max-h-[52vh]',
        )}
        role="application"
        aria-label="Desenho da masmorra, 24 por 24 células"
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
        {canvas.map((row, z) =>
          row.map((cell, x) => {
            const isEntrance = x === ENTRANCE.x && z === ENTRANCE.z;

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
                y={(SIZE - 1 - z) * CELL}
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
      </svg>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-2xs text-muted">
          <Grid2x2 aria-hidden="true" className="h-3.5 w-3.5" />
          {counts.cells} células · {counts.rooms} sala(s) · cada célula é 3×3 metros
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

function blankCanvas(): Canvas {
  const canvas: Canvas = Array.from({ length: SIZE }, () =>
    Array.from({ length: SIZE }, (): Brush => 'empty'),
  );

  // A entrada e a célula à frente dela nascem como corredor: é a
  // chegada do alçapão, e o desenho começa de algum lugar.
  const entranceRow = canvas[ENTRANCE.z];
  const nextRow = canvas[ENTRANCE.z + 1];

  if (entranceRow !== undefined) entranceRow[ENTRANCE.x] = 'corridor';
  if (nextRow !== undefined) nextRow[ENTRANCE.x] = 'corridor';

  return canvas;
}

/**
 * Lê as linhas salvas de volta para a tela.
 *
 * ####  O ALINHAMENTO É PELO `E`, E NÃO PELO CENTRO  ####
 *
 * MEDIDO em 09/09/2026, e apontado pelo dono olhando um traçado
 * sorteado: centrando o desenho, o `E` das linhas caía num lugar e
 * a entrada FIXA do editor ficava em outro — sozinha, cercada de
 * vazio.
 *
 * Isso não é cosmético. A entrada é onde o alçapão cospe o
 * jogador: ilhada, ele cai dentro de um quadrado fechado e o
 * evento acaba ali.
 *
 * Alinhando pelo `E`, o desenho inteiro se desloca para que a
 * entrada dele coincida com a do editor. Sem `E` nas linhas — um
 * desenho antigo, ou um pedaço colado —, cai no centro, que é o
 * comportamento anterior.
 */
function fromRows(rows: readonly string[] | null): Canvas {
  const canvas = blankCanvas();

  if (rows === null || rows.length === 0) return canvas;

  const height = rows.length;
  const width = Math.max(...rows.map((row) => row.length));

  let offsetX = Math.max(0, ENTRANCE.x - Math.floor(width / 2));
  let offsetZ = Math.max(0, ENTRANCE.z - Math.floor(height / 2));

  // Onde está o `E` no desenho que chegou.
  for (const [index, row] of rows.entries()) {
    const column = row.indexOf('E');

    if (column < 0) continue;

    // As linhas vêm do maior z para o menor.
    offsetX = ENTRANCE.x - column;
    offsetZ = ENTRANCE.z - (height - 1 - index);
    break;
  }

  rows.forEach((row, index) => {
    // As linhas vêm do maior z para o menor: a primeira é a de
    // cima no desenho.
    const z = offsetZ + (height - 1 - index);

    [...row].forEach((char, column) => {
      const x = offsetX + column;
      const target = canvas[z];

      if (target === undefined || x >= SIZE) return;

      target[x] = brushOf(char);
    });
  });

  return canvas;
}

/**
 * Recorta o desenho e o converte para as linhas do formato.
 *
 * Só o retângulo que contém algo é salvo: guardar 24×24 de vazio
 * faria toda masmorra pequena carregar 500 pontos inúteis.
 */
function toRows(canvas: Canvas): string[] {
  let minX = SIZE;
  let maxX = -1;
  let minZ = SIZE;
  let maxZ = -1;

  canvas.forEach((row, z) => {
    row.forEach((cell, x) => {
      if (cell === 'empty' && !(x === ENTRANCE.x && z === ENTRANCE.z)) return;

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
      if (x === ENTRANCE.x && z === ENTRANCE.z) {
        line += 'E';
        continue;
      }

      const cell = canvas[z]?.[x] ?? 'empty';

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

/**
 * Cada mancha contígua da mesma cor vira uma sala, com sua letra.
 *
 * É o preenchimento por vizinhança do cabeçalho: é ele que separa
 * "duas salas vermelhas" de "uma sala vermelha grande" sem o admin
 * precisar nomear nada.
 */
function findRooms(canvas: Canvas): Map<string, string> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const assigned = new Map<string, string>();
  const seen = new Set<string>();
  let next = 0;

  for (let z = 0; z < SIZE; z += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const cell = canvas[z]?.[x];

      if (cell === undefined || cell === 'empty' || cell === 'corridor') continue;

      const id = `${String(x)},${String(z)}`;

      if (seen.has(id)) continue;

      const letter = letters[next % letters.length] ?? 'A';
      next += 1;

      // Uma busca em largura pela mancha daquela cor.
      const queue = [[x, z] as const];
      seen.add(id);

      while (queue.length > 0) {
        const point = queue.pop();

        if (point === undefined) break;

        assigned.set(`${String(point[0])},${String(point[1])}`, letter);

        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = point[0] + dx;
          const nz = point[1] + dz;
          const neighbourId = `${String(nx)},${String(nz)}`;

          if (seen.has(neighbourId)) continue;
          if (canvas[nz]?.[nx] !== cell) continue;

          seen.add(neighbourId);
          queue.push([nx, nz] as const);
        }
      }
    }
  }

  return assigned;
}

// ------------------------------------------------------------
//  As invariantes, cobradas enquanto se desenha
// ------------------------------------------------------------

/**
 * O que está errado no desenho, em português.
 *
 * ####  CINCO DEFEITOS, E NENHUM DELES DÁ ERRO NO JOGO  ####
 *
 * É essa a razão de o verificador existir. Uma entrada ilhada, uma
 * sala lacrada, um pedaço de corredor sem ligação, um cômodo sem
 * parede e um bloco flutuando SOBEM NORMALMENTE: o servidor
 * constrói o que foi mandado, sem reclamar de nada. O defeito só
 * aparece quando um jogador está lá dentro, e aí já é tarde.
 *
 * Cobrar aqui — enquanto o admin desenha, e não no salvamento — é
 * o que faz ele corrigir ainda lembrando o que quis fazer.
 */
function validateCanvas(canvas: Canvas): string[] {
  const problems: string[] = [];
  const rooms = findRooms(canvas);

  // 1. Toda sala precisa encostar num corredor — é ali que a porta
  //    nasce. Sem isso, o cômodo fica lacrado.
  const touching = new Set<string>();

  for (const [id, letter] of rooms) {
    const [x, z] = id.split(',').map(Number) as [number, number];

    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const neighbour = canvas[z + dz]?.[x + dx];

      if (neighbour === 'corridor') touching.add(letter);
    }
  }

  const allRooms = new Set(rooms.values());
  const sealed = [...allRooms].filter((letter) => !touching.has(letter));

  if (sealed.length > 0) {
    problems.push(
      sealed.length === 1
        ? `A sala ${sealed[0] ?? ''} não encosta em nenhum corredor: ninguém consegue entrar nela.`
        : `${String(sealed.length)} salas não encostam em corredor nenhum: ninguém consegue entrar nelas.`,
    );
  }

  // 2. A ENTRADA precisa encostar em corredor. É por ela que o
  //    jogador chega: sozinha, ele cai dentro de um quadrado
  //    fechado e o evento acaba ali.
  let entranceTouches = false;

  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    if (canvas[ENTRANCE.z + dz]?.[ENTRANCE.x + dx] === 'corridor') entranceTouches = true;
  }

  if (!entranceTouches) {
    problems.push(
      'A entrada não encosta em nenhum corredor: o jogador desceria para dentro de um quadrado fechado.',
    );
  }

  // 3. O corredor precisa ser um só, e chegar à entrada. Um pedaço
  //    solto é uma parte da masmorra que nunca será visitada.
  const corridor: string[] = [];

  canvas.forEach((row, z) => {
    row.forEach((cell, x) => {
      if (cell === 'corridor') corridor.push(`${String(x)},${String(z)}`);
    });
  });

  if (corridor.length === 0) {
    problems.push('Não há corredor nenhum: comece ligando a entrada ao resto.');
  } else {
    const reachable = new Set<string>();
    const start = `${String(ENTRANCE.x)},${String(ENTRANCE.z)}`;
    const queue = [start];
    reachable.add(start);

    while (queue.length > 0) {
      const current = queue.pop();

      if (current === undefined) break;

      const [x, z] = current.split(',').map(Number) as [number, number];

      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const id = `${String(x + dx)},${String(z + dz)}`;

        if (reachable.has(id) || canvas[z + dz]?.[x + dx] !== 'corridor') continue;

        reachable.add(id);
        queue.push(id);
      }
    }

    const orphans = corridor.filter((id) => !reachable.has(id)).length;

    if (orphans > 0) {
      problems.push(
        `${String(orphans)} célula(s) de corredor não chegam na entrada: essa parte fica ilhada.`,
      );
    }
  }

  // 4. Uma sala de UMA célula encostada em corredor por três lados
  //    nasce sem parede em lugar nenhum: o construtor mata a parede
  //    entre células da mesma sala, e o vão vira porta em cada lado
  //    que toca o corredor. Três portas num cômodo de 3x3 metros é
  //    um cômodo sem parede.
  const wide = new Map<string, number>();

  for (const letter of rooms.values()) wide.set(letter, (wide.get(letter) ?? 0) + 1);

  let openRooms = 0;

  for (const [id, letter] of rooms) {
    if ((wide.get(letter) ?? 0) > 1) continue;

    const [x, z] = id.split(',').map(Number) as [number, number];
    let sides = 0;

    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (canvas[z + dz]?.[x + dx] === 'corridor') sides += 1;
    }

    if (sides >= 3) openRooms += 1;
  }

  if (openRooms > 0) {
    problems.push(
      `${String(openRooms)} sala(s) de uma célula têm corredor em três lados: elas nascem quase sem parede. Aumente-as, ou afaste o corredor.`,
    );
  }

  // 5. Célula solta — nem corredor nem grudada em corredor por
  //    outra sala. Ela vira um bloco isolado no meio do nada, e o
  //    jogador vê um pedaço de construção flutuando.
  let floating = 0;

  canvas.forEach((row, z) => {
    row.forEach((cell, x) => {
      if (cell === 'empty') return;

      let neighbours = 0;

      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        if ((canvas[z + dz]?.[x + dx] ?? 'empty') !== 'empty') neighbours += 1;
      }

      if (neighbours === 0) floating += 1;
    });
  });

  if (floating > 0) {
    problems.push(
      `${String(floating)} célula(s) estão soltas, sem encostar em nada: elas viram blocos flutuando no meio do nada.`,
    );
  }

  return problems;
}

function countCanvas(canvas: Canvas): { cells: number; rooms: number } {
  let cells = 0;

  for (const row of canvas) {
    for (const cell of row) if (cell !== 'empty') cells += 1;
  }

  return { cells, rooms: new Set(findRooms(canvas).values()).size };
}

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
