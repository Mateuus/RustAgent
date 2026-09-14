'use client';

// ============================================================
//  rules-panel.tsx  -  a aba REGRAS do jogo, escrita aqui.
//
//  ####  O DESENHO É O DA TELA DO JOGO, DE PROPÓSITO  ####
//
//  Seções à esquerda, regras à direita: é a mesma divisão que o
//  jogador vê no `/menu`. Quem escreve aqui está montando aquela
//  tela, e uma ordem diferente nos dois lados faria o admin
//  publicar uma página que ele não reconhece.
//
//  ####  O ESCOPO É A PRIMEIRA PERGUNTA DA TELA  ####
//
//  REDE ou um servidor — e é a primeira coisa porque tudo o que
//  vem depois depende dela. Um servidor pode HERDAR a rede (o
//  padrão de todos) ou ter o conjunto próprio; enquanto ele herda,
//  o que se vê aqui é da rede e não se edita daqui, com a frase
//  dizendo isso.
//
//  Sem essa separação, editar "as regras do pvp1" mudaria as de
//  todo mundo — e só apareceria no jogo.
// ============================================================

import {
  ArrowDown,
  ArrowUp,
  Copy,
  FileText,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import {
  agent,
  type RuleSection,
  type RulesScopeMode,
  type RuleTone,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** O que cada tom quer dizer, em uma palavra. */
const TONES: readonly { readonly value: RuleTone; readonly label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'alerta', label: 'Alerta' },
  { value: 'proibido', label: 'Proibido' },
];

/** A cor da barra, igual à do jogo. Ver `toneColor` em ui-rules-screen.ts. */
const TONE_COLOR: Readonly<Record<RuleTone, string>> = {
  normal: 'bg-border',
  alerta: 'bg-amber',
  proibido: 'bg-rust',
};

export function RulesPanel() {
  /** `null` = a rede. É o escopo aberto. */
  const [scope, setScope] = useState<string | null>(null);
  const [servers, setServers] = useState<readonly string[]>([]);
  const [mode, setMode] = useState<RulesScopeMode>('inherit');
  const [sections, setSections] = useState<readonly RuleSection[] | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * O escopo é editável?
   *
   * Um servidor que herda mostra as regras DA REDE, e editá-las
   * daqui seria editar as de todo mundo achando que se mexe em um
   * servidor só.
   */
  const editable = scope === null || mode === 'own';

  const load = useCallback(async (): Promise<void> => {
    try {
      if (scope === null) {
        const response = await agent.rules();

        setServers(response.servers);
        setSections(response.sections);
        setMode('own');
      } else {
        const response = await agent.serverRules(scope);

        setMode(response.mode);
        setSections(response.mode === 'own' ? response.own : response.sections);
      }

      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não deu para ler as regras.');
      setSections(null);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(
    () => sections?.find((section) => section.id === activeId) ?? sections?.[0] ?? null,
    [sections, activeId],
  );

  /**
   * Toda escrita passa por aqui.
   *
   * A resposta do agente TRAZ a lista inteira, e é ela que vale —
   * remontar a lista no navegador faria a tela divergir do que foi
   * gravado no primeiro erro que ninguém tratasse.
   */
  const write = async (
    action: () => Promise<{ sections?: RuleSection[] } | undefined>,
    message?: string,
  ): Promise<void> => {
    setBusy(true);

    try {
      const response = await action();

      if (response?.sections === undefined) {
        await load();
      } else {
        setSections(response.sections);
      }

      if (message !== undefined) {
        toast.success(message);
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Não deu para gravar.');
    } finally {
      setBusy(false);
    }
  };

  const moveSection = (id: number, delta: number): void => {
    if (sections === null) return;

    const ids = sections.map((section) => section.id);
    const from = ids.indexOf(id);
    const to = from + delta;

    if (from < 0 || to < 0 || to >= ids.length) return;

    [ids[from], ids[to]] = [ids[to] as number, ids[from] as number];

    void write(async () => agent.reorderRuleSections(scope, ids));
  };

  const moveRule = (sectionId: number, id: number, delta: number): void => {
    const items = sections?.find((section) => section.id === sectionId)?.items ?? [];
    const ids = items.map((item) => item.id);
    const from = ids.indexOf(id);
    const to = from + delta;

    if (from < 0 || to < 0 || to >= ids.length) return;

    [ids[from], ids[to]] = [ids[to] as number, ids[from] as number];

    void write(async () => agent.reorderRules(sectionId, ids));
  };

  if (error !== null) {
    return <StateBlock variant="error" title="Não deu para ler as regras" detail={error} />;
  }

  if (sections === null) {
    return <StateBlock variant="loading" title="Lendo as regras…" />;
  }

  return (
    <div className="space-y-3">
      <ScopeBar
        scope={scope}
        servers={servers}
        onPick={(value) => {
          setScope(value);
          setActiveId(null);
        }}
      />

      {scope !== null && (
        <ServerScopeBox
          server={scope}
          mode={mode}
          busy={busy}
          onMode={(value) => {
            void write(async () => {
              const response = await agent.setServerRulesMode(scope, value);

              setMode(value);

              // Ao passar a herdar, o que a tela deve mostrar é o
              // conjunto da REDE — é o que o jogador vai ler.
              return value === 'own' ? undefined : { sections: response.sections };
            }, value === 'own' ? 'Este servidor passa a ter regras próprias.' : 'Este servidor voltou a herdar as regras da rede.');
          }}
          onCopy={() => {
            void write(async () => {
              const response = await agent.copyNetworkRules(scope);

              return { sections: response.own };
            }, 'As seções da rede foram copiadas para este servidor.');
          }}
        />
      )}

      <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
        <SectionColumn
          sections={sections}
          activeId={active?.id ?? null}
          editable={editable}
          busy={busy}
          onPick={setActiveId}
          onMove={moveSection}
          onCreate={(title) => {
            void write(async () => agent.createRuleSection({ server: scope, title, enabled: true }));
          }}
          onTemplate={() => {
            void write(
              async () => agent.seedRulesTemplate(scope),
              'O modelo entrou. Reescreva o texto antes de publicar.',
            );
          }}
        />

        {active === null ? (
          <StateBlock
            variant="empty"
            title="Nenhuma seção ainda"
            detail={
              editable
                ? 'Crie a primeira seção ao lado, ou comece pelo modelo.'
                : 'A rede ainda não publicou regras.'
            }
          />
        ) : (
          <RuleList
            section={active}
            editable={editable}
            busy={busy}
            onRename={(title) => {
              void write(async () =>
                agent.updateRuleSection(active.id, {
                  server: scope,
                  title,
                  enabled: active.enabled,
                }),
              );
            }}
            onEnabled={(enabled) => {
              void write(async () =>
                agent.updateRuleSection(active.id, {
                  server: scope,
                  title: active.title,
                  enabled,
                }),
              );
            }}
            onDelete={() => {
              setActiveId(null);
              void write(async () => agent.deleteRuleSection(active.id), 'Seção apagada.');
            }}
            onCreate={(text, tone) => {
              void write(async () => agent.createRule(active.id, { text, tone }));
            }}
            onUpdate={(id, text, tone) => {
              void write(async () => {
                await agent.updateRule(id, { text, tone });

                return undefined;
              });
            }}
            onRemove={(id) => {
              void write(async () => {
                await agent.deleteRule(id);

                return undefined;
              });
            }}
            onMove={(id, delta) => {
              moveRule(active.id, id, delta);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
//  O ESCOPO
// ------------------------------------------------------------

function ScopeBar({
  scope,
  servers,
  onPick,
}: {
  readonly scope: string | null;
  readonly servers: readonly string[];
  readonly onPick: (value: string | null) => void;
}) {
  const item = (value: string | null, label: string): React.ReactNode => (
    <button
      key={label}
      type="button"
      onClick={() => {
        onPick(value);
      }}
      className={cn(
        'border px-3 py-1.5 font-condensed text-xs font-bold uppercase tracking-wide',
        scope === value
          ? 'border-rust bg-rust/10 text-foreground'
          : 'border-border text-muted hover:border-muted hover:text-foreground',
      )}
    >
      {label}
    </button>
  );

  return (
    <Section title="De quem são estas regras">
      <div className="flex flex-wrap gap-2">
        {item(null, 'Rede')}
        {servers.map((server) => item(server, server))}
      </div>
      <p className="mt-2 text-xs text-muted">
        A REDE é o que todo servidor lê enquanto não disser o contrário. Um servidor só mostra
        regras próprias depois de você dizer isso aqui.
      </p>
    </Section>
  );
}

function ServerScopeBox({
  server,
  mode,
  busy,
  onMode,
  onCopy,
}: {
  readonly server: string;
  readonly mode: RulesScopeMode;
  readonly busy: boolean;
  readonly onMode: (value: RulesScopeMode) => void;
  readonly onCopy: () => void;
}) {
  return (
    <Section
      title={`O que ${server} mostra`}
      aside={
        <Toggle
          on={mode === 'own'}
          busy={busy}
          label="De onde este servidor lê as regras"
          labels={['Regras próprias', 'Herda da rede']}
          onChange={(value) => {
            onMode(value ? 'own' : 'inherit');
          }}
        />
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          {mode === 'own'
            ? 'Este servidor mostra o conjunto abaixo. As regras da rede não aparecem para quem joga aqui.'
            : 'Este servidor mostra as regras da REDE. Para editar o texto, abra o escopo Rede.'}
        </p>

        {mode === 'own' && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCopy}>
            <Copy className="h-3.5 w-3.5" />
            Copiar as seções da rede
          </Button>
        )}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------
//  A COLUNA DE SEÇÕES — a mesma do jogo
// ------------------------------------------------------------

function SectionColumn({
  sections,
  activeId,
  editable,
  busy,
  onPick,
  onMove,
  onCreate,
  onTemplate,
}: {
  readonly sections: readonly RuleSection[];
  readonly activeId: number | null;
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onPick: (id: number) => void;
  readonly onMove: (id: number, delta: number) => void;
  readonly onCreate: (title: string) => void;
  readonly onTemplate: () => void;
}) {
  const [title, setTitle] = useState('');

  return (
    <Section title="Seções" contentClassName="p-0">
      <ul className="divide-y divide-border">
        {sections.map((section, index) => (
          <li key={section.id} className="flex items-center gap-1 pr-1">
            <button
              type="button"
              onClick={() => {
                onPick(section.id);
              }}
              className={cn(
                'flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2 text-left',
                section.id === activeId ? 'bg-surface-2' : 'hover:bg-surface-2/60',
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn('h-4 w-[3px] shrink-0', section.id === activeId ? 'bg-rust' : 'bg-transparent')}
                />
                <span
                  className={cn(
                    'truncate font-condensed text-sm uppercase',
                    section.enabled ? 'text-foreground' : 'text-muted line-through',
                  )}
                >
                  {section.title}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted">{section.items.length}</span>
            </button>

            {editable && (
              <span className="flex shrink-0 flex-col">
                <button
                  type="button"
                  aria-label={`Subir ${section.title}`}
                  disabled={busy || index === 0}
                  onClick={() => {
                    onMove(section.id, -1);
                  }}
                  className="px-1 text-muted hover:text-foreground disabled:opacity-30"
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Descer ${section.title}`}
                  disabled={busy || index === sections.length - 1}
                  onClick={() => {
                    onMove(section.id, 1);
                  }}
                  className="px-1 text-muted hover:text-foreground disabled:opacity-30"
                >
                  <ArrowDown className="h-3 w-3" />
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {editable && (
        <div className="space-y-2 border-t border-border p-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();

              if (title.trim() === '') return;

              onCreate(title.trim());
              setTitle('');
            }}
          >
            <Input
              value={title}
              maxLength={60}
              placeholder="Nova seção"
              aria-label="Título da nova seção"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
            <Button type="submit" size="sm" disabled={busy || title.trim() === ''}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </form>

          {sections.length === 0 && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onTemplate}>
              <Sparkles className="h-3.5 w-3.5" />
              Começar pelo modelo
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------
//  AS REGRAS DE UMA SEÇÃO
// ------------------------------------------------------------

function RuleList({
  section,
  editable,
  busy,
  onRename,
  onEnabled,
  onDelete,
  onCreate,
  onUpdate,
  onRemove,
  onMove,
}: {
  readonly section: RuleSection;
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onRename: (title: string) => void;
  readonly onEnabled: (enabled: boolean) => void;
  readonly onDelete: () => void;
  readonly onCreate: (text: string, tone: RuleTone) => void;
  readonly onUpdate: (id: number, text: string, tone: RuleTone) => void;
  readonly onRemove: (id: number) => void;
  readonly onMove: (id: number, delta: number) => void;
}) {
  const [title, setTitle] = useState(section.title);
  const [text, setText] = useState('');
  const [tone, setTone] = useState<RuleTone>('normal');

  // A seção trocou debaixo do formulário: o título aberto tem de
  // acompanhar, senão o campo renomearia a outra.
  useEffect(() => {
    setTitle(section.title);
  }, [section.id, section.title]);

  return (
    <Section
      title={section.title}
      aside={
        editable && (
          <div className="flex items-center gap-2">
            <Toggle
              on={section.enabled}
              busy={busy}
              label="A seção aparece no jogo"
              labels={['No jogo', 'Escondida']}
              onChange={onEnabled}
            />
            <ConfirmButton
              variant="danger"
              disabled={busy}
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Apagar"
              confirmLabel="Apagar mesmo"
              hint={`As ${String(section.items.length)} regra(s) desta seção vão junto.`}
              onConfirm={onDelete}
            />
          </div>
        )
      }
    >
      {editable && (
        <form
          className="mb-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();

            if (title.trim() === '' || title.trim() === section.title) return;

            onRename(title.trim());
          }}
        >
          <Input
            value={title}
            maxLength={60}
            aria-label="Título da seção"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <Button type="submit" size="sm" variant="ghost" disabled={busy || title.trim() === section.title}>
            Renomear
          </Button>
        </form>
      )}

      {section.items.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Sem regras nesta seção"
          detail={editable ? 'Escreva a primeira abaixo.' : 'Nada publicado aqui ainda.'}
        />
      ) : (
        <ol className="space-y-2">
          {section.items.map((item, index) => (
            <RuleRow
              key={item.id}
              index={index}
              total={section.items.length}
              text={item.text}
              tone={item.tone}
              editable={editable}
              busy={busy}
              onSave={(value, nextTone) => {
                onUpdate(item.id, value, nextTone);
              }}
              onRemove={() => {
                onRemove(item.id);
              }}
              onMove={(delta) => {
                onMove(item.id, delta);
              }}
            />
          ))}
        </ol>
      )}

      {editable && (
        <form
          className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3"
          onSubmit={(event) => {
            event.preventDefault();

            if (text.trim() === '') return;

            onCreate(text.trim(), tone);
            setText('');
            setTone('normal');
          }}
        >
          <Input
            value={text}
            maxLength={300}
            placeholder="Nova regra — o texto que o jogador vai ler"
            aria-label="Texto da nova regra"
            className="min-w-[240px] flex-1"
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
          <ToneSelect
            value={tone}
            onChange={setTone}
            label="Tom da nova regra"
          />
          <Button type="submit" size="sm" disabled={busy || text.trim() === ''}>
            <Plus className="h-3.5 w-3.5" />
            Acrescentar
          </Button>
        </form>
      )}

      <p className="mt-3 flex items-center gap-2 text-xs text-muted">
        <FileText className="h-3.5 w-3.5 shrink-0" />O jogo quebra a página sozinho: cabe o que
        couber na caixa, e o resto vira a página seguinte.
      </p>
    </Section>
  );
}

function RuleRow({
  index,
  total,
  text,
  tone,
  editable,
  busy,
  onSave,
  onRemove,
  onMove,
}: {
  readonly index: number;
  readonly total: number;
  readonly text: string;
  readonly tone: RuleTone;
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onSave: (text: string, tone: RuleTone) => void;
  readonly onRemove: () => void;
  readonly onMove: (delta: number) => void;
}) {
  const [draft, setDraft] = useState(text);
  const [draftTone, setDraftTone] = useState<RuleTone>(tone);

  useEffect(() => {
    setDraft(text);
    setDraftTone(tone);
  }, [text, tone]);

  const dirty = draft !== text || draftTone !== tone;

  return (
    <li className="flex flex-wrap items-center gap-2">
      <span aria-hidden="true" className={cn('h-8 w-[3px] shrink-0', TONE_COLOR[draftTone])} />
      <span className="w-6 shrink-0 text-right text-xs text-muted">{index + 1}.</span>

      {editable ? (
        <>
          <Input
            value={draft}
            maxLength={300}
            aria-label={`Regra ${String(index + 1)}`}
            className="min-w-[240px] flex-1"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <ToneSelect
            value={draftTone}
            onChange={setDraftTone}
            label={`Tom da regra ${String(index + 1)}`}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !dirty || draft.trim() === ''}
            onClick={() => {
              onSave(draft.trim(), draftTone);
            }}
          >
            Salvar
          </Button>
          <span className="flex flex-col">
            <button
              type="button"
              aria-label={`Subir a regra ${String(index + 1)}`}
              disabled={busy || index === 0}
              onClick={() => {
                onMove(-1);
              }}
              className="px-1 text-muted hover:text-foreground disabled:opacity-30"
            >
              <ArrowUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label={`Descer a regra ${String(index + 1)}`}
              disabled={busy || index === total - 1}
              onClick={() => {
                onMove(1);
              }}
              className="px-1 text-muted hover:text-foreground disabled:opacity-30"
            >
              <ArrowDown className="h-3 w-3" />
            </button>
          </span>
          <ConfirmButton
            variant="danger"
            disabled={busy}
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="Apagar"
            confirmLabel="Apagar mesmo"
            hint="A regra sai da tela do jogo no clique seguinte."
            onConfirm={onRemove}
          />
        </>
      ) : (
        <p className="flex-1 text-sm text-foreground">{text}</p>
      )}
    </li>
  );
}

function ToneSelect({
  value,
  onChange,
  label,
}: {
  readonly value: RuleTone;
  readonly onChange: (value: RuleTone) => void;
  readonly label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => {
        onChange(event.target.value as RuleTone);
      }}
      className="h-9 shrink-0 border border-border bg-surface-2 px-2 text-sm text-foreground"
    >
      {TONES.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
}
