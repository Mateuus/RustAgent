'use client';

// ============================================================
//  construction-step.tsx  -  a masmorra feita à mão, no jogo.
//
//  ####  O PASSO ② DO MODO CONSTRUÇÃO  ####
//
//  Nos outros modos, o passo ② é o tamanho (receita) ou o desenho
//  (planta). Aqui a masmorra já existe — alguém a construiu dentro do
//  Rust e subiu o .json na aba Plantas —, e o que falta decidir é:
//
//    qual construção      os cartões da biblioteca (`kind: 'base'`)
//    onde o jogador chega a árvore de Natal, ou a posição à mão
//    o que nasce onde     os pontos: lápides, velas e os manuais
//
//  ####  A JUNÇÃO É DO AGENTE  ####
//
//  "Ler marcadores" manda os pontos atuais ao agente, que devolve a
//  lista juntada — sem duplicar, sem passar por cima do que o admin
//  mudou. A tela só troca `draft.body` pelo que voltou. Reescrever a
//  junção aqui seria ter duas réguas para a mesma lista.
//
//  ####  E A CONFERÊNCIA NÃO MEXE EM NADA  ####
//
//  Cada mudança de ponto dispara, depois de uma pausa, a MESMA rota —
//  mas o que volta dela só alimenta os avisos ("dentro da parede",
//  "sem piso"). Aplicar a junção a cada tecla moveria pontos debaixo
//  do cursor de quem está digitando. Quando a planta mudou desde a
//  última leitura, a tela DIZ isso e oferece reler.
//
//  ####  A CHEGADA NUNCA É ESCOLHIDA EM SILÊNCIO  ####
//
//  Sem árvore de Natal na planta, ou com mais de uma, o agente devolve
//  a chegada vazia de propósito. A tela pede ao admin que escolha —
//  uma das árvores, ou a posição à mão — e não salva sem isso.
// ============================================================

import {
  Crosshair,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  ScanSearch,
  Skull,
  Trash2,
  TreePine,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/help-tip';
import { Input } from '@/components/ui/input';
import { StepBody } from '@/components/ui/steps';
import {
  agent,
  BODY_METERS,
  BODY_PROFILES,
  MAX_BODY_POINTS,
  type BlueprintSummary,
  type BodyArrival,
  type BodyMarker,
  type BodyMerge,
  type BodyPoint,
  type BodyPointProblem,
  type BodyProfile,
  type BodyScanResponse,
  type DungeonBody,
  type DungeonInput,
  type PlacementKind,
} from '@/lib/api';
import {
  arrivalFromMarker,
  clampMeters,
  floorHeightAt,
  floorLevels,
  levelOf,
  newPointId,
  normalizeYaw,
  problemsByTarget,
  profileTotals,
  readingWouldChange,
  sameSpot,
  startingSpot,
  type PlanePoint,
} from '@/lib/dungeon-body';
import { DUNGEON_HELP } from '@/lib/help/dungeons';
import { cn } from '@/lib/utils';

import { ARRIVAL_ID, BodyPreview, BodyPreviewLegend } from './body-preview';
import {
  DUNGEON_CRATE_GROUPS,
  DUNGEON_CRATES,
  DUNGEON_NPC_GROUPS,
  DUNGEON_NPCS,
} from './crate-catalog';
import { PrefabCombobox } from './prefab-combobox';

/** Quanto a conferência espera o admin parar de mexer. */
const CHECK_DELAY_MS = 600;

export const PROFILE_LABEL: Readonly<Record<BodyProfile, string>> = {
  green: 'Sala verde',
  blue: 'Sala azul',
  red: 'Sala vermelha',
  corridor: 'Corredor',
};

const PROFILE_SWATCH: Readonly<Record<BodyProfile, string>> = {
  green: 'var(--olive)',
  blue: 'var(--chart-2)',
  red: 'var(--rust-red)',
  corridor: 'var(--text-muted)',
};

const KIND_LABEL: Readonly<Record<PlacementKind, string>> = {
  npc: 'Inimigo',
  crate: 'Caixa',
};

/**
 * Os avisos da chegada que impedem salvar.
 *
 * Os mesmos da rota (`assertBlueprintExists`): a chegada sem chão é o
 * único ponto que prende uma PESSOA. Os outros ficam como aviso.
 */
const BLOCKING_ARRIVAL: ReadonlySet<BodyPointProblem['code']> = new Set([
  'outside',
  'no_floor',
  'inside_floor',
]);

const ARRIVAL_STATE_TEXT: Readonly<Record<BodyMerge['arrivalState'], string>> = {
  marker: 'A chegada veio da árvore de Natal da planta.',
  manual: 'A chegada é a que você definiu: ler a planta não a troca.',
  missing: 'A planta não tem árvore de Natal: defina a chegada abaixo.',
  ambiguous: 'A planta tem mais de uma árvore de Natal: escolha a chegada abaixo.',
};

/** O último scan, e para qual rascunho ele foi feito. */
interface ScanState {
  readonly response: BodyScanResponse;
  readonly signature: string;
  /**
   * `read` = a junção já foi aplicada ao rascunho. Os números dela
   * ("3 novos") falam do que ACABOU de entrar, e não de uma novidade
   * pendente — só a conferência (`check`) pode dizer que a planta tem
   * algo que a lista não tem.
   */
  readonly kind: 'read' | 'check';
}

export interface ConstructionStepProps {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
  readonly blueprints: readonly BlueprintSummary[];
}

export function ConstructionStep({ draft, patch, blueprints }: ConstructionStepProps) {
  const body = draft.body;
  const bodies = blueprints.filter((blueprint) => blueprint.kind === 'base');

  const [scan, setScan] = useState<ScanState | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  /** "Ler marcadores" em voo: a lista fica inerte até a junção voltar. */
  const [reading, setReading] = useState(false);
  const [checking, setChecking] = useState(false);
  /** O resultado da última leitura aplicada. */
  const [report, setReport] = useState<BodyMerge | null>(null);
  /** A construção que o admin clicou, esperando a confirmação da troca. */
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** O ponto (ou a chegada) que o próximo clique na prévia posiciona. */
  const [placing, setPlacing] = useState<string | null>(null);
  /** O índice do andar mostrado na prévia. `null` = todos. */
  const [level, setLevel] = useState<number | null>(null);

  /** Só a resposta do pedido MAIS NOVO vale. */
  const sequence = useRef(0);
  /** O rascunho que o último pedido já cobriu — para não conferir duas vezes. */
  const covered = useRef('');

  const runScan = useCallback(
    async (mode: 'read' | 'check', target: DungeonBody) => {
      sequence.current += 1;

      const mine = sequence.current;

      covered.current = signatureOf(target);
      setScanError(null);

      if (mode === 'read') setReading(true);
      else setChecking(true);

      try {
        const response = await agent.scanDungeonBody(target.blueprint, {
          points: target.points,
          arrival: target.arrival,
        });

        if (mine !== sequence.current) return;

        if (mode === 'read') {
          const next: DungeonBody = {
            blueprint: target.blueprint,
            arrival: response.merged.arrival,
            points: response.merged.points,
          };

          covered.current = signatureOf(next);
          setScan({ response, signature: covered.current, kind: 'read' });
          setReport(response.merged);
          patch({ body: next });
          return;
        }

        setScan({ response, signature: signatureOf(target), kind: 'check' });
      } catch (cause) {
        if (mine !== sequence.current) return;

        // A frase da API vem inteira: "a planta gravada não é mais um
        // JSON legível" ensina mais que qualquer resumo daqui.
        setScanError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (mine === sequence.current) {
          setReading(false);
          setChecking(false);
        }
      }
    },
    [patch],
  );

  const signature = body === null ? '' : signatureOf(body);
  /** Nada foi lido ainda: é a masmorra gravada, aberta agora. */
  const firstLook = scan === null;

  // ####  A CONFERÊNCIA ESPERA O ADMIN PARAR  ####
  //
  // Uma por tecla seria um JSON de meio megabyte relido a cada
  // dígito. A pausa é curta o bastante para o aviso aparecer antes de
  // o admin tirar a mão do teclado — e não existe na primeira vez,
  // em que ninguém está digitando e a prévia está vazia.
  useEffect(() => {
    if (body === null || reading) return undefined;
    if (signature === covered.current) return undefined;

    const timer = setTimeout(
      () => {
        void runScan('check', body);
      },
      firstLook ? 0 : CHECK_DELAY_MS,
    );

    return () => clearTimeout(timer);
  }, [body, signature, reading, firstLook, runScan]);

  const analysis = scan?.response.analysis ?? null;
  const levels = analysis === null ? [] : floorLevels(analysis.pieces);
  const levelHeight = level === null ? null : (levels[level] ?? null);
  const trees = analysis?.markers.arrival ?? [];
  const problems = problemsByTarget(scan?.response.problems ?? []);

  // O aviso da chegada só vale se o agente conferiu ESTA chegada: com
  // a planta mudada, ele conferiu a da árvore nova.
  const arrivalProblems =
    scan !== null && body !== null && sameSpot(scan.response.merged.arrival, body.arrival)
      ? (problems.get(ARRIVAL_ID) ?? [])
      : [];

  const pointIds = new Set((body?.points ?? []).map((point) => point.id));
  const flagged = new Set([...problems.keys()].filter((id) => pointIds.has(id)));

  if (arrivalProblems.length > 0) flagged.add(ARRIVAL_ID);

  // A novidade pendente só existe numa conferência do rascunho que
  // está na tela: com o admin digitando, a resposta de antes fala de
  // outra lista.
  const pending =
    scan !== null &&
    scan.kind === 'check' &&
    scan.signature === signature &&
    body !== null &&
    readingWouldChange(scan.response.merged, { arrival: body.arrival })
      ? scan.response.merged
      : null;

  function choose(id: string): void {
    if (body !== null && body.blueprint === id) return;

    // ####  TROCAR A CONSTRUÇÃO RECOMEÇA A LISTA  ####
    //
    // As coordenadas são da planta ANTIGA: um inimigo em (4, 0, -7)
    // numa construção é uma parede em outra. Recomeçar é a única
    // leitura honesta — e por isso ela pede confirmação quando há
    // trabalho para perder.
    if (body !== null && (body.points.length > 0 || body.arrival !== null)) {
      setSwitchTo(id);
      return;
    }

    begin(id);
  }

  function begin(id: string): void {
    const fresh: DungeonBody = { blueprint: id, arrival: null, points: [] };

    setSwitchTo(null);
    setScan(null);
    setReport(null);
    setSelected(null);
    setPlacing(null);
    setLevel(null);
    patch({ body: fresh });
    void runScan('read', fresh);
  }

  function setPoints(points: BodyPoint[]): void {
    if (body === null) return;

    patch({ body: { ...body, points } });
  }

  function updatePoint(id: string, change: Partial<BodyPoint>): void {
    if (body === null) return;

    setPoints(body.points.map((point) => (point.id === id ? { ...point, ...change } : point)));
  }

  function removePoint(id: string): void {
    if (body === null) return;

    setPoints(body.points.filter((point) => point.id !== id));

    if (selected === id) setSelected(null);
    if (placing === id) setPlacing(null);
  }

  function addPoint(kind: PlacementKind): void {
    if (body === null || body.points.length >= MAX_BODY_POINTS) return;

    const spot = startingSpot(analysis, levelHeight);
    const id = newPointId(new Set(body.points.map((point) => point.id)));
    const count = body.points.filter((point) => point.kind === kind).length + 1;

    setPoints([
      ...body.points,
      {
        id,
        kind,
        label: `${KIND_LABEL[kind]} ${String(count)}`,
        ...spot,
        yaw: 0,
        profile: 'green',
        amount: 1,
        prefab: '',
        source: 'manual',
      },
    ]);

    // O ponto novo nasce no meio da construção e já esperando o
    // clique: é o gesto que quem clicou em "adicionar" vai fazer.
    setSelected(id);
    setPlacing(id);
  }

  function setArrival(arrival: BodyArrival | null): void {
    if (body === null) return;

    patch({ body: { ...body, arrival } });
  }

  function defineArrivalByHand(): void {
    setArrival({ ...startingSpot(analysis, levelHeight), yaw: 0, source: 'manual' });
    setSelected(ARRIVAL_ID);
    setPlacing(ARRIVAL_ID);
  }

  function place(spot: PlanePoint): void {
    // Durante a leitura, a lista vai ser trocada pela junção: um ponto
    // movido agora seria desfeito em silêncio.
    if (body === null || placing === null || reading) return;

    // O clique vale no decímetro: é a precisão que um mouse dá numa
    // prévia de 30 m. O ajuste fino é nos campos.
    const x = clampMeters(Math.round(spot.x * 10) / 10);
    const z = clampMeters(Math.round(spot.z * 10) / 10);

    // ####  O PONTO ASSENTA NO PISO QUE ESTÁ EMBAIXO DO CLIQUE  ####
    //
    // Olhando UM andar, o clique é naquele andar: o ponto que estava
    // em outro sobe (ou desce) para ele. Olhando todos, vale o piso
    // embaixo do clique mais perto da altura que o ponto já tinha.
    // Sem piso nenhum ali, a altura fica — e a conferência avisa.
    const heightFor = (y: number): number => {
      const wanted =
        levelHeight !== null && levels.length > 1 && Math.max(0, levelOf(y, levels)) !== level
          ? levelHeight
          : y;

      return clampMeters(floorHeightAt(analysis?.pieces ?? [], { x, z }, wanted) ?? wanted);
    };

    if (placing === ARRIVAL_ID) {
      if (body.arrival !== null) {
        setArrival({ ...body.arrival, x, z, y: heightFor(body.arrival.y), source: 'manual' });
      }
    } else {
      const target = body.points.find((point) => point.id === placing);

      if (target !== undefined) updatePoint(placing, { x, z, y: heightFor(target.y) });
    }

    setSelected(placing);
    setPlacing(null);
  }

  const chosen = body === null ? undefined : blueprints.find((blueprint) => blueprint.id === body.blueprint);

  return (
    <StepBody
      title="A construção que vira masmorra"
      hint="Construa no jogo, salve com o CopyPaste e suba o .json na aba Plantas como corpo. Aqui você escolhe qual usar, onde o jogador chega e o que nasce em cada ponto."
    >
      <div>
        <FieldLabel topic={DUNGEON_HELP.constructionMode}>Qual construção</FieldLabel>

        {bodies.length === 0 ? (
          <div className="mt-2 border border-border bg-surface-2 p-3 text-xs text-muted">
            <p className="text-foreground">Nenhuma construção de corpo no acervo.</p>
            <ol className="mt-1 ml-4 list-decimal space-y-0.5">
              <li>Construa a masmorra dentro do jogo, num lugar qualquer do mapa.</li>
              <li>
                Marque com uma <strong className="text-foreground">lápide</strong> cada inimigo,
                com um <strong className="text-foreground">conjunto de velas grandes</strong> cada
                caixa, e com uma <strong className="text-foreground">árvore de Natal</strong> a
                chegada.
              </li>
              <li>Salve com o CopyPaste.</li>
              <li>
                Na aba <strong className="text-foreground">Plantas</strong>, suba o .json e
                escolha <strong className="text-foreground">Corpo da masmorra</strong>.
              </li>
            </ol>
          </div>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {bodies.map((blueprint) => (
              <BodyCard
                key={blueprint.id}
                blueprint={blueprint}
                active={body?.blueprint === blueprint.id}
                disabled={reading}
                onClick={() => choose(blueprint.id)}
              />
            ))}
          </div>
        )}

        {body !== null && chosen?.kind !== 'base' && (
          <p className="mt-2 border-l-2 border-amber pl-2 text-2xs text-foreground">
            {chosen === undefined
              ? `A construção "${body.blueprint}" não está mais no acervo: escolha outra, ou suba o arquivo de novo com o mesmo nome.`
              : `"${chosen.name}" está marcada como entrada no acervo. Troque o papel dela para corpo na aba Plantas, ou escolha outra.`}
          </p>
        )}
      </div>

      {switchTo !== null && body !== null && (
        <div className="border-l-2 border-amber bg-surface-2 px-3 py-2">
          <p className="text-xs text-foreground">
            Trocar a construção recomeça a lista: {body.points.length} ponto(s)
            {body.arrival === null ? '' : ' e a chegada'} são posições da planta atual, e cairiam em
            qualquer lugar na outra.
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="danger" onClick={() => begin(switchTo)}>
              Trocar e recomeçar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSwitchTo(null)}>
              Manter a atual
            </Button>
          </div>
        </div>
      )}

      {body !== null && (
        <>
          <ScanBar
            reading={reading}
            checking={checking}
            error={scanError}
            report={report}
            analysis={analysis}
            stale={pending}
            onRead={() => void runScan('read', body)}
            onCheck={() => void runScan('check', body)}
          />

          {/* A prévia à direita, parada enquanto a lista rola: numa lista
              de oitenta pontos, é ela que diz onde cada linha está. */}
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,36rem)]">
            <div className="order-2 min-w-0 space-y-3 lg:order-1">
              <fieldset disabled={reading} className="min-w-0 space-y-3">
                <ArrivalEditor
                  arrival={body.arrival}
                  trees={trees}
                  scanned={analysis !== null}
                  problems={arrivalProblems}
                  selected={selected === ARRIVAL_ID}
                  placing={placing === ARRIVAL_ID}
                  onChange={setArrival}
                  onDefine={defineArrivalByHand}
                  onSelect={() => setSelected(ARRIVAL_ID)}
                  onPlace={() => {
                    setSelected(ARRIVAL_ID);
                    setPlacing((now) => (now === ARRIVAL_ID ? null : ARRIVAL_ID));
                  }}
                />

                <PointList
                  points={body.points}
                  problems={problems}
                  selected={selected}
                  placing={placing}
                  onSelect={setSelected}
                  onChange={updatePoint}
                  onRemove={removePoint}
                  onAdd={addPoint}
                  onPlace={(id) => {
                    setSelected(id);
                    setPlacing((now) => (now === id ? null : id));
                  }}
                />
              </fieldset>
            </div>

            <div className="order-1 min-w-0 lg:order-2">
              <div className="space-y-2 lg:sticky lg:top-0">
                {placing !== null && (
                  <p className="flex items-center justify-between gap-2 border-l-2 border-amber bg-surface-2 px-2 py-1.5 text-2xs text-foreground">
                    <span className="flex items-center gap-1.5">
                      <Crosshair aria-hidden="true" className="h-3.5 w-3.5 text-amber" />
                      Clique no desenho para pôr{' '}
                      {placing === ARRIVAL_ID
                        ? 'a chegada'
                        : `"${body.points.find((point) => point.id === placing)?.label || 'o ponto'}"`}{' '}
                      ali.
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setPlacing(null)}>
                      Cancelar
                    </Button>
                  </p>
                )}

                {analysis === null ? (
                  <div className="flex min-h-48 items-center justify-center border border-border bg-background text-xs text-muted">
                    {reading || checking ? (
                      <span className="flex items-center gap-2">
                        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                        Lendo a construção…
                      </span>
                    ) : (
                      'A prévia aparece depois da primeira leitura.'
                    )}
                  </div>
                ) : (
                  <BodyPreview
                    analysis={analysis}
                    points={body.points}
                    arrival={body.arrival}
                    selected={selected}
                    flagged={flagged}
                    levels={levels}
                    level={level}
                    placing={placing !== null}
                    onSelect={(id) => {
                      setSelected(id);

                      // Levar o admin até a linha do ponto: numa lista de
                      // oitenta, achar "Inimigo 37" rolando é o gesto que a
                      // prévia existe para poupar.
                      if (id !== null) {
                        document
                          .getElementById(rowId(id))
                          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                      }
                    }}
                    onPlace={place}
                  />
                )}

                {levels.length > 1 && (
                  <label className="flex items-center gap-2 text-2xs text-muted">
                    <span className="font-condensed uppercase tracking-wide">Andar</span>
                    <select
                      value={level === null ? '' : String(level)}
                      onChange={(event) =>
                        setLevel(event.target.value === '' ? null : Number(event.target.value))
                      }
                      className="h-7 border border-border bg-background px-1 text-2xs text-foreground"
                    >
                      <option value="">Todos, sobrepostos</option>
                      {levels.map((height, index) => (
                        <option key={height} value={String(index)}>
                          {`${String(index + 1)}º (piso a ${meters(height)} m)`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <BodyPreviewLegend
                  npcs={body.points.filter((point) => point.kind === 'npc').length}
                  crates={body.points.filter((point) => point.kind === 'crate').length}
                  hasArrival={body.arrival !== null}
                  trees={trees.length}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </StepBody>
  );
}

// ------------------------------------------------------------
//  A escolha da construção
// ------------------------------------------------------------

function BodyCard({
  blueprint,
  active,
  disabled,
  onClick,
}: {
  readonly blueprint: BlueprintSummary;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  // `?? null`: um agente de antes da contagem não manda o campo.
  const markers = blueprint.markers ?? null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'border p-3 text-left transition-colors disabled:cursor-wait',
        active ? 'border-rust bg-rust/10' : 'border-border bg-surface-2 hover:border-muted',
      )}
    >
      <span className="block truncate font-condensed text-xs font-bold uppercase tracking-wide">
        {blueprint.name}
      </span>
      <span className="mt-1 block text-2xs text-muted">
        {blueprint.entityCount} peças ·{' '}
        {markers === null
          ? 'marcadores ainda não contados'
          : `${String(markers.npc)} inimigo(s) · ${String(markers.crate)} caixa(s) · ${String(markers.arrival)} árvore(s)`}
      </span>

      {markers !== null && markers.arrival !== 1 && (
        <span className="mt-1 block border-l-2 border-amber pl-2 text-2xs text-foreground">
          {markers.arrival === 0
            ? 'Sem árvore de Natal: a chegada será definida à mão.'
            : `${String(markers.arrival)} árvores de Natal: você escolhe qual é a chegada.`}
        </span>
      )}
    </button>
  );
}

// ------------------------------------------------------------
//  A barra da leitura
// ------------------------------------------------------------

function ScanBar({
  reading,
  checking,
  error,
  report,
  analysis,
  stale,
  onRead,
  onCheck,
}: {
  readonly reading: boolean;
  readonly checking: boolean;
  readonly error: string | null;
  readonly report: BodyMerge | null;
  readonly analysis: BodyScanResponse['analysis'] | null;
  /** A junção que reler aplicaria, quando ela mudaria alguma coisa. */
  readonly stale: BodyMerge | null;
  readonly onRead: () => void;
  readonly onCheck: () => void;
}) {
  const busy = reading || checking;

  return (
    <div className="space-y-2 border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel topic={DUNGEON_HELP.bodyMarkers} className="text-xs font-bold text-foreground">
          Os marcadores da planta
        </FieldLabel>

        <span className="flex flex-wrap items-center gap-1">
          {busy && (
            <span className="flex items-center gap-1 text-2xs text-muted">
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              {reading ? 'lendo…' : 'conferindo…'}
            </span>
          )}

          <Button size="sm" variant="primary" disabled={reading} onClick={onRead}>
            <ScanSearch aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Ler marcadores
          </Button>

          <Button size="sm" variant="outline" disabled={busy} onClick={onCheck}>
            <RefreshCw aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Conferir de novo
          </Button>
        </span>
      </div>

      {analysis !== null && (
        <p className="text-2xs text-muted">
          Na planta: <strong className="text-foreground">{analysis.markers.npc.length}</strong>{' '}
          lápide(s) (inimigos),{' '}
          <strong className="text-foreground">{analysis.markers.crate.length}</strong> conjunto(s)
          de velas (caixas) e{' '}
          <strong className="text-foreground">{analysis.markers.arrival.length}</strong> árvore(s)
          de Natal (chegada), em {analysis.entityCount} peças.
        </p>
      )}

      {report !== null && (
        <p className="border-l-2 border-olive pl-2 text-2xs text-foreground">
          Leitura aplicada: {report.added} novo(s), {report.kept} mantido(s), {report.removed}{' '}
          removido(s)
          {report.manual > 0 ? `, e ${String(report.manual)} ponto(s) seu(s) intocado(s)` : ''}.{' '}
          {ARRIVAL_STATE_TEXT[report.arrivalState]}
        </p>
      )}

      {stale !== null && (
        <p className="border-l-2 border-amber pl-2 text-2xs text-foreground">
          A planta tem novidade que a lista não tem
          {stale.added > 0 ? ` — ${String(stale.added)} marcador(es) novo(s)` : ''}
          {stale.removed > 0 ? ` — ${String(stale.removed)} ponto(s) cujo marcador sumiu` : ''}
          {stale.added === 0 && stale.removed === 0 ? ' — a árvore de Natal mudou' : ''}. Clique em{' '}
          <strong>Ler marcadores</strong> para trazer. Um ponto de marcador que você removeu conta
          como novo: para tirá-lo de vez, tire o marcador da construção.
        </p>
      )}

      {analysis !== null && analysis.warnings.length > 0 && (
        <div>
          <FieldLabel topic={DUNGEON_HELP.bodyNotImported}>O que não sobe</FieldLabel>
          <ul className="mt-1 space-y-1">
            {analysis.warnings.map((warning) => (
              <li key={warning} className="border-l-2 border-amber pl-2 text-2xs text-foreground">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error !== null && (
        <p className="border-l-2 border-rust pl-2 text-2xs text-foreground">{error}</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  A chegada
// ------------------------------------------------------------

function ArrivalEditor({
  arrival,
  trees,
  scanned,
  problems,
  selected,
  placing,
  onChange,
  onDefine,
  onSelect,
  onPlace,
}: {
  readonly arrival: BodyArrival | null;
  readonly trees: readonly BodyMarker[];
  /** Já houve uma leitura: sem ela, "zero árvores" ainda não é um fato. */
  readonly scanned: boolean;
  readonly problems: readonly BodyPointProblem[];
  readonly selected: boolean;
  readonly placing: boolean;
  readonly onChange: (arrival: BodyArrival | null) => void;
  readonly onDefine: () => void;
  readonly onSelect: () => void;
  readonly onPlace: () => void;
}) {
  const inUse = (tree: BodyMarker): boolean =>
    arrival !== null && sameSpot(tree, { x: arrival.x, y: arrival.y, z: arrival.z, yaw: arrival.yaw });

  const onlyTree = trees.length === 1 ? trees[0] : undefined;

  // A lista de árvores aparece quando há ESCOLHA a fazer: mais de uma,
  // ou uma só que não é a chegada atual.
  const offerTrees = trees.length > 1 || (onlyTree !== undefined && arrival !== null && !inUse(onlyTree));

  function edit(change: Partial<BodyArrival>): void {
    if (arrival === null) return;

    // ####  MEXEU, VIROU SUA  ####
    //
    // A chegada vinda da árvore seria trocada de volta na próxima
    // leitura. A que o admin ajustou, não.
    onChange({ ...arrival, ...change, source: 'manual' });
  }

  const blocking = problems.some((problem) => BLOCKING_ARRIVAL.has(problem.code));

  return (
    <section
      // O mesmo endereço das linhas de ponto: clicar na seta da prévia
      // leva o admin até aqui.
      id={rowId(ARRIVAL_ID)}
      className={cn('border bg-surface-2 p-3', selected ? 'border-rust' : 'border-border')}
      onFocusCapture={onSelect}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel topic={DUNGEON_HELP.bodyArrival} className="text-xs font-bold text-foreground">
          <TreePine aria-hidden="true" className="h-3.5 w-3.5 text-olive" />
          A chegada do jogador
        </FieldLabel>

        {arrival !== null && (
          <span className="text-2xs text-muted">
            {arrival.source === 'marker' ? 'da árvore de Natal' : 'definida por você'}
          </span>
        )}
      </div>

      <p className="mt-1 text-2xs leading-relaxed text-muted">
        A árvore de Natal marca a <strong className="text-foreground">entrada e a chegada</strong>:
        quem desce pela casinha aparece aqui, olhando para onde a seta aponta, e o alçapão de subir
        nasce em cima deste ponto. Não muda o respawn — quem morre lá dentro volta para o saco de
        dormir ou para a praia.
      </p>

      {arrival === null ? (
        <div className="mt-2 space-y-2">
          <p className="border-l-2 border-amber pl-2 text-2xs text-foreground">
            {!scanned
              ? 'A chegada ainda não foi definida. Leia os marcadores, ou defina a posição à mão.'
              : trees.length === 0
                ? 'A planta não tem árvore de Natal. Defina a chegada à mão — ou ponha uma árvore na construção e suba o arquivo de novo. A masmorra não salva sem ela.'
                : trees.length === 1
                  ? 'A planta tem uma árvore de Natal: clique em Ler marcadores para usá-la, ou defina a chegada à mão.'
                  : `A planta tem ${String(trees.length)} árvores de Natal, e o painel não escolhe por você: use uma delas, ou defina a chegada à mão. A masmorra não salva sem ela.`}
          </p>

          <Button size="sm" variant="outline" onClick={onDefine}>
            <Crosshair aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Definir à mão
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <NumberField
              label="x (direita)"
              value={arrival.x}
              min={BODY_METERS.min}
              max={BODY_METERS.max}
              normalize={clampMeters}
              onCommit={(x) => edit({ x })}
            />
            <NumberField
              label="y (altura)"
              value={arrival.y}
              min={BODY_METERS.min}
              max={BODY_METERS.max}
              normalize={clampMeters}
              onCommit={(y) => edit({ y })}
            />
            <NumberField
              label="z (frente)"
              value={arrival.z}
              min={BODY_METERS.min}
              max={BODY_METERS.max}
              normalize={clampMeters}
              onCommit={(z) => edit({ z })}
            />
            <NumberField
              label="Olha para (°)"
              value={arrival.yaw}
              min={0}
              max={360}
              normalize={normalizeYaw}
              onCommit={(yaw) => edit({ yaw })}
            />
          </div>

          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant={placing ? 'primary' : 'outline'} onClick={onPlace}>
              <Crosshair aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              {placing ? 'Clique no desenho…' : 'Mover no desenho'}
            </Button>

            {onlyTree !== undefined && arrival.source === 'manual' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onChange({
                    x: onlyTree.x,
                    y: onlyTree.y,
                    z: onlyTree.z,
                    yaw: onlyTree.yaw,
                    source: 'marker',
                  })
                }
              >
                Voltar para a árvore
              </Button>
            )}
          </div>
        </div>
      )}

      {offerTrees && (
        <ul className="mt-2 space-y-1">
          {trees.map((tree, index) => (
            <li
              key={tree.id}
              className="flex flex-wrap items-center justify-between gap-2 border border-border bg-surface px-2 py-1"
            >
              <span className="text-2xs text-muted">
                <TreePine aria-hidden="true" className="mr-1 inline h-3 w-3 text-olive" />
                Árvore {index + 1}: x {meters(tree.x)} · y {meters(tree.y)} · z {meters(tree.z)} ·{' '}
                {meters(tree.yaw)}°
              </span>
              {inUse(tree) ? (
                <span className="text-2xs text-foreground">em uso</span>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onChange(arrivalFromMarker(tree))}>
                  Usar esta árvore
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {problems.length > 0 && (
        <ul className="mt-2 space-y-1">
          {problems.map((problem) => (
            <li key={problem.code} className="border-l-2 border-amber pl-2 text-2xs text-foreground">
              {problem.message}
            </li>
          ))}
          {blocking && (
            <li className="border-l-2 border-rust pl-2 text-2xs text-foreground">
              Com este aviso a masmorra não salva: a chegada é o único ponto que prende um jogador.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------
//  Os pontos
// ------------------------------------------------------------

function PointList({
  points,
  problems,
  selected,
  placing,
  onSelect,
  onChange,
  onRemove,
  onAdd,
  onPlace,
}: {
  readonly points: readonly BodyPoint[];
  readonly problems: ReadonlyMap<string, readonly BodyPointProblem[]>;
  readonly selected: string | null;
  readonly placing: string | null;
  readonly onSelect: (id: string) => void;
  readonly onChange: (id: string, change: Partial<BodyPoint>) => void;
  readonly onRemove: (id: string) => void;
  readonly onAdd: (kind: PlacementKind) => void;
  readonly onPlace: (id: string) => void;
}) {
  const npcs = points.filter((point) => point.kind === 'npc').length;
  const full = points.length >= MAX_BODY_POINTS;

  return (
    <section className="border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel topic={DUNGEON_HELP.bodyPoints} className="text-xs font-bold text-foreground">
          Onde nasce cada inimigo e cada caixa
        </FieldLabel>

        <span className="flex gap-1">
          <Button size="sm" variant="outline" disabled={full} onClick={() => onAdd('npc')}>
            <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Adicionar inimigo
          </Button>
          <Button size="sm" variant="outline" disabled={full} onClick={() => onAdd('crate')}>
            <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Adicionar caixa
          </Button>
        </span>
      </div>

      <p className="mt-1 text-2xs text-muted">
        {points.length === 0
          ? 'Nenhum ponto ainda. Ponha lápides e velas na construção e leia os marcadores, ou adicione aqui.'
          : `${String(npcs)} inimigo(s) e ${String(points.length - npcs)} caixa(s), de ${String(MAX_BODY_POINTS)} possíveis. O conteúdo de cada perfil vem do passo "Salas e loot".`}
      </p>

      {points.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {points.map((point) => (
            <PointRow
              key={point.id}
              point={point}
              problems={problems.get(point.id) ?? []}
              selected={point.id === selected}
              placing={point.id === placing}
              onSelect={() => onSelect(point.id)}
              onChange={(change) => onChange(point.id, change)}
              onRemove={() => onRemove(point.id)}
              onPlace={() => onPlace(point.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PointRow({
  point,
  problems,
  selected,
  placing,
  onSelect,
  onChange,
  onRemove,
  onPlace,
}: {
  readonly point: BodyPoint;
  readonly problems: readonly BodyPointProblem[];
  readonly selected: boolean;
  readonly placing: boolean;
  readonly onSelect: () => void;
  readonly onChange: (change: Partial<BodyPoint>) => void;
  readonly onRemove: () => void;
  readonly onPlace: () => void;
}) {
  const name = point.label === '' ? KIND_LABEL[point.kind] : point.label;

  return (
    <li
      id={rowId(point.id)}
      // Mexer num campo da linha seleciona o ponto: o admin vê na
      // prévia QUAL inimigo está editando.
      onFocusCapture={onSelect}
      className={cn('border bg-surface p-2', selected ? 'border-rust' : 'border-border')}
    >
      {/* ####  TRÊS FAIXAS: QUEM É, O QUE NASCE, ONDE  ####

          Numa fileira só, os onze campos quebravam em lugares
          diferentes a cada largura — e o botão de remover ia parar
          embaixo do tipo, onde ninguém o procura. */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="flex items-center gap-1 font-condensed text-2xs uppercase tracking-wide text-muted">
            {point.kind === 'npc' ? (
              <Skull aria-hidden="true" className="h-3.5 w-3.5 text-rust" />
            ) : (
              <Package aria-hidden="true" className="h-3.5 w-3.5 text-amber" />
            )}
            Tipo
          </span>
          <select
            value={point.kind}
            onChange={(event) =>
              // O prefab é de um tipo: a caixa escolhida não serve de
              // inimigo. Trocar o tipo volta ao "o que o perfil usa".
              onChange({ kind: event.target.value as PlacementKind, prefab: '' })
            }
            className="mt-1 h-9 border border-border bg-background px-2 text-sm"
          >
            <option value="npc">Inimigo</option>
            <option value="crate">Caixa</option>
          </select>
        </label>

        <label className="block min-w-32 flex-1">
          <span className="block font-condensed text-2xs uppercase tracking-wide text-muted">
            Nome
          </span>
          <Input
            className="mt-1"
            value={point.label}
            maxLength={40}
            placeholder={point.kind === 'npc' ? 'Chefe' : 'Arsenal'}
            onChange={(event) => onChange({ label: event.target.value })}
          />
        </label>

        <span className="flex gap-1">
          <Button
            size="sm"
            variant={placing ? 'primary' : 'outline'}
            className="h-9"
            onClick={onPlace}
            aria-label={`Mover ${name} clicando no desenho`}
          >
            <Crosshair aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            {placing ? 'Clique…' : 'Mover'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            onClick={onRemove}
            aria-label={`Remover ${name}`}
            title={
              point.source === 'marker'
                ? 'Remove da lista. O marcador continua na planta, e volta na próxima leitura.'
                : 'Remove o ponto.'
            }
          >
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <FieldLabel topic={DUNGEON_HELP.bodyProfile}>Perfil</FieldLabel>
          <span className="mt-1 flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0"
              style={{ backgroundColor: PROFILE_SWATCH[point.profile] }}
            />
            <select
              value={point.profile}
              aria-label={`Perfil de ${name}`}
              onChange={(event) => onChange({ profile: event.target.value as BodyProfile })}
              className="h-9 border border-border bg-background px-2 text-sm"
            >
              {BODY_PROFILES.map((profile) => (
                <option key={profile} value={profile}>
                  {PROFILE_LABEL[profile]}
                </option>
              ))}
            </select>
          </span>
        </div>

        <label className="block">
          <span className="block font-condensed text-2xs uppercase tracking-wide text-muted">
            Quantos
          </span>
          <Input
            type="number"
            min={1}
            max={8}
            className="mt-1 w-16"
            value={point.amount}
            onChange={(event) => onChange({ amount: clampAmount(event.target.value) })}
          />
        </label>

        <div className="min-w-48 flex-1">
          <span className="block font-condensed text-2xs uppercase tracking-wide text-muted">
            {point.kind === 'npc' ? 'Tipo de inimigo' : 'Tipo de caixa'}
          </span>
          <div className="mt-1">
            <PrefabCombobox
              value={point.prefab}
              onChange={(prefab) => onChange({ prefab })}
              entries={point.kind === 'npc' ? DUNGEON_NPCS : DUNGEON_CRATES}
              groups={point.kind === 'npc' ? DUNGEON_NPC_GROUPS : DUNGEON_CRATE_GROUPS}
              emptyLabel={point.kind === 'npc' ? 'O inimigo padrão da masmorra' : 'Uma das caixas do perfil'}
              ariaLabel={`Prefab de ${name}`}
            />
          </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <NumberField
          label="x (direita)"
          value={point.x}
          min={BODY_METERS.min}
          max={BODY_METERS.max}
          normalize={clampMeters}
          onCommit={(x) => onChange({ x })}
        />
        <NumberField
          label="y (altura)"
          value={point.y}
          min={BODY_METERS.min}
          max={BODY_METERS.max}
          normalize={clampMeters}
          onCommit={(y) => onChange({ y })}
        />
        <NumberField
          label="z (frente)"
          value={point.z}
          min={BODY_METERS.min}
          max={BODY_METERS.max}
          normalize={clampMeters}
          onCommit={(z) => onChange({ z })}
        />
        <NumberField
          label={point.kind === 'npc' ? 'Olha para (°)' : 'Giro (°)'}
          value={point.yaw}
          min={0}
          max={360}
          normalize={normalizeYaw}
          onCommit={(yaw) => onChange({ yaw })}
        />
      </div>

      <p className="mt-1.5 text-2xs text-muted">
        {point.source === 'marker'
          ? point.kind === 'npc'
            ? 'Veio de uma lápide da planta.'
            : 'Veio de um conjunto de velas da planta.'
          : 'Adicionado por você.'}
      </p>

      {point.amount > 4 && (
        <p className="mt-1 border-l-2 border-border pl-2 text-2xs text-muted">
          Acima de quatro no mesmo ponto eles nascem encostados uns nos outros.
        </p>
      )}

      {problems.length > 0 && (
        <ul className="mt-1 space-y-1">
          {problems.map((problem) => (
            <li key={problem.code} className="border-l-2 border-amber pl-2 text-2xs text-foreground">
              {problem.message}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Um número de metros (ou graus) que se digita inteiro.
 *
 * ####  O TEXTO É DO CAMPO ENQUANTO ELE TEM O FOCO  ####
 *
 * Coordenada é negativa metade das vezes, e o `-` sozinho não é um
 * número: com o valor amarrado direto ao estado, o campo virava "0" no
 * meio da digitação. Enquanto o admin digita, o campo guarda o texto;
 * cada leitura que dá número vira valor. Fora do foco, o campo mostra
 * o valor — inclusive o que mudou por fora, pelo clique na prévia.
 */
function NumberField({
  label,
  value,
  min,
  max,
  normalize,
  className,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** O que o número vira antes de valer: `clampMeters` ou `normalizeYaw`. */
  readonly normalize: (value: number) => number;
  readonly className?: string;
  /** Recebe o número já normalizado. */
  readonly onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(() => String(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);

  return (
    <label className={cn('block', className)}>
      <span className="font-condensed text-2xs uppercase tracking-wide text-muted">{label}</span>
      <Input
        type="number"
        inputMode="decimal"
        // ####  `any`, E O PASSO DE 0,1 É DAS SETAS  ####
        //
        // MEDIDO na tela: com `step={0.1}`, o navegador marcava como
        // INVÁLIDO todo valor lido da planta (5,849 não é múltiplo de
        // 0,1) — e o leitor de tela anunciava isso em cada campo. O
        // passo fica no teclado: seta anda dez centímetros, e com Shift
        // um metro.
        step="any"
        min={min}
        max={max}
        value={text}
        className="mt-1 tabular-nums"
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

          event.preventDefault();

          const delta = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 1 : 0.1);
          // A normalização é a do campo: o metro para na borda, e o
          // giro dá a volta (359,95 + 0,1 = 0,05).
          const next = normalize(Math.round((value + delta) * 1000) / 1000);

          setText(String(next));
          onCommit(next);
        }}
        onChange={(event) => {
          const raw = event.target.value;
          const parsed = Number.parseFloat(raw.replace(',', '.'));

          setText(raw);

          if (raw.trim() !== '' && Number.isFinite(parsed)) onCommit(normalize(parsed));
        }}
      />
    </label>
  );
}

// ------------------------------------------------------------
//  O resumo ao lado de "Salas e loot"
// ------------------------------------------------------------

/**
 * O que cada perfil vai receber.
 *
 * Nos modos de células, a prévia ao lado das salas é a masmorra
 * sorteada. Aqui não há sorteio: o que ajuda quem está mexendo na
 * tabela da sala vermelha é saber QUANTOS pontos obedecem a ela.
 */
export function BodyProfileSummary({ body }: { readonly body: DungeonBody | null }) {
  if (body === null) {
    return (
      <div className="border border-border bg-surface p-3 text-2xs text-muted">
        Escolha a construção no passo <strong className="text-foreground">Construção</strong>: é lá
        que cada ponto recebe o perfil que usa estas configurações.
      </div>
    );
  }

  const totals = profileTotals(body.points);

  return (
    <div className="border border-border bg-surface">
      <header className="border-b border-border px-3 py-2">
        <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
          <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
          Quem usa cada perfil
        </h3>
      </header>

      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left font-condensed text-2xs uppercase tracking-wide text-muted">
            <th className="px-3 py-1.5">Perfil</th>
            <th className="px-3 py-1.5 text-right">Inimigos</th>
            <th className="px-3 py-1.5 text-right">Caixas</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {BODY_PROFILES.map((profile) => {
            const total = totals[profile];

            return (
              <tr key={profile}>
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0"
                      style={{ backgroundColor: PROFILE_SWATCH[profile] }}
                    />
                    {PROFILE_LABEL[profile]}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {total.npcs}
                  <span className="text-muted"> em {total.npcPoints}</span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {total.crates}
                  <span className="text-muted"> em {total.cratePoints}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="border-t border-border px-3 py-2 text-2xs text-muted">
        &ldquo;3 em 2&rdquo; são três que nascem em dois pontos. Quantos nascem é a quantidade de
        cada ponto; aqui você decide <strong className="text-foreground">o que</strong> nasce.
      </p>
    </div>
  );
}

// ------------------------------------------------------------

/**
 * A assinatura de um corpo, para saber se o agente já o conferiu.
 *
 * `JSON.stringify` do próprio objeto: a tela compara o rascunho com o
 * que ELA mandou, e os dois são o mesmo objeto — a ordem das chaves
 * não tem como divergir.
 */
function signatureOf(body: DungeonBody): string {
  return JSON.stringify(body);
}

function rowId(pointId: string): string {
  return `body-point-${pointId}`;
}

function clampAmount(raw: string): number {
  const parsed = Number.parseInt(raw, 10);

  if (Number.isNaN(parsed)) return 1;

  return Math.min(8, Math.max(1, parsed));
}

function meters(value: number): string {
  return value.toFixed(1).replace('.', ',');
}
