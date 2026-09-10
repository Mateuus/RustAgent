'use client';

// ============================================================
//  ai-fields.tsx  -  o comportamento do inimigo, em dezenove
//                    campos que quase sempre ficam em branco.
//
//  ####  BRANCO AQUI QUER DIZER "HERDA", E NUNCA ZERO  ####
//
//  O bloco aparece em cinco lugares — o padrão da masmorra, cada
//  cor de sala e o corredor — e o de baixo sobrescreve o de cima
//  CAMPO A CAMPO. Um campo vazio na sala vermelha não é "alcance de
//  visão zero": é "não falei disso", e o número do padrão fica de
//  pé.
//
//  Por isso todo campo mostra o valor herdado como marca-d'água, e
//  todo campo preenchido ganha um botão de LIMPAR. Sem os dois, o
//  admin não teria como saber se 18 é o que ele escolheu ou o que
//  veio de cima — nem como voltar atrás depois de digitar.
//
//  ####  E OS BOOLEANOS SÃO TRÊS ESTADOS  ####
//
//  "herda", "sim" e "não". Um Toggle de dois estados obrigaria o
//  campo a existir no instante em que a tela abre — e a sala
//  vermelha passaria a mandar `requireLineOfSight: true` que
//  ninguém pediu.
// ============================================================

import { RotateCcw } from 'lucide-react';

import { FieldLabel } from '@/components/ui/help-tip';
import { Input } from '@/components/ui/input';
import { AI_DEFAULTS, type AiSpec } from '@/lib/api';
import { DUNGEON_HELP } from '@/lib/help/dungeons';

/** Só os campos numéricos: os booleanos têm outro controle. */
type NumberField = {
  [K in keyof AiSpec]-?: NonNullable<AiSpec[K]> extends number ? K : never;
}[keyof AiSpec];

type BoolField = {
  [K in keyof AiSpec]-?: NonNullable<AiSpec[K]> extends boolean ? K : never;
}[keyof AiSpec];

interface NumberSpec {
  readonly field: NumberField;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
}

interface BoolSpec {
  readonly field: BoolField;
  readonly label: string;
  /** O que "sim" e "não" querem dizer, nesta ordem. */
  readonly yes: string;
  readonly no: string;
}

/**
 * Os grupos, na ordem em que um admin pensa.
 *
 * Percepção primeiro (ele viu?), depois movimento (ele vem?),
 * depois combate (ele acerta?). O ritmo é o último de propósito:
 * ele existe para o servidor cheio, não para o jogo.
 */
const PERCEPTION_NUMBERS: readonly NumberSpec[] = [
  { field: 'visionRadius', label: 'Alcance de visão', min: 0, max: 150, step: 1, unit: 'm' },
  { field: 'loseTargetAfter', label: 'Desiste depois de', min: 0, max: 300, step: 0.5, unit: 's' },
  { field: 'reactionDelay', label: 'Demora para atirar', min: 0, max: 30, step: 0.05, unit: 's' },
  {
    field: 'maxTargetHeightDelta',
    label: 'Diferença de altura',
    min: 0.5,
    max: 50,
    step: 0.5,
    unit: 'm',
  },
];

const PERCEPTION_BOOLS: readonly BoolSpec[] = [
  {
    field: 'requireLineOfSight',
    label: 'Precisa enxergar',
    yes: 'Sim: parede segura o tiro',
    no: 'Não: atira através da parede',
  },
  { field: 'alertOnSpot', label: 'Grita ao avistar', yes: 'Sim', no: 'Não' },
];

const MOVEMENT_NUMBERS: readonly NumberSpec[] = [
  { field: 'moveSpeed', label: 'Velocidade de perseguição', min: 0, max: 12, step: 0.1, unit: 'm/s' },
  { field: 'chaseRadius', label: 'Coleira do posto', min: 0, max: 250, step: 1, unit: 'm' },
  { field: 'returnSpeed', label: 'Velocidade da volta', min: 0, max: 12, step: 0.1, unit: 'm/s' },
  { field: 'arriveRadius', label: 'Chegou quando falta', min: 0.1, max: 10, step: 0.1, unit: 'm' },
  { field: 'stuckTimeout', label: 'Preso por', min: 0, max: 120, step: 1, unit: 's' },
];

const MOVEMENT_BOOLS: readonly BoolSpec[] = [
  { field: 'holdPosition', label: 'Fica no posto', yes: 'Sim: nunca sai', no: 'Não: persegue' },
  { field: 'returnHome', label: 'Volta ao posto', yes: 'Sim', no: 'Não: fica onde parou' },
];

const COMBAT_NUMBERS: readonly NumberSpec[] = [
  { field: 'fireRange', label: 'Alcance de tiro', min: 0, max: 250, step: 1, unit: 'm' },
  { field: 'fireInterval', label: 'Entre tentativas', min: 0.05, max: 60, step: 0.05, unit: 's' },
  { field: 'standoffDistance', label: 'Para de andar a', min: 0, max: 100, step: 0.5, unit: 'm' },
  { field: 'aimConeScale', label: 'Dispersão do tiro', min: 0, max: 20, step: 0.05, unit: '×' },
];

const PACE_NUMBERS: readonly NumberSpec[] = [
  { field: 'senseInterval', label: 'Procura alvo a cada', min: 0.1, max: 10, step: 0.1, unit: 's' },
  { field: 'moveInterval', label: 'Dá um passo a cada', min: 0.05, max: 2, step: 0.05, unit: 's' },
];

export interface AiFieldsProps {
  readonly value: AiSpec;
  /**
   * O que vale quando este bloco não fala.
   *
   * No padrão da masmorra é `AI_DEFAULTS`; numa cor de sala é o
   * padrão da masmorra JÁ RESOLVIDO. É o que a marca-d'água mostra.
   */
  readonly inherited: AiSpec;
  readonly onChange: (value: AiSpec) => void;
}

export function AiFields({ value, inherited, onChange }: AiFieldsProps) {
  function set(field: keyof AiSpec, next: number | boolean | undefined) {
    const draft: AiSpec = { ...value };

    // ####  APAGAR A CHAVE, E NÃO GRAVAR `undefined`  ####
    //
    // O `JSON.stringify` omite a chave dos dois jeitos, mas o
    // `Object.keys` NÃO: um bloco com dezenove chaves em
    // `undefined` viajaria como um bloco "não vazio" e o sync
    // deixaria de enxugá-lo.
    if (next === undefined) delete draft[field];
    else Object.assign(draft, { [field]: next });

    onChange(draft);
  }

  return (
    <div className="space-y-4">
      <Group title="Percepção">
        {PERCEPTION_NUMBERS.map((spec) => (
          <NumberField
            key={spec.field}
            spec={spec}
            value={value[spec.field]}
            inherited={inheritedOf(inherited, spec.field)}
            onChange={(next) => set(spec.field, next)}
          />
        ))}
        {PERCEPTION_BOOLS.map((spec) => (
          <BoolField
            key={spec.field}
            spec={spec}
            value={value[spec.field]}
            inherited={inheritedOf(inherited, spec.field)}
            onChange={(next) => set(spec.field, next)}
          />
        ))}
      </Group>

      <Group title="Movimento">
        {MOVEMENT_NUMBERS.map((spec) => (
          <NumberField
            key={spec.field}
            spec={spec}
            value={value[spec.field]}
            inherited={inheritedOf(inherited, spec.field)}
            onChange={(next) => set(spec.field, next)}
          />
        ))}
        {MOVEMENT_BOOLS.map((spec) => (
          <BoolField
            key={spec.field}
            spec={spec}
            value={value[spec.field]}
            inherited={inheritedOf(inherited, spec.field)}
            onChange={(next) => set(spec.field, next)}
          />
        ))}
      </Group>

      <Group title="Combate">
        {COMBAT_NUMBERS.map((spec) => (
          <NumberField
            key={spec.field}
            spec={spec}
            value={value[spec.field]}
            // `aimConeScale` é o único sem padrão nosso: sem ordem
            // do painel quem manda é o prefab do cientista, e não há
            // número honesto para mostrar aqui.
            inherited={inheritedOf(inherited, spec.field)}
            onChange={(next) => set(spec.field, next)}
          />
        ))}
      </Group>

      <Group title="Ritmo">
        <p className="col-span-full text-2xs text-muted">
          Estes dois existem para o servidor cheio, não para o jogo: eles decidem quantas vezes por
          segundo cada inimigo pensa. Mexer sem necessidade só custa tick.
        </p>
        {PACE_NUMBERS.map((spec) => (
          <NumberField
            key={spec.field}
            spec={spec}
            value={value[spec.field]}
            inherited={inheritedOf(inherited, spec.field)}
            onChange={(next) => set(spec.field, next)}
          />
        ))}
      </Group>
    </div>
  );
}

/**
 * Resolve a herança de um bloco sobre outro.
 *
 * É a mesma conta do `AiProfile.Apply` do plugin, e ela mora aqui
 * para a tela poder mostrar o que a sala vai REALMENTE usar — e não
 * o padrão de fábrica quando a masmorra já mudou o número.
 */
export function resolveAi(base: AiSpec, over: AiSpec): AiSpec {
  return { ...base, ...over };
}

function Group({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 font-condensed text-2xs uppercase tracking-wide text-muted">{title}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </div>
  );
}

function NumberField({
  spec,
  value,
  inherited,
  onChange,
}: {
  readonly spec: NumberSpec;
  readonly value: number | undefined;
  readonly inherited: number | boolean | undefined;
  readonly onChange: (value: number | undefined) => void;
}) {
  const placeholder =
    typeof inherited === 'number' ? String(inherited) : 'do jogo';

  return (
    <div>
      <FieldLabel topic={DUNGEON_HELP[helpTopicOf(spec.field)]}>{spec.label}</FieldLabel>
      <div className="mt-1 flex items-center gap-1">
        <Input
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value ?? ''}
          placeholder={placeholder}
          onChange={(event) => {
            const raw = event.target.value;

            if (raw === '') {
              onChange(undefined);
              return;
            }

            const parsed = Number(raw);

            onChange(Number.isNaN(parsed) ? undefined : clamp(parsed, spec.min, spec.max));
          }}
        />
        <span className="w-7 shrink-0 text-2xs text-muted">{spec.unit}</span>
        <ClearButton shown={value !== undefined} label={spec.label} onClear={() => onChange(undefined)} />
      </div>
    </div>
  );
}

function BoolField({
  spec,
  value,
  inherited,
  onChange,
}: {
  readonly spec: BoolSpec;
  readonly value: boolean | undefined;
  readonly inherited: number | boolean | undefined;
  readonly onChange: (value: boolean | undefined) => void;
}) {
  const herdado = typeof inherited === 'boolean' ? (inherited ? spec.yes : spec.no) : '—';

  return (
    <div>
      <FieldLabel topic={DUNGEON_HELP[helpTopicOf(spec.field)]}>{spec.label}</FieldLabel>
      <select
        value={value === undefined ? '' : value ? 'sim' : 'nao'}
        onChange={(event) => {
          const raw = event.target.value;

          onChange(raw === '' ? undefined : raw === 'sim');
        }}
        className="mt-1 h-9 w-full border border-border bg-background px-2 text-sm"
      >
        <option value="">Herda ({herdado})</option>
        <option value="sim">{spec.yes}</option>
        <option value="nao">{spec.no}</option>
      </select>
    </div>
  );
}

function ClearButton({
  shown,
  label,
  onClear,
}: {
  readonly shown: boolean;
  readonly label: string;
  readonly onClear: () => void;
}) {
  if (!shown) return <span aria-hidden="true" className="h-7 w-7 shrink-0" />;

  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={`Voltar a herdar: ${label}`}
      title="Voltar a herdar"
      className="flex h-7 w-7 shrink-0 items-center justify-center border border-border text-muted hover:border-muted hover:text-foreground"
    >
      <RotateCcw aria-hidden="true" className="h-3 w-3" />
    </button>
  );
}

/**
 * O verbete de ajuda daquele campo.
 *
 * Dezenove campos não ganham dezenove verbetes: quem precisa de
 * explicação é o CONCEITO, e os campos de um mesmo grupo dividem
 * um. É a mesma régua do resto da tela — nenhum número sem um `(?)`
 * que diga o que ele produz.
 */
function helpTopicOf(field: keyof AiSpec): keyof typeof DUNGEON_HELP {
  if (field === 'visionRadius' || field === 'requireLineOfSight' || field === 'loseTargetAfter') {
    return 'iaPercepcao';
  }

  if (field === 'reactionDelay' || field === 'maxTargetHeightDelta' || field === 'alertOnSpot') {
    return 'iaPercepcao';
  }

  if (field === 'aimConeScale') return 'iaDispersao';
  if (field === 'fireRange' || field === 'fireInterval' || field === 'standoffDistance') {
    return 'iaCombate';
  }

  if (field === 'senseInterval' || field === 'moveInterval') return 'iaRitmo';

  return 'iaMovimento';
}

/**
 * O que aquele campo vale se ninguém preencher.
 *
 * A camada de cima primeiro; sem ela, o padrão do jogo. E, para
 * `aimConeScale`, nada — o padrão dele mora no prefab do cientista,
 * dentro do bundle, e não há número honesto para mostrar aqui.
 */
function inheritedOf(inherited: AiSpec, field: keyof AiSpec): number | boolean | undefined {
  return inherited[field] ?? AI_DEFAULTS[field as keyof typeof AI_DEFAULTS];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
