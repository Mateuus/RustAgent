'use client';

// ============================================================
//  dungeon-dialog.tsx  -  montar uma masmorra sem ler manual.
//
//  ####  SÃO MAIS DE CEM CAMPOS  ####
//
//  Numa tela só, ninguém preenche o décimo. Então eles viram uma
//  trilha de seis passos, e cada passo cabe numa tela:
//
//    ① identidade   ② tamanho, mistura e material
//    ③ salas, loot, portas trancadas e ciclo do loot
//    ④ os inimigos, o drop e o comportamento
//    ⑤ a entrada, quem desce por ela e o que ninguém tira do lugar
//    ⑥ construir
//
//  ####  E O QUE NÃO CABE NUM PASSO VIRA ABA  ####
//
//  O comportamento sozinho são dezenove campos em cinco lugares —
//  o padrão da masmorra, cada cor de sala e o corredor. Empilhá-los
//  daria noventa e cinco caixas no passo ④. Eles moram em
//  `ai-fields.tsx`, atrás de uma aba por lugar, e a aba diz quantos
//  campos aquele lugar mudou: sem isso, achar onde se mexeu exigiria
//  abrir as cinco.
//
//  A tabela de loot segue a mesma ideia em `loot-table-fields.tsx`:
//  enquanto o modo é "a do servidor" — o padrão, e o que quase toda
//  masmorra quer — não há tabela nenhuma na tela.
//
//  ####  E A PRÉVIA ANDA JUNTO  ####
//
//  Ela fica ao lado dos passos ② a ④ — os que mexem em números
//  cujo efeito ninguém adivinha. O admin arrasta o peso da sala
//  vermelha e VÊ a masmorra mudar, com o mesmo algoritmo que vai
//  rodar no servidor.
//
//  Sem isso, "peso vermelho: 15" é um número sem tradução, e
//  balancear vira tentativa e erro de wipe em wipe.
//
//  ####  O PASSO ⑥ TERMINA SOZINHO  ####
//
//  Ele mostra o comando, e então FICA OLHANDO: pergunta ao agente,
//  de dois em dois segundos, se nasceu alguma masmorra desta
//  depois que o passo abriu. Quando nasce, ele mesmo avança.
//
//  É a diferença entre uma instrução e um assistente. Ver
//  Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §12.1.1.
// ============================================================

import { Check, Copy, Dices, Loader2, Plus, RotateCcw, RotateCw, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { AiFields, resolveAi } from '@/components/dungeons/ai-fields';
import { DungeonGridEditor } from '@/components/dungeons/dungeon-grid-editor';
import { DungeonPreviewPanel } from '@/components/dungeons/dungeon-preview';
import { LayoutThumb } from '@/components/dungeons/layout-thumb';
import { LootTableFields } from '@/components/dungeons/loot-table-fields';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FieldLabel } from '@/components/ui/help-tip';
import { Input } from '@/components/ui/input';
import { StepBody, Steps, type Step } from '@/components/ui/steps';
import { Toggle } from '@/components/ui/toggle';
import {
  previewFromGrid,
  previewLayout,
  wideDoorStats,
  type DungeonPreview,
} from '@/lib/dungeon-layout';
import {
  agent,
  BUILD_GRADES,
  ROOM_DOORS,
  type AccessWhoEnters,
  type AiSpec,
  type BlueprintSummary,
  type BuildGrade,
  type Dungeon,
  type DungeonAccess,
  type DungeonInput,
  type DungeonLayoutSummary,
  type DungeonLock,
  type DungeonProtection,
  type DungeonAnnounce,
  type DungeonMarker,
  type DungeonRoom,
  type EntranceItemMode,
  type EventRun,
  type GradeSet,
  type LootTable,
  type RoomColor,
  type RoomDoor,
} from '@/lib/api';
import { DUNGEON_HELP } from '@/lib/help/dungeons';
import { cn } from '@/lib/utils';

/** De quanto em quanto tempo o passo ⑥ pergunta ao agente. */
const WATCH_INTERVAL_MS = 2_000;

const COLOR_LABEL: Readonly<Record<RoomColor, string>> = {
  green: 'Verde',
  blue: 'Azul',
  red: 'Vermelha',
};

const DOOR_LABEL: Readonly<Record<RoomDoor, string>> = {
  wood: 'Madeira',
  metal: 'Metal',
  toptier: 'Blindada',
  industrial: 'De fábrica',
  double_wood: 'Dupla de madeira',
  double_metal: 'Dupla de metal',
  double_toptier: 'Dupla blindada',
  cell_gate: 'Grade de cela',
  fence_gate: 'Portão de tela',
  garage: 'Portão de garagem',
  none: 'Sem porta (vão aberto)',
};

/** As de dois metros: elas nascem num quadro, e não num vão de porta. */
const WIDE_DOORS: readonly RoomDoor[] = [
  'double_wood',
  'double_metal',
  'double_toptier',
  'cell_gate',
  'fence_gate',
  'garage',
];

/**
 * O MATERIAL de cada porta.
 *
 * ####  O AVISO É SOBRE MATERIAL, E NÃO SOBRE A FOLHA  ####
 *
 * Com onze portas, comparar a folha escolhida com "a folha daquela
 * cor" gritaria em quase toda escolha — e um aviso que aparece
 * sempre deixa de ser lido. `cell_gate` numa sala vermelha não é
 * erro: é desenho. Madeira numa sala vermelha continua sendo uma
 * promessa quebrada.
 */
const DOOR_MATERIAL: Readonly<Record<RoomDoor, 'wood' | 'metal' | 'toptier' | 'open'>> = {
  wood: 'wood',
  double_wood: 'wood',
  fence_gate: 'wood',
  metal: 'metal',
  double_metal: 'metal',
  industrial: 'metal',
  cell_gate: 'metal',
  garage: 'metal',
  toptier: 'toptier',
  double_toptier: 'toptier',
  none: 'open',
};

/** A que a cor da sala corresponde. Manter isso é o que faz a cor avisar. */
const MATERIAL_OF_COLOR: Readonly<Record<RoomColor, 'wood' | 'metal' | 'toptier'>> = {
  green: 'wood',
  blue: 'metal',
  red: 'toptier',
};

const GRADE_LABEL: Readonly<Record<BuildGrade, string>> = {
  twigs: 'Palha',
  wood: 'Madeira',
  stone: 'Pedra',
  metal: 'Metal',
  toptier: 'Blindado',
};

const CARRIER_LABEL: Readonly<Record<DungeonLock['carrier'], string>> = {
  npc: 'Um inimigo',
  crate: 'Uma caixa',
  none: 'Ninguém (as salas ficam trancadas)',
};

const SCOPE_LABEL: Readonly<Record<DungeonLock['carrierScope'], string>> = {
  corridor: 'No corredor',
  anywhere: 'Em qualquer lugar (menos na própria sala)',
};

const UNDELIVERED_LABEL: Readonly<Record<DungeonLock['onUndelivered'], string>> = {
  unlock: 'Destranca a sala',
  keep: 'Deixa trancada mesmo assim',
};

/**
 * Quem desce pelo alçapão.
 *
 * `everyone` vem primeiro porque é o padrão E o pedido do dono: a
 * masmorra é do servidor inteiro, e fechá-la exige dizer isso.
 */
const WHO_ENTERS_LABEL: Readonly<Record<AccessWhoEnters, string>> = {
  everyone: 'Todo o servidor',
  permission: 'Só quem tem a permissão',
};

/**
 * O que a casinha da entrada carrega dentro.
 *
 * A ordem é a do risco: o padrão primeiro. Ver o §7 de
 * Docs/OrigemZDurgeon/02-AS-SETE-PENDENCIAS.md.
 */
const ENTRANCE_ITEMS_LABEL: Readonly<Record<EntranceItemMode, string>> = {
  none: 'Nada — as caixas nascem vazias',
  unarmed: 'Só o que não é arma',
  all: 'Tudo que a planta guardava',
};

/** A tabela de loot que não muda nada: o padrão de todo campo novo. */
const SERVER_TABLE: LootTable = { mode: 'server', rolls: { min: 1, max: 2 }, entries: [] };

const CRATE_NORMAL = 'assets/bundled/prefabs/radtown/crate_normal.prefab';
const CRATE_ELITE = 'assets/bundled/prefabs/radtown/crate_elite.prefab';

/** Os campos que toda sala tem e que quase ninguém mexe. */
function room(
  key: RoomColor,
  npc: { min: number; max: number },
  loot: { min: number; max: number },
  crate: string,
  door: RoomDoor,
  locked: boolean,
): DungeonRoom {
  return {
    key,
    color: key,
    npc,
    loot,
    crates: [crate],
    door,
    locked,
    wideDoor: null,
    wideDoorCellsPerDoor: 4,
    grade: null,
    table: { ...SERVER_TABLE },
    ai: {},
  };
}

const EMPTY: DungeonInput = {
  id: '',
  name: '',
  description: null,
  mode: 'recipe',
  entranceBlueprint: null,
  entranceItems: 'none',
  entranceRotation: 0,
  entranceFacing: null,
  marker: { enabled: true, label: 'Masmorra', color: '#ff0000', alpha: 0.55, radius: 0.5 },
  announce: { enabled: true, onBuild: '', onEnd: '', showGrid: true },
  size: { min: 10, max: 15 },
  weights: { green: 60, blue: 30, red: 10 },
  corridor: {
    npcDensity: 20,
    lootDensity: 10,
    crates: ['assets/bundled/prefabs/radtown/crate_normal.prefab'],
    table: { ...SERVER_TABLE },
    ai: {},
  },
  grid: null,
  npc: {
    health: { min: 100, max: 150 },
    damageScale: 1,
    weapons: ['rifle.semiauto', 'pistol.m92'],
    names: ['Guardião', 'Sentinela'],
    loot: { ...SERVER_TABLE },
    ai: {},
  },
  timeOfDay: 0,
  structure: { foundation: 'stone', wall: 'stone', ceiling: 'stone' },
  lock: {
    enabled: true,
    sharedCode: false,
    carrier: 'npc',
    carrierScope: 'corridor',
    onUndelivered: 'unlock',
    noteTitle: 'Código da porta',
    announceOpen: true,
    warnOnWrongCode: true,
  },
  // Os dois padrões abaixo são os do plugin, e é isso que faz o
  // sync não gastar byte nenhum com eles. Mudar um aqui sem mudar o
  // outro lado é o jeito de quebrar isto em silêncio.
  access: { whoEnters: 'everyone', enterPermission: '' },
  protection: { enabled: true, allowAdmin: true, warnOnAttempt: true },
  respawn: { enabled: false, minutes: 30, onlyWhenEmpty: true, rebuildDestroyed: true },
  rooms: [
    room('green', { min: 0, max: 1 }, { min: 1, max: 1 }, CRATE_NORMAL, 'wood', false),
    room('blue', { min: 1, max: 2 }, { min: 1, max: 2 }, CRATE_NORMAL, 'metal', false),
    room('red', { min: 2, max: 3 }, { min: 2, max: 3 }, CRATE_ELITE, 'toptier', true),
  ],
};

export interface DungeonDialogProps {
  /** `null` = criando. */
  readonly dungeon: Dungeon | null;
  readonly blueprints: readonly BlueprintSummary[];
  /** O acervo de traçados: é deles que o modo desenho parte. */
  readonly layouts: readonly DungeonLayoutSummary[];
  /**
   * O traçado com que a masmorra nova já nasce.
   *
   * É o atalho do botão "Usar" da aba Plantas: sem ele, quem
   * escolheu um traçado ali teria de abrir a criação, trocar o modo
   * para desenho e procurar o mesmo traçado outra vez. Ignorado na
   * edição — trocar o desenho de uma masmorra que já existe é
   * decisão de quem edita, não efeito de abrir a tela.
   */
  readonly startFrom?: readonly string[] | null;
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}

export function DungeonDialog({
  dungeon,
  blueprints,
  layouts,
  startFrom = null,
  servers,
  onClose,
  onSaved,
}: DungeonDialogProps) {
  const [draft, setDraft] = useState<DungeonInput>(() => {
    if (dungeon !== null) return toInput(dungeon);

    if (startFrom !== null && startFrom.length > 0) {
      return { ...EMPTY, mode: 'blueprint', grid: [...startFrom] };
    }

    return EMPTY;
  });
  const [step, setStep] = useState('identidade');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Já existe no banco: o passo ⑥ pode oferecer o comando. */
  const [saved, setSaved] = useState(dungeon !== null);
  /** A semente da prévia. Só muda quando o admin pede outra. */
  const [seed, setSeed] = useState(1);

  const patch = useCallback((change: Partial<DungeonInput>) => {
    setDraft((current) => ({ ...current, ...change }));
  }, []);

  const problems = validate(draft);

  // ####  O ✓ PASSA A SIGNIFICAR "EU MEXI AQUI"  ####
  //
  // MEDIDO em 09/09/2026, apontado pelo dono ("as config está muito
  // confusa"): quatro dos seis passos tinham `done: true` cravado.
  // O trilho mostrava seis vistos verdes numa masmorra recém-criada
  // em que ninguém tinha aberto passo nenhum.
  //
  // Um selo que aparece sempre não informa nada — e este informava
  // ERRADO, dizendo "pronto" sobre uma tela em branco.
  const touched = whatChanged(draft);

  const steps: Step[] = [
    {
      id: 'identidade',
      label: 'Identidade',
      problem: problems.identidade,
      done: draft.name !== '' && draft.id !== '',
    },
    {
      id: 'tamanho',
      label: draft.mode === 'blueprint' ? 'Desenho' : 'Tamanho',
      problem: problems.tamanho,
      done: touched.tamanho,
    },
    { id: 'salas', label: 'Salas e loot', problem: problems.salas, done: draft.rooms.length > 0 },
    { id: 'inimigos', label: 'Inimigos', problem: problems.inimigos, done: touched.inimigos },
    { id: 'entrada', label: 'Entrada e acesso', done: touched.entrada },
    { id: 'anuncio', label: 'Mapa e chat', done: touched.anuncio },
    { id: 'construir', label: 'Construir', done: saved },
  ];

  const blocking = Object.values(problems).filter((problem) => problem !== undefined);

  async function save() {
    setBusy(true);
    setError(null);

    try {
      if (saved) {
        const { id: _unused, ...body } = draft;
        await agent.updateDungeon(draft.id, body);
      } else {
        await agent.createDungeon(draft);
        setSaved(true);
      }

      onSaved();
      setStep('construir');
    } catch (cause) {
      // A frase da API vem inteira: ela conhece a regra, esta tela
      // só conhece os campos.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={dungeon === null ? 'Nova masmorra' : `Editar ${dungeon.name}`}
      onClose={onClose}
      busy={busy}
      // Trinta campos nao podem ir embora num clique torto.
      guarded
      // `w-`, e nao `max-w-`: o Dialog traz `w-[min(30rem,92vw)]`
      // proprio, e um max-width maior nao alarga nada quando a
      // largura ja e menor que ele. Com 30rem, a trilha de seis
      // passos vira seis reticencias.
      className="w-[min(72rem,94vw)]"
    >
      <Steps steps={steps} current={step} onGo={setStep} />

      {/* ####  68vh, E NAO 60  ####

          O passo do desenho e o mais alto de todos: cabecalho, a
          faixa de plantas prontas, a paleta e o grid. Com 60vh a
          entrada amarela — o unico ponto do desenho que NAO se pode
          deixar de ver — caia abaixo da dobra. */}
      <div className="max-h-[68vh] overflow-y-auto">
        {step === 'identidade' && (
          <StepIdentidade draft={draft} patch={patch} locked={saved} />
        )}

        {step === 'tamanho' && draft.mode === 'blueprint' && (
          <StepDesenho
            draft={draft}
            patch={patch}
            layouts={layouts}
            onLayoutSaved={onSaved}
          />
        )}

        {step === 'tamanho' && draft.mode === 'recipe' && (
          <WithPreview draft={draft} seed={seed} onReseed={() => setSeed((n) => n + 1)}>
            <StepTamanho draft={draft} patch={patch} />
          </WithPreview>
        )}

        {step === 'salas' && (
          <WithPreview draft={draft} seed={seed} onReseed={() => setSeed((n) => n + 1)}>
            <StepSalas draft={draft} patch={patch} seed={seed} />
          </WithPreview>
        )}

        {step === 'inimigos' && (
          <WithPreview draft={draft} seed={seed} onReseed={() => setSeed((n) => n + 1)}>
            <StepInimigos draft={draft} patch={patch} />
          </WithPreview>
        )}

        {step === 'entrada' && (
          <StepEntrada draft={draft} patch={patch} blueprints={blueprints} />
        )}

        {step === 'anuncio' && <StepAnuncio draft={draft} patch={patch} />}

        {step === 'construir' && (
          <StepConstruir dungeon={draft} servers={servers} saved={saved} onSave={() => void save()} />
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-2 px-4 py-3">
        <div className="min-w-0 text-2xs text-muted">
          {error !== null ? (
            // Texto em --text com borda colorida: o vermelho do
            // chrome dá 3.7:1, que serve para borda e não para
            // texto. É regra do design system.
            <span className="border-l-2 border-rust pl-2 text-foreground">{error}</span>
          ) : blocking.length > 0 ? (
            <span className="border-l-2 border-amber pl-2 text-foreground">{blocking[0]}</span>
          ) : (
            // ####  O RODAPÉ FALA DO PASSO ABERTO  ####
            //
            // Ele dizia "falta escolher onde ela nasce, no passo
            // Construir" enquanto o admin digitava o NOME, no passo
            // ①. Correto e fora de hora: quem está escolhendo o nome
            // não tem o que fazer com essa frase, e ela ocupava o
            // lugar do que fazer AGORA.
            <span>{footerHint(step, saved)}</span>
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Fechar
          </Button>
          <Button
            variant="confirm"
            size="sm"
            onClick={() => void save()}
            disabled={busy || blocking.length > 0}
          >
            {busy ? (
              <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            )}
            {saved ? 'Salvar' : 'Criar'}
          </Button>
        </div>
      </footer>
    </Dialog>
  );
}

/**
 * O passo à esquerda, a prévia à direita.
 *
 * Só nos passos que mexem em números cujo efeito ninguém adivinha.
 * No de identidade ela seria enfeite, e enfeite rouba largura.
 */
function WithPreview({
  draft,
  seed,
  onReseed,
  children,
}: {
  readonly draft: DungeonInput;
  readonly seed: number;
  readonly onReseed: () => void;
  readonly children: ReactNode;
}) {
  const rooms = Math.round((draft.size.min + draft.size.max) / 2);

  // ####  NO MODO PLANTA, A PRÉVIA É O DESENHO  ####
  //
  // Sortear aqui poria uma masmorra ao lado de outra e chamaria as
  // duas de a mesma: a tela dizia "13 salas" ao lado de um desenho
  // com quatro. Quem apontou foi o dono, olhando.
  const fixed =
    draft.mode === 'blueprint' && draft.grid !== null && draft.grid.length > 0
      ? previewFromGrid(draft.grid)
      : null;

  return (
    <div className="grid gap-0 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0">{children}</div>
      <div className="border-t border-border p-4 lg:border-l lg:border-t-0">
        <DungeonPreviewPanel
          rooms={rooms}
          seed={seed}
          onReseed={onReseed}
          fixed={fixed}
          weights={draft.weights}
          roomSpecs={draft.rooms}
          corridor={draft.corridor}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------
//  ①  IDENTIDADE
// ------------------------------------------------------------

function StepIdentidade({
  draft,
  patch,
  locked,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
  readonly locked: boolean;
}) {
  return (
    <StepBody
      title="Que masmorra é essa"
      hint="O nome é o que você vê no painel; o identificador é o que você digita no jogo."
    >
      {/* ####  A BIFURCAÇÃO VEM ANTES DOS CAMPOS DE TEXTO  ####

          MEDIDO em 09/09/2026, apontado pelo dono ("as config está
          muito confusa"): esta escolha ficava no PÉ do passo,
          embaixo de três campos de texto — e é ela que reconfigura
          a tela inteira. O passo ② vira "Desenho" ou "Tamanho"
          conforme ela.

          Enterrar a bifurcação embaixo do nome é pedir para o admin
          preencher três campos antes de descobrir que escolheu o
          caminho errado. */}
      <div>
        <FieldLabel topic={DUNGEON_HELP.modo}>Como ela é montada</FieldLabel>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <ModeCard
            active={draft.mode === 'recipe'}
            title="Receita"
            detail="Regras. O servidor sorteia um traçado novo a cada nascimento."
            onClick={() => patch({ mode: 'recipe' })}
          />
          <ModeCard
            active={draft.mode === 'blueprint'}
            title="Planta desenhada"
            detail="Você pinta o traçado célula a célula. Sai sempre igual, e os jogadores decoram o caminho."
            onClick={() => patch({ mode: 'blueprint' })}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nome">
          <Input
            value={draft.name}
            placeholder="Bunker Vermelho"
            onChange={(event) => {
              const name = event.target.value;

              patch(locked ? { name } : { name, id: draft.id === '' ? slugify(name) : draft.id });
            }}
          />
        </Field>

        <Field
          label="Identificador"
          hint={
            locked
              ? 'Não muda depois de criada: é por ele que o comando no jogo a encontra.'
              : 'Minúsculas, números e hífen. Vira o comando no jogo.'
          }
        >
          <Input
            value={draft.id}
            disabled={locked}
            placeholder="bunker-vermelho"
            onChange={(event) => patch({ id: slugify(event.target.value) })}
          />
        </Field>
      </div>

      <Field label="Descrição" hint="Só para você, no painel.">
        <Input
          value={draft.description ?? ''}
          placeholder="A do evento de sexta"
          onChange={(event) => patch({ description: event.target.value })}
        />
      </Field>

    </StepBody>
  );
}

// ------------------------------------------------------------
//  ②  TAMANHO E MISTURA
// ------------------------------------------------------------

function StepTamanho({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  return (
    <StepBody
      title="De que tamanho, e com que mistura"
      hint="O servidor sorteia um número de salas dentro do intervalo, e distribui as cores pelos pesos."
    >
      <div>
        <FieldLabel topic={DUNGEON_HELP.tamanho}>Quantas salas</FieldLabel>
        <RangeRow
          value={draft.size}
          min={1}
          max={30}
          onChange={(size) => patch({ size })}
          unit="salas"
        />
      </div>

      <div>
        <FieldLabel topic={DUNGEON_HELP.pesos}>A mistura de cores</FieldLabel>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {(['green', 'blue', 'red'] as const).map((color) => (
            <label key={color} className="block">
              <span className="mb-1 flex items-center gap-1.5 text-2xs text-muted">
                <span
                  aria-hidden="true"
                  className="h-2 w-2"
                  style={{
                    backgroundColor:
                      color === 'green'
                        ? 'var(--olive)'
                        : color === 'blue'
                          ? 'var(--chart-2)'
                          : 'var(--rust-red)',
                  }}
                />
                {COLOR_LABEL[color]}
              </span>
              <Input
                type="number"
                min={0}
                max={100}
                value={draft.weights[color]}
                onChange={(event) =>
                  patch({
                    weights: { ...draft.weights, [color]: clampInt(event.target.value, 0, 100) },
                  })
                }
              />
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel topic={DUNGEON_HELP.corredorNpc}>Inimigos no corredor</FieldLabel>
          <Percent
            value={draft.corridor.npcDensity}
            onChange={(npcDensity) => patch({ corridor: { ...draft.corridor, npcDensity } })}
          />
        </div>
        <div>
          <FieldLabel topic={DUNGEON_HELP.corredorLoot}>Caixas no corredor</FieldLabel>
          <Percent
            value={draft.corridor.lootDensity}
            onChange={(lootDensity) => patch({ corridor: { ...draft.corridor, lootDensity } })}
          />
        </div>
      </div>

      {/* O material é da MASMORRA — corredor, entrada e tudo que
          não tem dono de sala. Por isso ele mora no passo de como
          ela nasce, e não no das salas. */}
      <div>
        <FieldLabel topic={DUNGEON_HELP.grauConstrucao}>De que material ela é feita</FieldLabel>
        <GradeRow
          value={draft.structure}
          onChange={(structure) => patch({ structure })}
          className="mt-1"
        />
      </div>
    </StepBody>
  );
}

/**
 * O que o limite da porta larga produz NAQUELE traçado.
 *
 * Sem esta frase, "4 células por porta" é um número sem tradução: o
 * admin escolhe a folha dupla, salva, e descobre no jogo que ela
 * nunca aparece — ou que aparece em toda sala.
 */
function WideDoorHint({
  preview,
  cellsPerDoor,
}: {
  readonly preview: DungeonPreview;
  readonly cellsPerDoor: number;
}) {
  const stats = wideDoorStats(preview, cellsPerDoor);

  return (
    <p className="mt-2 border-l-2 border-border pl-2 text-2xs text-muted">
      {stats.wide === 0 ? (
        <>
          No traçado ao lado, <strong className="text-foreground">nenhuma</strong> das{' '}
          {String(stats.rooms)} salas chega a {String(cellsPerDoor)} células por porta — com este
          limite a folha larga não apareceria. Baixe o número.
        </>
      ) : (
        <>
          No traçado ao lado,{' '}
          <strong className="text-foreground">
            {String(stats.wide)} de {String(stats.rooms)}
          </strong>{' '}
          salas passam de {String(cellsPerDoor)} células por porta — as desta cor entre elas
          nasceriam com a folha larga.
        </>
      )}
    </p>
  );
}

/** Os três tipos de peça, lado a lado. */
function GradeRow({
  value,
  onChange,
  className,
}: {
  readonly value: GradeSet;
  readonly onChange: (value: GradeSet) => void;
  readonly className?: string;
}) {
  const pieces = [
    { field: 'foundation' as const, label: 'Piso' },
    { field: 'wall' as const, label: 'Parede' },
    { field: 'ceiling' as const, label: 'Teto' },
  ];

  return (
    <div className={cn('grid gap-3 sm:grid-cols-3', className)}>
      {pieces.map((piece) => (
        <label key={piece.field} className="block">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            {piece.label}
          </span>
          <select
            value={value[piece.field]}
            onChange={(event) =>
              onChange({ ...value, [piece.field]: event.target.value as BuildGrade })
            }
            className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
          >
            {BUILD_GRADES.map((grade) => (
              <option key={grade} value={grade}>
                {GRADE_LABEL[grade]}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

/**
 * O passo do modo planta: a tela de desenho.
 *
 * ####  TRÊS JEITOS DE COMEÇAR, E NENHUM É O GRID EM BRANCO  ####
 *
 * Encarar 576 quadradinhos vazios é tão paralisante quanto trinta
 * campos em branco. Então o passo abre com os três caminhos:
 *
 *   partir de uma planta pronta   o acervo, em miniatura
 *   sortear um traçado            o gerador dá o primeiro traço
 *   desenhar do zero              para quem já sabe o que quer
 *
 * E o quarto caminho fecha o ciclo: o desenho de hoje vira planta
 * pronta, e é dele que a próxima masmorra parte.
 *
 * ####  CARREGAR COPIA, E NÃO REFERENCIA  ####
 *
 * O traçado escolhido vira o `grid` DESTA masmorra. Mexer nele
 * aqui não mexe no acervo, e apagar o do acervo não quebra esta
 * masmorra. Referenciar faria uma edição no acervo mudar, sem
 * aviso, uma masmorra que já está no ar.
 */
function StepDesenho({
  draft,
  patch,
  layouts,
  onLayoutSaved,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
  readonly layouts: readonly DungeonLayoutSummary[];
  readonly onLayoutSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);

  function randomize() {
    // Sortear é o primeiro traço: o gerador enche a tela e o admin
    // edita a partir dali.
    const rooms = Math.round((draft.size.min + draft.size.max) / 2);

    patch({ grid: sketchFromLayout(rooms, Date.now() % 100_000, draft.weights) });
  }

  const drawn = draft.grid !== null && draft.grid.length > 0;

  return (
    <StepBody
      title="Desenhe a masmorra"
      hint="Cada quadradinho é um cômodo de 3 por 3 metros. Arraste para pintar; a porta nasce sozinha onde a sala encosta no corredor."
    >
      {layouts.length > 0 && (
        <div>
          <FieldLabel topic={DUNGEON_HELP.plantaPronta}>Começar de uma planta pronta</FieldLabel>
          <LayoutStrip
            layouts={layouts}
            onPick={(layout) => patch({ grid: [...layout.grid] })}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel topic={DUNGEON_HELP.desenho}>O traçado</FieldLabel>

        <span className="flex gap-1">
          <Button size="sm" variant="outline" onClick={randomize}>
            <Dices aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Sortear um traçado
          </Button>

          <Button
            size="sm"
            variant="outline"
            disabled={!drawn}
            onClick={() => setSaving((current) => !current)}
          >
            <Save aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Salvar como planta
          </Button>
        </span>
      </div>

      {saving && draft.grid !== null && (
        <SaveAsLayout
          grid={draft.grid}
          suggestion={draft.name}
          onClose={() => setSaving(false)}
          onSaved={onLayoutSaved}
        />
      )}

      <DungeonGridEditor
        grid={draft.grid}
        onChange={(grid) => patch({ grid })}
        onRandomize={randomize}
        // A seta amarela na entrada é o controle: cada clique gira um
        // quarto de volta, e a quarta devolve o automático.
        facing={draft.entranceFacing}
        onFacing={(entranceFacing) => patch({ entranceFacing })}
      />
    </StepBody>
  );
}

/**
 * A faixa de traçados prontos.
 *
 * Horizontal e rolável: ela divide o passo com o editor, que é o
 * que importa ali. Em grade, oito traçados empurrariam o desenho
 * para fora da tela — e o admin escolhe um e nunca mais olha para
 * esta faixa.
 */
function LayoutStrip({
  layouts,
  onPick,
}: {
  readonly layouts: readonly DungeonLayoutSummary[];
  readonly onPick: (layout: DungeonLayoutSummary) => void;
}) {
  return (
    <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
      {layouts.map((layout) => (
        <button
          key={layout.id}
          type="button"
          onClick={() => onPick(layout)}
          title={`${layout.name} — ${String(layout.roomCount)} sala(s)`}
          className="w-32 shrink-0 border border-border bg-surface-2 p-1 text-left transition-colors hover:border-amber"
        >
          {/* 96px, e nao 80: num quadro menor uma celula de traçado
              de 11 linhas fica com 7 pixels, e o corredor cinza sobre
              fundo preto deixa de se ver — o traçado vira um punhado
              de quadradinhos coloridos soltos. */}
          <LayoutThumb grid={layout.grid} className="h-24 w-full border-0" />
          <span className="mt-1 block truncate font-condensed text-2xs font-bold uppercase tracking-wide">
            {layout.name}
          </span>
          <span className="block text-2xs text-muted">
            {layout.roomCount} sala(s)
            {layout.problemCount > 0 ? ' · com defeito' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Salvar o desenho no acervo.
 *
 * ####  INLINE, E NÃO UM SEGUNDO DIÁLOGO  ####
 *
 * Este passo já mora dentro de um `<dialog>`. Um segundo por cima
 * empilharia dois top layers, e fechar o de dentro com Escape
 * fecharia os dois — levando junto os trinta campos da masmorra.
 *
 * O bloco pede só o nome: o identificador sai dele, e o desenho é
 * o que está na tela.
 */
function SaveAsLayout({
  grid,
  suggestion,
  onClose,
  onSaved,
}: {
  readonly grid: readonly string[];
  readonly suggestion: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [name, setName] = useState(suggestion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly string[] | null>(null);

  async function save() {
    const id = slugify(name);

    if (id.length < 2) {
      setError('Dê um nome de pelo menos duas letras: é por ele que você acha o traçado depois.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await agent.saveDungeonLayout({ id, name: name.trim(), grid: [...grid] });

      // Os defeitos NÃO impedem o salvamento — um traçado é
      // rascunho. Mas quem salvou precisa saber, e este é o único
      // momento em que ele está olhando para cá.
      setProblems(response.problems);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (problems !== null) {
    return (
      <div className="border-l-2 border-olive bg-surface-2 px-3 py-3">
        <p className="font-condensed text-sm font-bold uppercase tracking-wide">
          Salvo no acervo
        </p>
        <p className="mt-1 text-2xs text-muted">
          Ele aparece na aba Plantas, e nesta faixa aqui em cima na próxima masmorra que você criar.
        </p>

        {problems.length > 0 && (
          <ul className="mt-2 space-y-1">
            {problems.map((problem) => (
              <li key={problem} className="border-l-2 border-amber pl-2 text-2xs text-foreground">
                {problem}
              </li>
            ))}
          </ul>
        )}

        <Button size="sm" variant="ghost" className="mt-2" onClick={onClose}>
          Fechar
        </Button>
      </div>
    );
  }

  return (
    <div className="border border-border bg-surface-2 p-3">
      <FieldLabel>Nome do traçado</FieldLabel>
      <div className="mt-1 flex flex-wrap gap-2">
        <Input
          value={name}
          placeholder="Corredor em L"
          className="min-w-40 flex-1"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void save();
            }
          }}
        />
        <Button size="sm" variant="confirm" disabled={busy} onClick={() => void save()}>
          {busy ? (
            <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          )}
          Salvar
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>

      <p className="mt-2 text-2xs text-muted">
        Um traçado de mesmo nome é substituído. O desenho é copiado: mexer nele aqui depois não
        mexe no que ficou salvo.
      </p>

      {error !== null && (
        <p className="mt-2 border-l-2 border-amber pl-2 text-2xs text-foreground">{error}</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  ③  O QUE TEM DENTRO
// ------------------------------------------------------------

function StepSalas({
  draft,
  patch,
  seed,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
  /** A mesma semente da prévia ao lado: a frase da porta larga fala DAQUELE traçado. */
  readonly seed: number;
}) {
  function update(index: number, change: Partial<DungeonRoom>) {
    const rooms = draft.rooms.map((room, at) => (at === index ? { ...room, ...change } : room));

    patch({ rooms });
  }

  // ####  SÓ NO MODO RECEITA  ####
  //
  // No modo planta, o `room` da prévia é o índice da COR e não o da
  // sala — as três vermelhas contariam como um cômodo só, e a frase
  // mentiria. Lá o admin vê os cômodos que desenhou.
  const traced =
    draft.mode === 'recipe'
      ? previewLayout(Math.round((draft.size.min + draft.size.max) / 2), seed)
      : null;

  return (
    <StepBody
      title="O que tem dentro de cada cor"
      hint="A cor é o nível do cômodo: quantos inimigos, que loot, que porta e que material o jogador encontra. Embaixo ficam o corredor, as portas trancadas e o ciclo do loot — que valem para a masmorra inteira."
    >
      <div className="space-y-3">
        {draft.rooms.map((room, index) => (
          <div key={room.key} className="border border-border bg-surface-2 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h4 className="flex items-center gap-2 font-condensed text-xs font-bold uppercase tracking-wide">
                <span
                  aria-hidden="true"
                  className="h-3 w-3"
                  style={{
                    backgroundColor:
                      room.color === 'green'
                        ? 'var(--olive)'
                        : room.color === 'blue'
                          ? 'var(--chart-2)'
                          : 'var(--rust-red)',
                  }}
                />
                Sala {COLOR_LABEL[room.color]}
              </h4>

              {DOOR_MATERIAL[room.door] !== MATERIAL_OF_COLOR[room.color] && (
                <span className="border-l-2 border-amber pl-2 text-2xs text-foreground">
                  {room.door === 'none'
                    ? 'Sem porta, esta sala deixa de avisar o que tem dentro.'
                    : 'O material da porta não corresponde à cor: o aviso visual deixa de funcionar.'}
                </span>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <FieldLabel topic={DUNGEON_HELP.salaNpc}>Inimigos</FieldLabel>
                <RangeRow
                  compact
                  value={room.npc}
                  min={0}
                  max={20}
                  onChange={(npc) => update(index, { npc })}
                />
              </div>

              <div>
                <FieldLabel topic={DUNGEON_HELP.salaLoot}>Caixas</FieldLabel>
                <RangeRow
                  compact
                  value={room.loot}
                  min={0}
                  max={20}
                  onChange={(loot) => update(index, { loot })}
                />
              </div>

              <div>
                <FieldLabel topic={DUNGEON_HELP.porta}>Porta</FieldLabel>
                <select
                  value={room.door}
                  onChange={(event) => update(index, { door: event.target.value as RoomDoor })}
                  className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
                >
                  {ROOM_DOORS.map((door) => (
                    <option key={door} value={door}>
                      {DOOR_LABEL[door]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <FieldLabel topic={DUNGEON_HELP.trancada}>Com código</FieldLabel>
                <div className="mt-1.5">
                  <Toggle
                    on={room.locked}
                    busy={false}
                    onChange={(locked) => update(index, { locked })}
                    labels={['Trancada', 'Aberta']}
                    label={`Porta da sala ${COLOR_LABEL[room.color]}`}
                  />
                </div>
              </div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="lg:col-span-2">
                <FieldLabel topic={DUNGEON_HELP.portaLarga}>Porta da sala grande</FieldLabel>
                <select
                  value={room.wideDoor ?? ''}
                  onChange={(event) =>
                    update(index, {
                      wideDoor: event.target.value === '' ? null : (event.target.value as RoomDoor),
                    })
                  }
                  className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
                >
                  <option value="">A mesma de cima, sempre</option>
                  {WIDE_DOORS.map((door) => (
                    <option key={door} value={door}>
                      {DOOR_LABEL[door]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <FieldLabel topic={DUNGEON_HELP.portaLargaLimite}>A partir de</FieldLabel>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    className="w-16"
                    disabled={room.wideDoor === null}
                    value={room.wideDoorCellsPerDoor}
                    onChange={(event) =>
                      update(index, {
                        wideDoorCellsPerDoor: clampInt(event.target.value, 1, 64),
                      })
                    }
                  />
                  <span className="text-2xs text-muted">células por porta</span>
                </div>
              </div>

              <div>
                <FieldLabel topic={DUNGEON_HELP.grauDaSala}>Material próprio</FieldLabel>
                <div className="mt-1.5">
                  <Toggle
                    on={room.grade !== null}
                    busy={false}
                    onChange={(on) =>
                      update(index, { grade: on ? { ...draft.structure } : null })
                    }
                    labels={['Próprio', 'Herda']}
                    label={`Material da sala ${COLOR_LABEL[room.color]}`}
                  />
                </div>
              </div>
            </div>

            {room.wideDoor !== null && traced !== null && (
              <WideDoorHint preview={traced} cellsPerDoor={room.wideDoorCellsPerDoor} />
            )}

            {room.grade !== null && (
              <GradeRow
                value={room.grade}
                onChange={(grade) => update(index, { grade })}
                className="mt-3"
              />
            )}

            <CrateList
              crates={room.crates}
              onChange={(crates) => update(index, { crates })}
              className="mt-3"
            />

            <div className="mt-3">
              <LootTableFields
                title={`O que cai nas caixas da sala ${COLOR_LABEL[room.color].toLowerCase()}`}
                value={room.table}
                onChange={(table) => update(index, { table })}
              />
            </div>
          </div>
        ))}
      </div>

      {/* ####  O CORREDOR VEM DEPOIS DAS SALAS, E NÃO NO PASSO ②  ####

          A densidade dele é "como a masmorra nasce"; a tabela é
          "o que cai", e quem está pensando em loot está OLHANDO
          para as salas. Separar as duas coisas de lugar custaria
          uma ida e volta a cada ajuste. */}
      <div className="border border-border bg-surface-2 p-3">
        <h4 className="mb-3 font-condensed text-xs font-bold uppercase tracking-wide">
          O corredor
        </h4>
        <LootTableFields
          title="O que cai nas caixas do corredor"
          value={draft.corridor.table}
          onChange={(table) => patch({ corridor: { ...draft.corridor, table } })}
        />
      </div>

      <LockFields draft={draft} patch={patch} />
      <RespawnFields draft={draft} patch={patch} />
    </StepBody>
  );
}

/**
 * A fechadura, que é da masmorra inteira.
 *
 * Ela mora aqui, e não num passo próprio, porque a pergunta que ela
 * responde só aparece depois de o admin marcar uma sala como
 * trancada — e é nesta tela que ele faz isso.
 */
function LockFields({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  const anyLocked = draft.rooms.some((current) => current.locked);

  function update(change: Partial<DungeonLock>) {
    patch({ lock: { ...draft.lock, ...change } });
  }

  return (
    <div className="border border-border bg-surface-2 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-condensed text-xs font-bold uppercase tracking-wide">
          As portas trancadas
        </h4>
        <Toggle
          on={draft.lock.enabled}
          busy={false}
          onChange={(enabled) => update({ enabled })}
          labels={['Trancam', 'Abertas']}
          label="Sistema de fechadura"
        />
      </div>

      {!anyLocked && (
        <p className="text-2xs text-muted">
          Nenhuma sala está marcada como trancada — o que está aqui embaixo só passa a valer quando
          uma estiver.
        </p>
      )}

      {draft.lock.enabled && (
        <div className="mt-1 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <FieldLabel topic={DUNGEON_HELP.portador}>Quem carrega o código</FieldLabel>
            <select
              value={draft.lock.carrier}
              onChange={(event) =>
                update({ carrier: event.target.value as DungeonLock['carrier'] })
              }
              className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
            >
              {(Object.keys(CARRIER_LABEL) as DungeonLock['carrier'][]).map((carrier) => (
                <option key={carrier} value={carrier}>
                  {CARRIER_LABEL[carrier]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <FieldLabel topic={DUNGEON_HELP.portador}>Onde ele pode estar</FieldLabel>
            <select
              value={draft.lock.carrierScope}
              disabled={draft.lock.carrier === 'none'}
              onChange={(event) =>
                update({ carrierScope: event.target.value as DungeonLock['carrierScope'] })
              }
              className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
            >
              {(Object.keys(SCOPE_LABEL) as DungeonLock['carrierScope'][]).map((scope) => (
                <option key={scope} value={scope}>
                  {SCOPE_LABEL[scope]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <FieldLabel>Se ninguém receber o código</FieldLabel>
            <select
              value={draft.lock.onUndelivered}
              onChange={(event) =>
                update({ onUndelivered: event.target.value as DungeonLock['onUndelivered'] })
              }
              className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
            >
              {(Object.keys(UNDELIVERED_LABEL) as DungeonLock['onUndelivered'][]).map((option) => (
                <option key={option} value={option}>
                  {UNDELIVERED_LABEL[option]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <FieldLabel topic={DUNGEON_HELP.codigoUnico}>Um código para tudo</FieldLabel>
            <div className="mt-1.5">
              <Toggle
                on={draft.lock.sharedCode}
                busy={false}
                onChange={(sharedCode) => update({ sharedCode })}
                labels={['Um só', 'Um por sala']}
                label="Código compartilhado"
              />
            </div>
          </div>

          <div>
            <FieldLabel>Avisar quando uma porta abre</FieldLabel>
            <div className="mt-1.5">
              <Toggle
                on={draft.lock.announceOpen}
                busy={false}
                onChange={(announceOpen) => update({ announceOpen })}
                labels={['Avisa', 'Calado']}
                label="Aviso de porta aberta"
              />
            </div>
          </div>

          <div>
            <FieldLabel>Dizer a quem errou o código</FieldLabel>
            <div className="mt-1.5">
              <Toggle
                on={draft.lock.warnOnWrongCode}
                busy={false}
                onChange={(warnOnWrongCode) => update({ warnOnWrongCode })}
                labels={['Diz', 'Calado']}
                label="Aviso de código errado"
              />
            </div>
          </div>

          <div className="sm:col-span-2 lg:col-span-3">
            <FieldLabel>O nome do papel no inventário</FieldLabel>
            <Input
              className="mt-1"
              value={draft.lock.noteTitle}
              maxLength={40}
              placeholder="Código da porta"
              onChange={(event) => update({ noteTitle: event.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** O ciclo do loot. Desligado é o certo no modo evento. */
function RespawnFields({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  return (
    <div className="border border-border bg-surface-2 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <FieldLabel topic={DUNGEON_HELP.respawn} className="text-xs font-bold text-foreground">
          O loot volta sozinho
        </FieldLabel>
        <Toggle
          on={draft.respawn.enabled}
          busy={false}
          onChange={(enabled) => patch({ respawn: { ...draft.respawn, enabled } })}
          labels={['Volta', 'Não volta']}
          label="Ciclo do loot"
        />
      </div>

      {!draft.respawn.enabled ? (
        <p className="text-2xs text-muted">
          Desligado: o que o jogador levou, levou. É o certo para uma masmorra de evento — num
          evento de 40 minutos, um ciclo de 30 é loot dobrado.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <FieldLabel>A cada</FieldLabel>
            <div className="mt-1 flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={1440}
                className="w-20"
                value={draft.respawn.minutes}
                onChange={(event) =>
                  patch({
                    respawn: { ...draft.respawn, minutes: clampInt(event.target.value, 1, 1440) },
                  })
                }
              />
              <span className="text-2xs text-muted">minutos</span>
            </div>
          </div>

          <div>
            <FieldLabel>Só quando a caixa está vazia</FieldLabel>
            <div className="mt-1.5">
              <Toggle
                on={draft.respawn.onlyWhenEmpty}
                busy={false}
                onChange={(onlyWhenEmpty) => patch({ respawn: { ...draft.respawn, onlyWhenEmpty } })}
                labels={['Só vazia', 'Sempre']}
                label="Repor só a caixa vazia"
              />
            </div>
          </div>

          <div>
            <FieldLabel>Refazer as caixas destruídas</FieldLabel>
            <div className="mt-1.5">
              <Toggle
                on={draft.respawn.rebuildDestroyed}
                busy={false}
                onChange={(rebuildDestroyed) =>
                  patch({ respawn: { ...draft.respawn, rebuildDestroyed } })
                }
                labels={['Refaz', 'Some']}
                label="Refazer caixa destruída"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  ④  OS INIMIGOS
// ------------------------------------------------------------

function StepInimigos({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  return (
    <StepBody
      title="Quem mora lá dentro"
      hint="Vale para todos os inimigos da masmorra. A arma pesa mais que a vida e o dano juntos."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel topic={DUNGEON_HELP.npcVida}>Vida</FieldLabel>
          <RangeRow
            value={draft.npc.health}
            min={1}
            max={1000}
            onChange={(health) => patch({ npc: { ...draft.npc, health } })}
            unit="de vida"
          />
        </div>

        <div>
          <FieldLabel topic={DUNGEON_HELP.npcDano}>Multiplicador de dano</FieldLabel>
          <div className="mt-1 flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={30}
              value={Math.round(draft.npc.damageScale * 10)}
              onChange={(event) =>
                patch({ npc: { ...draft.npc, damageScale: Number(event.target.value) / 10 } })
              }
              className="h-9 flex-1 accent-[var(--rust-red)]"
            />
            <span className="w-12 shrink-0 text-right font-condensed text-sm font-bold tabular-nums">
              {draft.npc.damageScale.toFixed(1)}×
            </span>
          </div>
        </div>
      </div>

      <div>
        <FieldLabel topic={DUNGEON_HELP.npcArmas}>Armas</FieldLabel>
        <TokenList
          values={draft.npc.weapons}
          placeholder="rifle.ak"
          onChange={(weapons) => patch({ npc: { ...draft.npc, weapons } })}
        />
      </div>

      <div>
        <FieldLabel>Nomes</FieldLabel>
        <TokenList
          values={draft.npc.names}
          placeholder="Guardião"
          onChange={(names) => patch({ npc: { ...draft.npc, names } })}
        />
      </div>

      <div className="max-w-xs">
        <FieldLabel topic={DUNGEON_HELP.horaDoDia}>A hora lá dentro</FieldLabel>
        <div className="mt-1 flex items-center gap-3">
          <input
            type="range"
            min={-1}
            max={23}
            value={draft.timeOfDay}
            onChange={(event) => patch({ timeOfDay: Number(event.target.value) })}
            className="h-9 flex-1 accent-[var(--rust-red)]"
          />
          <span className="w-20 shrink-0 text-right font-condensed text-sm font-bold tabular-nums">
            {draft.timeOfDay < 0 ? 'não mexe' : `${String(draft.timeOfDay)}h`}
          </span>
        </div>
      </div>

      <LootTableFields
        title="O que o corpo carrega"
        value={draft.npc.loot}
        onChange={(loot) => patch({ npc: { ...draft.npc, loot } })}
      />

      <BehaviourFields draft={draft} patch={patch} />
    </StepBody>
  );
}

/**
 * O comportamento: o padrão da masmorra, e as exceções.
 *
 * ####  DEZENOVE CAMPOS VEZES CINCO LUGARES NÃO CABEM NUMA TELA  ####
 *
 * Então o padrão fica aberto — é o que quase todo mundo quer mexer
 * — e as exceções (cada cor de sala, o corredor) entram por uma
 * aba, uma de cada vez. A aba mostra quantos campos aquela exceção
 * mudou, para o admin não precisar abrir as quatro para descobrir
 * onde ele mexeu.
 */
function BehaviourFields({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  /** `null` = o padrão da masmorra; senão o índice da sala; -1 = corredor. */
  const [target, setTarget] = useState<number | null>(null);

  const tabs: { readonly at: number | null; readonly label: string; readonly ai: AiSpec }[] = [
    { at: null, label: 'Padrão da masmorra', ai: draft.npc.ai },
    ...draft.rooms.map((current, index) => ({
      at: index,
      label: `Sala ${COLOR_LABEL[current.color].toLowerCase()}`,
      ai: current.ai,
    })),
    { at: -1, label: 'Corredor', ai: draft.corridor.ai },
  ];

  const current = tabs.find((tab) => tab.at === target) ?? tabs[0];

  function change(ai: AiSpec) {
    if (target === null) {
      patch({ npc: { ...draft.npc, ai } });
      return;
    }

    if (target === -1) {
      patch({ corridor: { ...draft.corridor, ai } });
      return;
    }

    patch({ rooms: draft.rooms.map((room, index) => (index === target ? { ...room, ai } : room)) });
  }

  return (
    <div className="border border-border bg-surface-2 p-3">
      <FieldLabel topic={DUNGEON_HELP.iaHeranca} className="text-xs font-bold text-foreground">
        Como o inimigo se comporta
      </FieldLabel>

      <div className="mt-2 flex flex-wrap gap-1">
        {tabs.map((tab) => {
          const changed = Object.keys(tab.ai).length;

          return (
            <button
              key={String(tab.at)}
              type="button"
              aria-pressed={tab.at === (current?.at ?? null)}
              onClick={() => setTarget(tab.at)}
              className={cn(
                'border px-2 py-1 font-condensed text-2xs uppercase tracking-wide',
                tab.at === (current?.at ?? null)
                  ? 'border-rust bg-rust/10 text-foreground'
                  : 'border-border bg-background text-muted hover:border-muted',
              )}
            >
              {tab.label}
              {changed > 0 && (
                <span className="ml-1 tabular-nums text-foreground">({String(changed)})</span>
              )}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-2xs text-muted">
        {target === null
          ? 'Campo em branco usa o padrão do jogo — o número em cinza é ele.'
          : 'Campo em branco herda o padrão da masmorra, que é o número em cinza.'}
      </p>

      <div className="mt-3">
        <AiFields
          value={current?.ai ?? {}}
          // A marca-d'água mostra o que a sala vai REALMENTE usar:
          // o padrão do jogo com o padrão da masmorra por cima.
          inherited={target === null ? {} : resolveAi({}, draft.npc.ai)}
          onChange={change}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------
//  ⑤  A ENTRADA — e quem passa por ela
//
//  ####  POR QUE "QUEM ENTRA" MORA AQUI, E NÃO NO PASSO DAS SALAS  ####
//
//  Os passos ② a ④ são de quem DESENHA a masmorra: tamanho, cores,
//  loot, inimigos. "Quem pode descer" e "o que ninguém tira do
//  lugar" não são desenho — são decisões de quem OPERA o servidor,
//  e as duas acontecem no mesmo lugar do jogo: o alçapão da
//  entrada, a única peça que os jogadores veem de fora.
//
//  Juntá-las aqui também é o que faz a pergunta certa aparecer
//  perto da resposta: a casinha que o admin acabou de escolher é
//  exatamente a que o martelo vai tentar derrubar.
// ------------------------------------------------------------

function StepEntrada({
  draft,
  patch,
  blueprints,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
  readonly blueprints: readonly BlueprintSummary[];
}) {
  const entrances = blueprints.filter((blueprint) => blueprint.kind === 'entrance');

  return (
    <StepBody
      title="A casinha que aparece no mapa"
      hint="É a única parte que os jogadores veem de fora — e é ela que traz o alçapão de descida."
    >
      <FieldLabel topic={DUNGEON_HELP.entrada}>Planta da entrada</FieldLabel>

      <div className="grid gap-2 sm:grid-cols-2">
        <BlueprintCard
          active={draft.entranceBlueprint === null}
          title="Entrada mínima"
          detail="Gerada por código: uma laje, um alçapão e uma luz. Funciona, e não impressiona ninguém."
          onClick={() => patch({ entranceBlueprint: null })}
        />

        {entrances.map((blueprint) => (
          <BlueprintCard
            key={blueprint.id}
            active={draft.entranceBlueprint === blueprint.id}
            title={blueprint.name}
            detail={`${String(blueprint.entityCount)} peças · ${formatBytes(blueprint.byteSize)}`}
            warning={blueprint.hasHatch ? undefined : 'Sem marca de alçapão: a masmorra não abre.'}
            onClick={() => patch({ entranceBlueprint: blueprint.id })}
          />
        ))}
      </div>

      {entrances.length === 0 && (
        <p className="border border-border bg-surface-2 p-3 text-xs text-muted">
          Nenhuma planta de entrada no acervo. As sete que vêm com o projeto são importadas no
          primeiro boot do agente — se a lista está vazia, confira a aba Plantas.
        </p>
      )}

      {draft.entranceBlueprint !== null && <EntranceAngleField draft={draft} patch={patch} />}

      {draft.entranceBlueprint !== null && <EntranceItemsField draft={draft} patch={patch} />}

      <AccessFields draft={draft} patch={patch} />
      <ProtectionFields draft={draft} patch={patch} />
    </StepBody>
  );
}

/**
 * O ângulo da casinha.
 *
 * ####  POR QUE ELE EXISTE, SE JÁ HÁ UM ÂNGULO NO PONTO  ####
 *
 * São duas construções. O ângulo do ponto de nascimento orienta a
 * MASMORRA — a direção em que o desenho cresce lá embaixo. A
 * planta da casinha tem uma frente própria: a porta foi desenhada
 * apontando para algum lado, e nenhum ângulo de quem constrói sabe
 * qual é.
 *
 * MEDIDO em 09/09/2026, pelo dono, olhando a casinha nascer
 * virada: "talvez colocar o ângulo que aí fica certo, uma seta
 * para girar".
 *
 * Quem desce continua chegando de frente para o corredor — isso o
 * servidor resolve sozinho e não se configura.
 */
function EntranceAngleField({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  function turn(delta: number) {
    patch({ entranceRotation: (((draft.entranceRotation + delta) % 360) + 360) % 360 });
  }

  return (
    <div className="border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel
          topic={DUNGEON_HELP.anguloDaEntrada}
          className="text-xs font-bold text-foreground"
        >
          Para que lado a casinha aponta
        </FieldLabel>

        <span className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => turn(-90)} aria-label="Girar 90 graus à esquerda">
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>

          <span className="w-16 text-center font-mono text-sm text-foreground">
            {String(Math.round(draft.entranceRotation))}°
          </span>

          <Button size="sm" variant="outline" onClick={() => turn(90)} aria-label="Girar 90 graus à direita">
            <RotateCw aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>

      {/* O ajuste fino: uma construção pode não estar alinhada aos
          eixos, e aí os 90° não bastam. */}
      <input
        type="range"
        min={0}
        max={359}
        step={5}
        value={draft.entranceRotation}
        onChange={(event) => patch({ entranceRotation: Number(event.target.value) })}
        aria-label="Ângulo da casinha, em graus"
        className="mt-3 w-full"
      />

      <p className="mt-1 text-2xs text-muted">
        {draft.entranceRotation === 0
          ? 'Sem giro: a casinha nasce como a planta foi desenhada.'
          : `Girada ${String(Math.round(draft.entranceRotation))}° em relação à planta.`}{' '}
        Isto gira <strong className="text-foreground">só a casinha</strong> — a masmorra lá embaixo
        e a direção de quem desce não mudam.
      </p>
    </div>
  );
}

/**
 * O que a casinha traz dentro das caixas.
 *
 * ####  ELE SÓ APARECE COM UMA PLANTA ESCOLHIDA  ####
 *
 * A entrada mínima é gerada por código e não tem caixa nenhuma: o
 * campo ali seria uma pergunta sobre nada.
 */
function EntranceItemsField({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  return (
    <div className="border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel
          topic={DUNGEON_HELP.itensDaEntrada}
          className="text-xs font-bold text-foreground"
        >
          O que vem dentro das caixas dela
        </FieldLabel>
        <select
          value={draft.entranceItems}
          onChange={(event) =>
            patch({ entranceItems: event.target.value as EntranceItemMode })
          }
          className="h-9 border border-border bg-background px-2 text-sm"
        >
          {(Object.keys(ENTRANCE_ITEMS_LABEL) as EntranceItemMode[]).map((option) => (
            <option key={option} value={option}>
              {ENTRANCE_ITEMS_LABEL[option]}
            </option>
          ))}
        </select>
      </div>

      <p className="mt-2 text-2xs text-muted">
        {draft.entranceItems === 'all' ? (
          <>
            As plantas que vieram com o projeto foram copiadas com as caixas cheias, em outro
            servidor: a <strong className="text-foreground">entrance2</strong> guarda uma M249 e a{' '}
            <strong className="text-foreground">entrance3</strong>, minigun e lança-foguetes. Nesta
            opção elas nascem junto.
          </>
        ) : draft.entranceItems === 'unarmed' ? (
          'Recurso, roupa e ferramenta entram; arma, munição e explosivo ficam de fora.'
        ) : (
          'A casinha nasce limpa. O loot da masmorra é o de dentro, onde você o desenhou.'
        )}
      </p>
    </div>
  );
}

/** Quem desce pelo alçapão. Nasce "todo o servidor", que é o pedido do dono. */
function AccessFields({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  function update(change: Partial<DungeonAccess>) {
    patch({ access: { ...draft.access, ...change } });
  }

  return (
    <div className="border border-border bg-surface-2 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <FieldLabel topic={DUNGEON_HELP.quemEntra} className="text-xs font-bold text-foreground">
          Quem pode entrar
        </FieldLabel>
        <select
          value={draft.access.whoEnters}
          onChange={(event) => update({ whoEnters: event.target.value as AccessWhoEnters })}
          className="h-9 border border-border bg-background px-2 text-sm"
        >
          {(Object.keys(WHO_ENTERS_LABEL) as AccessWhoEnters[]).map((option) => (
            <option key={option} value={option}>
              {WHO_ENTERS_LABEL[option]}
            </option>
          ))}
        </select>
      </div>

      {draft.access.whoEnters === 'everyone' ? (
        <p className="text-2xs text-muted">
          Qualquer jogador que achar a casinha desce pelo alçapão. É o padrão, e é o que o servidor
          sempre fez.
        </p>
      ) : (
        <div>
          <FieldLabel topic={DUNGEON_HELP.permissaoDeEntrada}>Nome da permissão</FieldLabel>
          <Input
            className="mt-1"
            value={draft.access.enterPermission}
            maxLength={64}
            placeholder="origemzdungeon.enter"
            onChange={(event) => update({ enterPermission: event.target.value })}
          />
          <p className="mt-1.5 text-2xs text-muted">
            Em branco usa a do próprio plugin, <code>origemzdungeon.enter</code>. Pode ser a de
            outro plugin — uma de VIP, por exemplo —, desde que <strong>aquele plugin a registre</strong>:
            uma permissão que não existe em lugar nenhum <strong>deixa todo mundo entrar</strong>, e
            o servidor grita no console. Quem tem <code>origemzdungeon.admin</code> nunca fica de
            fora.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * O que ninguém tira do lugar.
 *
 * ####  O TEXTO DE DESLIGADO É A PARTE QUE IMPORTA  ####
 *
 * Ligar não surpreende ninguém. Quem DESLIGA precisa saber que está
 * abrindo dez caminhos de perder a entrada de uma vez — e que o
 * decay não é um deles, porque ele não obedece a este botão.
 */
function ProtectionFields({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  function update(change: Partial<DungeonProtection>) {
    patch({ protection: { ...draft.protection, ...change } });
  }

  return (
    <div className="border border-border bg-surface-2 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <FieldLabel topic={DUNGEON_HELP.protecao} className="text-xs font-bold text-foreground">
          Proteger a entrada
        </FieldLabel>
        <Toggle
          on={draft.protection.enabled}
          busy={false}
          onChange={(enabled) => update({ enabled })}
          labels={['Protegida', 'Solta']}
          label="Proteção contra remoção"
        />
      </div>

      {!draft.protection.enabled ? (
        <p className="border-l-2 border-amber pl-2 text-2xs text-foreground">
          Desligada: qualquer jogador pode <strong>demolir, melhorar, girar ou reparar</strong> a
          casinha com o martelo, levar a luz e as caixas com o &ldquo;segurar E&rdquo;, e apagar a
          entrada inteira com a ferramenta de remoção. Uma peça a menos no alçapão fecha a masmorra
          para todos. O apodrecimento continua barrado — ele não passa por este botão.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <FieldLabel topic={DUNGEON_HELP.protecaoAdmin}>Quem administra passa</FieldLabel>
            <div className="mt-1.5">
              <Toggle
                on={draft.protection.allowAdmin}
                busy={false}
                onChange={(allowAdmin) => update({ allowAdmin })}
                labels={['Passa', 'Nem ele']}
                label="Administrador passa pela proteção"
              />
            </div>
          </div>

          <div>
            <FieldLabel>Dizer a quem tentou</FieldLabel>
            <div className="mt-1.5">
              <Toggle
                on={draft.protection.warnOnAttempt}
                busy={false}
                onChange={(warnOnAttempt) => update({ warnOnAttempt })}
                labels={['Diz', 'Calado']}
                label="Aviso de peça protegida"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  ⑥  CONSTRUIR — o passo que se resolve sozinho
// ------------------------------------------------------------

/**
 * O passo do mapa e do chat.
 *
 * ####  ELE EXISTE PORQUE A MASMORRA ERA INVISÍVEL  ####
 *
 * MEDIDO em 09/09/2026, a pedido do dono ("verificar se está
 * marcando no mapa e se alerta no chat"): não fazia nem um nem
 * outro. O plugin não criava marcador nenhum, e o único caminho de
 * fala alcançava só quem já estava lá dentro.
 *
 * Um evento que ninguém acha é um evento que não aconteceu.
 */
function StepAnuncio({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  function marker(change: Partial<DungeonMarker>) {
    patch({ marker: { ...draft.marker, ...change } });
  }

  function announce(change: Partial<DungeonAnnounce>) {
    patch({ announce: { ...draft.announce, ...change } });
  }

  return (
    <StepBody
      title="Como o servidor fica sabendo"
      hint="Um evento que ninguém acha é um evento que não aconteceu."
    >
      <div className="border border-border bg-surface-2 p-3">
        <label className="flex items-center justify-between gap-3">
          <FieldLabel topic={DUNGEON_HELP.marcador} className="text-xs font-bold text-foreground">
            Marcar no mapa do jogo
          </FieldLabel>
          <Toggle
            on={draft.marker.enabled}
            busy={false}
            onChange={(enabled) => marker({ enabled })}
            labels={['Aparece', 'Escondida']}
            label="Marcar no mapa do jogo"
          />
        </label>

        {draft.marker.enabled ? (
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div>
                <FieldLabel>Nome no mapa</FieldLabel>
                <Input
                  className="mt-1"
                  value={draft.marker.label}
                  maxLength={40}
                  onChange={(event) => marker({ label: event.target.value })}
                />
              </div>

              <div>
                <FieldLabel>Cor</FieldLabel>
                {/* O seletor nativo: é ele que faz a cor deixar de
                    ser três números de 0 a 1, como no plugin de
                    origem, e virar um clique. */}
                <input
                  type="color"
                  aria-label="Cor do círculo no mapa"
                  value={draft.marker.color}
                  onChange={(event) => marker({ color: event.target.value })}
                  className="mt-1 h-9 w-16 cursor-pointer border border-border bg-background"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <FieldLabel>Tamanho do círculo</FieldLabel>
                <span className="mt-1 flex items-center gap-2">
                  <input
                    type="range"
                    min={0.1}
                    max={3}
                    step={0.1}
                    value={draft.marker.radius}
                    onChange={(event) => marker({ radius: Number(event.target.value) })}
                    className="flex-1"
                  />
                  <span className="w-10 text-right font-mono text-2xs text-muted">
                    {draft.marker.radius.toFixed(1)}
                  </span>
                </span>
              </label>

              <label className="block">
                <FieldLabel>Opacidade</FieldLabel>
                <span className="mt-1 flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.marker.alpha}
                    onChange={(event) => marker({ alpha: Number(event.target.value) })}
                    className="flex-1"
                  />
                  <span className="w-10 text-right font-mono text-2xs text-muted">
                    {Math.round(draft.marker.alpha * 100)}%
                  </span>
                </span>
              </label>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-2xs text-muted">
            Ela não aparece no mapa: quem quiser achá-la vai ter de procurar, ou ler o chat.
          </p>
        )}
      </div>

      <div className="border border-border bg-surface-2 p-3">
        <label className="flex items-center justify-between gap-3">
          <FieldLabel topic={DUNGEON_HELP.anuncio} className="text-xs font-bold text-foreground">
            Avisar no chat
          </FieldLabel>
          <Toggle
            on={draft.announce.enabled}
            busy={false}
            onChange={(enabled) => announce({ enabled })}
            labels={['Avisa', 'Calada']}
            label="Avisar no chat"
          />
        </label>

        {draft.announce.enabled ? (
          <div className="mt-3 space-y-3">
            <div>
              <FieldLabel>Quando ela nasce</FieldLabel>
              <Input
                className="mt-1"
                value={draft.announce.onBuild}
                maxLength={200}
                placeholder="Uma masmorra apareceu em {grid}."
                onChange={(event) => announce({ onBuild: event.target.value })}
              />
            </div>

            <div>
              <FieldLabel>Quando ela fecha</FieldLabel>
              <Input
                className="mt-1"
                value={draft.announce.onEnd}
                maxLength={200}
                placeholder="A masmorra de {grid} fechou."
                onChange={(event) => announce({ onEnd: event.target.value })}
              />
            </div>

            <p className="text-2xs text-muted">
              Em branco, valem as frases acima. <code className="font-mono">{'{grid}'}</code> vira a
              grade do mapa (E7) e <code className="font-mono">{'{nome}'}</code> vira o
              identificador da masmorra.
            </p>

            <label className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="min-w-0">
                <span className="block text-xs text-foreground">Dizer onde ela está</span>
                <span className="block text-2xs text-muted">
                  Desligado, a frase sai sem a grade — e quem quiser achá-la procura.
                </span>
              </span>
              <Toggle
                on={draft.announce.showGrid}
                busy={false}
                onChange={(showGrid) => announce({ showGrid })}
                labels={['Diz', 'Não diz']}
                label="Dizer onde ela está"
              />
            </label>
          </div>
        ) : (
          <p className="mt-2 text-2xs text-muted">
            Ela nasce e fecha em silêncio. Quem estiver lá dentro continua ouvindo o que acontece na
            masmorra.
          </p>
        )}
      </div>
    </StepBody>
  );
}

function StepConstruir({
  dungeon,
  servers,
  saved,
  onSave,
}: {
  readonly dungeon: DungeonInput;
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly saved: boolean;
  readonly onSave: () => void;
}) {
  const [serverId, setServerId] = useState(servers[0]?.id ?? '');
  const [watching, setWatching] = useState(false);
  const [result, setResult] = useState<EventRun | null>(null);
  const [copied, setCopied] = useState(false);

  /** O relógio em que o passo começou a olhar. Ver o cabeçalho. */
  const since = useRef<number>(Date.now());

  const command = `/ozdungeon build ${dungeon.id}`;

  useEffect(() => {
    if (!watching || !saved) return undefined;

    let alive = true;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await agent.dungeonRuns(dungeon.id, {
            serverId: serverId === '' ? undefined : serverId,
            since: since.current,
          });

          const run = response.runs[0];

          if (alive && run !== undefined) {
            // Para no PRIMEIRO resultado — inclusive numa falha.
            // Um spinner que continua girando depois de `no_hatch`
            // deixa o admin esperando por algo que não vem.
            setResult(run);
            setWatching(false);
          }
        } catch {
          // Silêncio de propósito: o agente pode estar reiniciando,
          // e um erro por tentativa encheria a tela de vermelho
          // enquanto o admin nem olhou para cá.
        }
      })();
    }, WATCH_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [watching, saved, dungeon.id, serverId]);

  if (!saved) {
    return (
      <StepBody title="Falta gravar" hint="A masmorra precisa existir antes de o jogo conhecê-la.">
        <p className="text-sm text-muted">
          Clique em <strong className="text-foreground">Criar</strong> aqui embaixo. Assim que ela
          for gravada, o agente manda a receita ao servidor e este passo mostra o comando.
        </p>
        <Button variant="confirm" size="sm" onClick={onSave}>
          Criar agora
        </Button>
      </StepBody>
    );
  }

  return (
    <StepBody
      title="Onde ela nasce"
      hint="Esta é a única parte que não dá para fazer daqui — e não é limitação, é o ponto."
    >
      <p className="text-sm">
        O painel sabe tudo sobre esta masmorra, menos <strong>onde ela deve nascer</strong>. Aquela
        encosta com vista, longe das bases e perto da estrada, não está em nenhum banco de dados.
      </p>

      {servers.length > 1 && (
        <div className="max-w-xs">
          <FieldLabel>Servidor</FieldLabel>
          <select
            value={serverId}
            onChange={(event) => setServerId(event.target.value)}
            className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
          >
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="border border-border bg-surface-2 p-3">
        <p className="text-xs text-muted">
          Entre no jogo, vá até o lugar, <strong className="text-foreground">olhe para a direção</strong>{' '}
          em que ela deve crescer, e cole:
        </p>

        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate border border-border bg-background px-3 py-2 font-mono text-sm text-foreground">
            {command}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(command);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? (
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <WatchPanel
        watching={watching}
        result={result}
        onStart={() => {
          since.current = Date.now();
          setResult(null);
          setWatching(true);
        }}
        onStop={() => setWatching(false)}
      />
    </StepBody>
  );
}

/** O estado da espera. É ele que faz o passo terminar sozinho. */
function WatchPanel({
  watching,
  result,
  onStart,
  onStop,
}: {
  readonly watching: boolean;
  readonly result: EventRun | null;
  readonly onStart: () => void;
  readonly onStop: () => void;
}) {
  if (result !== null) {
    const failed = result.status === 'failed';

    return (
      <div
        className={cn(
          'border-l-2 bg-surface-2 px-3 py-3',
          failed ? 'border-amber' : 'border-olive',
        )}
      >
        <p className="font-condensed text-sm font-bold uppercase tracking-wide">
          {failed ? 'Não deu' : 'Construída'}
        </p>
        <p className="mt-1 text-xs text-muted">
          {failed
            ? (result.failureMessage ?? result.failureReason ?? 'Motivo desconhecido.')
            : `Em ${result.grid ?? '?'}, às ${formatTime(result.startedAt)}.`}
        </p>
        <Button size="sm" variant="outline" className="mt-2" onClick={onStart}>
          Esperar de novo
        </Button>
      </div>
    );
  }

  if (watching) {
    return (
      <div className="flex items-center justify-between gap-3 border-l-2 border-amber bg-surface-2 px-3 py-3">
        <p className="flex items-center gap-2 text-sm">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-muted" />
          Esperando você construir…
        </p>
        <Button size="sm" variant="ghost" onClick={onStop}>
          Deixar para depois
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 border border-border bg-surface-2 px-3 py-3">
      <p className="text-xs text-muted">
        Quando você colar o comando, esta tela percebe sozinha e mostra o resultado.
      </p>
      <Button size="sm" variant="primary" onClick={onStart}>
        Ficar de olho
      </Button>
    </div>
  );
}

// ------------------------------------------------------------
//  As peças pequenas
// ------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="font-condensed text-2xs uppercase tracking-wide text-muted">{label}</span>
      <div className="mt-1">{children}</div>
      {hint !== undefined && <span className="mt-1 block text-2xs text-muted">{hint}</span>}
    </label>
  );
}

function RangeRow({
  value,
  min,
  max,
  unit,
  compact,
  onChange,
}: {
  readonly value: { readonly min: number; readonly max: number };
  readonly min: number;
  readonly max: number;
  readonly unit?: string;
  readonly compact?: boolean;
  readonly onChange: (value: { min: number; max: number }) => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <Input
        type="number"
        min={min}
        max={max}
        value={value.min}
        className={compact === true ? 'w-16' : 'w-20'}
        onChange={(event) => {
          const next = clampInt(event.target.value, min, max);

          // Empurrar o máximo junto evita o estado inválido em vez
          // de reclamar dele: quem digita 20 no mínimo quer uma
          // masmorra de 20, não um formulário vermelho.
          onChange({ min: next, max: Math.max(next, value.max) });
        }}
      />
      <span className="text-2xs text-muted">a</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={value.max}
        className={compact === true ? 'w-16' : 'w-20'}
        onChange={(event) => {
          const next = clampInt(event.target.value, min, max);

          onChange({ min: Math.min(next, value.min), max: next });
        }}
      />
      {unit !== undefined && <span className="text-2xs text-muted">{unit}</span>}
    </div>
  );
}

function Percent({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-9 flex-1 accent-[var(--rust-red)]"
      />
      <span className="w-10 shrink-0 text-right font-condensed text-sm font-bold tabular-nums">
        {value}%
      </span>
    </div>
  );
}

/** Uma lista de textos curtos: armas, nomes, prefabs. */
function TokenList({
  values,
  placeholder,
  onChange,
}: {
  readonly values: readonly string[];
  readonly placeholder: string;
  readonly onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  function add() {
    const value = draft.trim();

    if (value === '' || values.includes(value)) {
      setDraft('');
      return;
    }

    onChange([...values, value]);
    setDraft('');
  }

  return (
    <div className="mt-1">
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <span
            key={value}
            className="flex items-center gap-1 border border-border bg-surface-2 px-2 py-1 font-mono text-2xs"
          >
            {value}
            <button
              type="button"
              onClick={() => onChange(values.filter((item) => item !== value))}
              aria-label={`Remover ${value}`}
              className="text-muted hover:text-foreground"
            >
              <Trash2 aria-hidden="true" className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>

      <div className="mt-2 flex gap-2">
        <Input
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" variant="outline" onClick={add}>
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function CrateList({
  crates,
  onChange,
  className,
}: {
  readonly crates: readonly string[];
  readonly onChange: (crates: string[]) => void;
  readonly className?: string;
}) {
  return (
    <div className={className}>
      <FieldLabel>Caixas desta cor</FieldLabel>
      <TokenList
        values={crates}
        placeholder="assets/bundled/prefabs/radtown/crate_normal.prefab"
        onChange={onChange}
      />
    </div>
  );
}

function ModeCard({
  active,
  title,
  detail,
  disabled,
  onClick,
}: {
  readonly active: boolean;
  readonly title: string;
  readonly detail: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled === true}
      aria-pressed={active}
      className={cn(
        'border p-3 text-left transition-colors',
        active ? 'border-rust bg-rust/10' : 'border-border bg-surface-2 hover:border-muted',
        disabled === true && 'cursor-not-allowed opacity-50',
      )}
    >
      <span className="block font-condensed text-xs font-bold uppercase tracking-wide">
        {title}
      </span>
      <span className="mt-1 block text-2xs text-muted">{detail}</span>
    </button>
  );
}

function BlueprintCard({
  active,
  title,
  detail,
  warning,
  onClick,
}: {
  readonly active: boolean;
  readonly title: string;
  readonly detail: string;
  readonly warning?: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'border p-3 text-left transition-colors',
        active ? 'border-rust bg-rust/10' : 'border-border bg-surface-2 hover:border-muted',
      )}
    >
      <span className="block truncate font-condensed text-xs font-bold uppercase tracking-wide">
        {title}
      </span>
      <span className="mt-1 block text-2xs text-muted">{detail}</span>
      {warning !== undefined && (
        <span className="mt-1 block border-l-2 border-amber pl-2 text-2xs text-foreground">
          {warning}
        </span>
      )}
    </button>
  );
}

// ####  O BLOCO "COMO UMA MASMORRA FUNCIONA" SAIU DAQUI  ####
//
// Ele ficava no pé do passo ①, repetindo o que o "Como funciona" do
// cabeçalho da página já diz — e ocupava, no passo mais estreito do
// editor, o lugar da decisão que importa ali.
//
// Explicação genérica não é campo de formulário: quem quer entender
// o modelo clica no "?" da página; quem está criando uma masmorra
// está escolhendo entre receita e planta.

// ------------------------------------------------------------

function validate(draft: DungeonInput): Record<string, string | undefined> {
  const problems: Record<string, string | undefined> = {};

  if (draft.name.trim() === '') problems.identidade = 'Falta o nome.';
  else if (draft.id.length < 2) problems.identidade = 'Falta o identificador.';

  const total = draft.weights.green + draft.weights.blue + draft.weights.red;

  if (total === 0) problems.tamanho = 'Pelo menos uma cor precisa ter peso maior que zero.';

  if (draft.npc.weapons.length === 0) problems.inimigos = 'Sem arma nenhuma, os NPCs ficam inertes.';

  if (draft.mode === 'blueprint' && (draft.grid === null || draft.grid.length === 0)) {
    problems.tamanho = 'Falta desenhar: sem traçado não há o que construir.';
  }

  // ####  AS DUAS REGRAS DA FECHADURA, ANTES DE O AGENTE RECUSAR  ####
  //
  // A rota também as cobra — mas o sintoma de errar aqui é MUDO no
  // jogo (a sala nasce lacrada, o construtor destranca e grita num
  // console que ninguém lê), e o admin conserta enquanto ainda está
  // olhando para o campo.
  const anyLocked = draft.rooms.some((current) => current.locked);

  if (anyLocked && draft.lock.enabled) {
    if (draft.lock.carrier === 'none') {
      problems.salas =
        'Há sala trancada e ninguém para carregar o código: escolha um inimigo ou uma caixa, ou destranque as salas.';
    } else if (
      draft.lock.carrier === 'npc' &&
      draft.lock.carrierScope === 'corridor' &&
      draft.corridor.npcDensity === 0
    ) {
      problems.salas =
        'O código sai de um inimigo do corredor, e o corredor não tem nenhum: suba a densidade no passo Tamanho, ou permita o portador em qualquer lugar.';
    }
  }

  // Uma tabela sem itens em "acrescenta" ou "substitui" não muda
  // nada, e o schema do agente a recusa. Melhor dizer qual é.
  const emptyTable = [
    ...draft.rooms.map((current) => ({
      table: current.table,
      where: `da sala ${COLOR_LABEL[current.color].toLowerCase()}`,
    })),
    { table: draft.corridor.table, where: 'do corredor' },
  ].find((entry) => entry.table.mode !== 'server' && entry.table.entries.length === 0);

  if (emptyTable !== undefined) {
    problems.salas = `A tabela de loot ${emptyTable.where} não tem item nenhum: acrescente um, ou volte para "a do servidor".`;
  }

  if (draft.npc.loot.mode !== 'server' && draft.npc.loot.entries.length === 0) {
    problems.inimigos =
      'A tabela do corpo do inimigo não tem item nenhum: acrescente um, ou volte para "a do servidor".';
  }

  return problems;
}

/**
 * A masmorra que o agente devolveu, no formato do rascunho.
 *
 * ####  CADA CAMPO NOVO GANHA UM PADRÃO AQUI  ####
 *
 * O tipo do painel NÃO valida a resposta: um campo que o agente
 * omitir chega como `undefined`, e o primeiro `draft.lock.enabled`
 * do render derruba a página inteira com "This page couldn't
 * load". Isso já aconteceu neste projeto.
 *
 * Um agente atualizado manda tudo — mas um painel novo contra um
 * agente que ainda não subiu é exatamente o caso em que isso
 * acontece, e é barato de sustentar.
 */
function toInput(dungeon: Dungeon): DungeonInput {
  const { createdAt: _created, updatedAt: _updated, ...input } = dungeon;

  return {
    ...input,
    corridor: {
      ...input.corridor,
      table: input.corridor.table ?? { ...SERVER_TABLE },
      ai: input.corridor.ai ?? {},
    },
    npc: {
      ...input.npc,
      loot: input.npc.loot ?? { ...SERVER_TABLE },
      ai: input.npc.ai ?? {},
    },
    entranceItems: input.entranceItems ?? 'none',
    entranceRotation: input.entranceRotation ?? 0,
    entranceFacing: input.entranceFacing ?? null,
    marker: input.marker ?? { ...EMPTY.marker },
    announce: input.announce ?? { ...EMPTY.announce },
    structure: input.structure ?? { ...EMPTY.structure },
    lock: input.lock ?? { ...EMPTY.lock },
    access: input.access ?? { ...EMPTY.access },
    protection: input.protection ?? { ...EMPTY.protection },
    respawn: input.respawn ?? { ...EMPTY.respawn },
    rooms: input.rooms.map((current) => ({
      ...current,
      wideDoor: current.wideDoor ?? null,
      wideDoorCellsPerDoor: current.wideDoorCellsPerDoor ?? 4,
      grade: current.grade ?? null,
      table: current.table ?? { ...SERVER_TABLE },
      ai: current.ai ?? {},
    })),
  };
}

/**
 * Um traçado do gerador, no formato do desenho.
 *
 * Reusa o `previewLayout` — o mesmo algoritmo do servidor — e o
 * escreve nas linhas que o editor lê. É o que faz "sortear" e
 * "desenhar" serem o mesmo objeto, e não dois formatos.
 */
function sketchFromLayout(
  rooms: number,
  seed: number,
  weights: { readonly green: number; readonly blue: number; readonly red: number },
): string[] {
  const preview = previewLayout(rooms, seed);
  const { minX, maxX, minZ, maxZ } = preview.bounds;

  // ####  A COR VEM DOS PESOS, E É SORTEADA POR SALA  ####
  //
  // MEDIDO: sem isto o traçado saía inteiro verde, porque o formato
  // não carregava cor nenhuma. Sortear por CÉLULA seria pior — a
  // mesma sala nasceria com dois cômodos de cores diferentes, e a
  // cor deixaria de significar o que ela promete.
  const total = Math.max(1, weights.green + weights.blue + weights.red);
  const colorOfRoom = new Map<number, string>();

  const pick = (room: number): string => {
    const known = colorOfRoom.get(room);

    if (known !== undefined) return known;

    // Determinístico na semente: sortear outra vez com a mesma
    // semente tem de dar o mesmo desenho.
    const roll = (seed * 31 + room * 7919) % total;
    const color = roll < weights.green ? 'G' : roll < weights.green + weights.blue ? 'B' : 'R';

    colorOfRoom.set(room, color);

    return color;
  };

  const at = new Map<string, string>();

  for (const cell of preview.cells) {
    at.set(
      `${String(cell.x)},${String(cell.z)}`,
      cell.kind === 'entrance' ? 'E' : cell.kind === 'corridor' ? '#' : pick(cell.room),
    );
  }

  const rows: string[] = [];

  // Do maior z para o menor: a primeira linha e a de cima.
  for (let z = maxZ; z >= minZ; z -= 1) {
    let line = '';

    for (let x = minX; x <= maxX; x += 1) line += at.get(`${String(x)},${String(z)}`) ?? '.';

    rows.push(line);
  }

  return rows;
}

/**
 * Que passos têm alguma coisa além do padrão de fábrica.
 *
 * ####  O SELO PRECISAVA DE UM SIGNIFICADO  ####
 *
 * Antes, quatro dos seis passos diziam "pronto" sempre. Agora o ✓
 * quer dizer uma coisa só: aqui dentro há uma escolha que alguém
 * fez. Passo intocado fica cinza, com o número — que é o convite
 * para abri-lo.
 *
 * A comparação é por JSON contra o rascunho vazio. Ela é grossa de
 * propósito: reordenar as chaves de um objeto marcaria o passo sem
 * ninguém ter mexido nele, e o custo desse erro é um visto verde a
 * mais — não uma masmorra errada.
 */
function whatChanged(draft: DungeonInput): {
  readonly tamanho: boolean;
  readonly inimigos: boolean;
  readonly entrada: boolean;
  readonly anuncio: boolean;
} {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  return {
    tamanho:
      draft.mode === 'blueprint'
        ? draft.grid !== null && draft.grid.length > 0
        : !same(draft.size, EMPTY.size) ||
          !same(draft.weights, EMPTY.weights) ||
          !same(draft.corridor, EMPTY.corridor),
    inimigos: !same(draft.npc, EMPTY.npc),
    entrada:
      draft.entranceBlueprint !== null ||
      draft.entranceItems !== EMPTY.entranceItems ||
      !same(draft.access, EMPTY.access) ||
      !same(draft.protection, EMPTY.protection),
    anuncio: !same(draft.marker, EMPTY.marker) || !same(draft.announce, EMPTY.announce),
  };
}

/**
 * A frase do rodapé, para o passo que está aberto.
 *
 * ####  ELA ERA UMA SÓ, E FALAVA DO PASSO ERRADO  ####
 *
 * "Salva. O jogo já recebeu — falta escolher onde ela nasce, no
 * passo Construir" aparecia enquanto o admin digitava o nome. A
 * frase certa, na hora errada, ocupa o lugar da frase certa.
 */
function footerHint(step: string, saved: boolean): string {
  if (!saved && step !== 'construir') {
    return 'Nada foi gravado ainda: o botão aqui do lado grava, e o jogo recebe na hora.';
  }

  switch (step) {
    case 'identidade':
      return 'O identificador não muda depois de criada: é por ele que o comando no jogo a encontra.';
    case 'tamanho':
      return 'A prévia ao lado mostra a masmorra que vai nascer com estes números.';
    case 'salas':
      return 'A cor da sala é o que o jogador aprende sem ler nada: vermelha quer dizer "cuidado, e vale a pena".';
    case 'inimigos':
      return 'O que estiver em branco aqui herda o padrão da masmorra — e não vira zero.';
    case 'entrada':
      return 'A casinha é a única parte que os jogadores veem de fora.';
    case 'anuncio':
      return 'Sem marcador e sem aviso, só acha a masmorra quem tropeçar nela.';
    case 'construir':
      return 'Salva, e o jogo já recebeu. Falta escolher onde ela nasce.';
    default:
      return 'Salva. O jogo já recebeu.';
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function clampInt(raw: string, min: number, max: number): number {
  const value = Number.parseInt(raw, 10);

  if (Number.isNaN(value)) return min;

  return Math.min(max, Math.max(min, value));
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${String(Math.round(bytes / 1024))} KB`;
}

function formatTime(epoch: number | null): string {
  if (epoch === null) return '?';

  return new Date(epoch).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
