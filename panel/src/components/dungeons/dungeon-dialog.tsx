'use client';

// ============================================================
//  dungeon-dialog.tsx  -  montar uma masmorra sem ler manual.
//
//  ####  SÃO TRINTA CAMPOS  ####
//
//  Numa tela só, ninguém preenche o décimo. Então eles viram uma
//  trilha de seis passos, e cada passo cabe numa tela:
//
//    ① identidade   ② tamanho e mistura   ③ o que tem dentro
//    ④ os inimigos  ⑤ a entrada           ⑥ construir
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

import { Check, Copy, Dices, Loader2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { DungeonGridEditor } from '@/components/dungeons/dungeon-grid-editor';
import { DungeonPreviewPanel } from '@/components/dungeons/dungeon-preview';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FieldLabel } from '@/components/ui/help-tip';
import { Input } from '@/components/ui/input';
import { StepBody, Steps, type Step } from '@/components/ui/steps';
import { Toggle } from '@/components/ui/toggle';
import { previewLayout } from '@/lib/dungeon-layout';
import {
  agent,
  type BlueprintSummary,
  type Dungeon,
  type DungeonInput,
  type DungeonRoom,
  type EventRun,
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
};

/** A que a cor da sala corresponde. Manter isso é o que faz a cor avisar. */
const DOOR_OF_COLOR: Readonly<Record<RoomColor, RoomDoor>> = {
  green: 'wood',
  blue: 'metal',
  red: 'toptier',
};

const EMPTY: DungeonInput = {
  id: '',
  name: '',
  description: null,
  mode: 'recipe',
  entranceBlueprint: null,
  size: { min: 10, max: 15 },
  weights: { green: 60, blue: 30, red: 10 },
  corridor: {
    npcDensity: 20,
    lootDensity: 10,
    crates: ['assets/bundled/prefabs/radtown/crate_normal.prefab'],
  },
  grid: null,
  npc: {
    health: { min: 100, max: 150 },
    damageScale: 1,
    weapons: ['rifle.semiauto', 'pistol.m92'],
    names: ['Guardião', 'Sentinela'],
  },
  timeOfDay: 0,
  rooms: [
    {
      key: 'green',
      color: 'green',
      npc: { min: 0, max: 1 },
      loot: { min: 1, max: 1 },
      crates: ['assets/bundled/prefabs/radtown/crate_normal.prefab'],
      door: 'wood',
      locked: false,
    },
    {
      key: 'blue',
      color: 'blue',
      npc: { min: 1, max: 2 },
      loot: { min: 1, max: 2 },
      crates: ['assets/bundled/prefabs/radtown/crate_normal.prefab'],
      door: 'metal',
      locked: false,
    },
    {
      key: 'red',
      color: 'red',
      npc: { min: 2, max: 3 },
      loot: { min: 2, max: 3 },
      crates: ['assets/bundled/prefabs/radtown/crate_elite.prefab'],
      door: 'toptier',
      locked: true,
    },
  ],
};

export interface DungeonDialogProps {
  /** `null` = criando. */
  readonly dungeon: Dungeon | null;
  readonly blueprints: readonly BlueprintSummary[];
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}

export function DungeonDialog({
  dungeon,
  blueprints,
  servers,
  onClose,
  onSaved,
}: DungeonDialogProps) {
  const [draft, setDraft] = useState<DungeonInput>(() =>
    dungeon === null ? EMPTY : toInput(dungeon),
  );
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
      done: true,
    },
    { id: 'salas', label: 'Salas', done: draft.rooms.length > 0 },
    { id: 'inimigos', label: 'Inimigos', problem: problems.inimigos, done: true },
    { id: 'entrada', label: 'Entrada', done: true },
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

      <div className="max-h-[60vh] overflow-y-auto">
        {step === 'identidade' && (
          <StepIdentidade draft={draft} patch={patch} locked={saved} />
        )}

        {step === 'tamanho' && draft.mode === 'blueprint' && (
          <StepDesenho draft={draft} patch={patch} />
        )}

        {step === 'tamanho' && draft.mode === 'recipe' && (
          <WithPreview draft={draft} seed={seed} onReseed={() => setSeed((n) => n + 1)}>
            <StepTamanho draft={draft} patch={patch} />
          </WithPreview>
        )}

        {step === 'salas' && (
          <WithPreview draft={draft} seed={seed} onReseed={() => setSeed((n) => n + 1)}>
            <StepSalas draft={draft} patch={patch} />
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
            <span>
              {saved
                ? 'Salva. O jogo já recebeu — falta escolher onde ela nasce, no passo Construir.'
                : 'Nada foi gravado ainda.'}
            </span>
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

  return (
    <div className="grid gap-0 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0">{children}</div>
      <div className="border-t border-border p-4 lg:border-l lg:border-t-0">
        <DungeonPreviewPanel
          rooms={rooms}
          seed={seed}
          onReseed={onReseed}
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

      <HelpCallout topic="modelo" />
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
    </StepBody>
  );
}

/**
 * O passo do modo planta: a tela de desenho.
 *
 * ####  SORTEAR TAMBÉM É UM JEITO DE COMEÇAR  ####
 *
 * Encarar um grid de 24×24 em branco é tão paralisante quanto
 * trinta campos vazios. O botão de sortear enche a tela com um
 * traçado do gerador — e a partir dali o admin apaga, estica e
 * repinta o que quiser.
 *
 * Os dois caminhos que o dono pediu, no mesmo lugar: gerar, ou
 * desenhar. E gerar é só o primeiro traço de desenhar.
 */
function StepDesenho({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  return (
    <StepBody
      title="Desenhe a masmorra"
      hint="Cada quadradinho é um cômodo de 3 por 3 metros. Arraste para pintar; a porta nasce sozinha onde a sala encosta no corredor."
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel topic={DUNGEON_HELP.desenho}>O traçado</FieldLabel>

        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            // Sortear é o primeiro traço: o gerador enche a tela e
            // o admin edita a partir dali.
            const rooms = Math.round((draft.size.min + draft.size.max) / 2);
            patch({ grid: sketchFromLayout(rooms, Date.now() % 100_000) });
          }}
        >
          <Dices aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          Sortear um traçado
        </Button>
      </div>

      <DungeonGridEditor grid={draft.grid} onChange={(grid) => patch({ grid })} />
    </StepBody>
  );
}

// ------------------------------------------------------------
//  ③  O QUE TEM DENTRO
// ------------------------------------------------------------

function StepSalas({
  draft,
  patch,
}: {
  readonly draft: DungeonInput;
  readonly patch: (change: Partial<DungeonInput>) => void;
}) {
  function update(index: number, change: Partial<DungeonRoom>) {
    const rooms = draft.rooms.map((room, at) => (at === index ? { ...room, ...change } : room));

    patch({ rooms });
  }

  return (
    <StepBody
      title="O que tem dentro de cada cor"
      hint="A cor é o nível do cômodo: quantos inimigos, que loot, que porta o jogador encontra."
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

              {room.door !== DOOR_OF_COLOR[room.color] && (
                <span className="border-l-2 border-amber pl-2 text-2xs text-foreground">
                  A porta não corresponde à cor: o aviso visual deixa de funcionar.
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
                  {(['wood', 'metal', 'toptier'] as const).map((door) => (
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

            <CrateList
              crates={room.crates}
              onChange={(crates) => update(index, { crates })}
              className="mt-3"
            />
          </div>
        ))}
      </div>
    </StepBody>
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
    </StepBody>
  );
}

// ------------------------------------------------------------
//  ⑤  A ENTRADA
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
    </StepBody>
  );
}

// ------------------------------------------------------------
//  ⑥  CONSTRUIR — o passo que se resolve sozinho
// ------------------------------------------------------------

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

/** Um bloco de ajuda aberto, para o que ninguém adivinha. */
function HelpCallout({ topic }: { readonly topic: keyof typeof DUNGEON_HELP }) {
  const help = DUNGEON_HELP[topic];

  return (
    <div className="border border-border bg-surface-2 p-3">
      <p className="font-condensed text-2xs uppercase tracking-wide text-muted">{help.title}</p>
      <p className="mt-1 text-xs">{help.short}</p>
    </div>
  );
}

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

  return problems;
}

function toInput(dungeon: Dungeon): DungeonInput {
  const { createdAt: _created, updatedAt: _updated, ...input } = dungeon;

  return input;
}

/**
 * Um traçado do gerador, no formato do desenho.
 *
 * Reusa o `previewLayout` — o mesmo algoritmo do servidor — e o
 * escreve nas linhas que o editor lê. É o que faz "sortear" e
 * "desenhar" serem o mesmo objeto, e não dois formatos.
 */
function sketchFromLayout(rooms: number, seed: number): string[] {
  const preview = previewLayout(rooms, seed);
  const { minX, maxX, minZ, maxZ } = preview.bounds;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const at = new Map<string, string>();

  for (const cell of preview.cells) {
    at.set(
      `${String(cell.x)},${String(cell.z)}`,
      cell.kind === 'entrance'
        ? 'E'
        : cell.kind === 'corridor'
          ? '#'
          : (letters[cell.room % letters.length] ?? 'A'),
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
