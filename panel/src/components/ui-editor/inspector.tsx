'use client';

// ============================================================
//  inspector.tsx  -  as propriedades do elemento selecionado.
//
//  ####  TROCAR A ÂNCORA NÃO PODE MOVER O ELEMENTO  ####
//
//  A âncora é uma DECISÃO de layout ("este botão gruda no canto
//  inferior direito"); o offset é o ajuste fino. Trocar uma sem
//  recalcular o outro faria a caixa saltar na tela, e quem clicou
//  em "Base dir." concluiria que o editor está quebrado.
//
//  Quem resolve isso é `reanchor`, em lib/ui-doc/geometry.ts.
//
//  ####  A COR É HEX PORQUE O NAVEGADOR FALA HEX  ####
//
//  O `<input type="color">` devolve `#RRGGBB` e não conhece alfa,
//  então o alfa tem um controle próprio ao lado. Ver
//  lib/ui-doc/color.ts para por que o modelo não guarda o formato
//  do jogo.
// ============================================================

import { Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { ItemCombobox } from '@/components/item-combobox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatHexColor, parseHexColor } from '@/lib/ui-doc/color';
import { createAction } from '@/lib/ui-doc/factory';
import { ANCHOR_PRESETS, matchAnchorPreset, reanchor, REFERENCE_SIZE } from '@/lib/ui-doc/geometry';
import {
  UI_ACTION_KINDS,
  UI_FONTS,
  UI_IMAGE_TYPES,
  UI_TEXT_ALIGNS,
  type UiElement,
  type UiScreen,
} from '@/lib/ui-doc/model';
import { MATERIAL_OPTIONS, SPRITE_OPTIONS } from '@/lib/ui-doc/sprites';
import { cn } from '@/lib/utils';

export interface InspectorProps {
  readonly element: UiElement | null;
  /** As telas do documento, para as ações de navegação. */
  readonly screens: readonly UiScreen[];
  readonly onChange: (element: UiElement) => void;
  readonly onRemove: () => void;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="block font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
      {hint !== undefined && <span className="block text-2xs text-muted">{hint}</span>}
    </label>
  );
}

function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="w-full border border-border bg-surface-2 px-2 py-1.5 text-sm text-foreground"
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

/**
 * Cor + alfa.
 *
 * O seletor nativo não tem alfa, e o alfa é o que faz um véu ser
 * véu — sem ele, o desfoque do painel de fundo nem aparece.
 */
function ColorField({
  label,
  value,
  onChange,
  nullable = false,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  nullable?: boolean;
}) {
  const parsed = parseHexColor(value ?? '') ?? { r: 0, g: 0, b: 0, a: 255 };
  const rgb = `#${[parsed.r, parsed.g, parsed.b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;

  return (
    <Field label={label}>
      <span className="flex items-center gap-2">
        <input
          type="color"
          value={rgb}
          onChange={(event) => {
            const next = parseHexColor(event.target.value);

            if (next !== null) {
              onChange(formatHexColor({ ...next, a: parsed.a }));
            }
          }}
          className="h-8 w-10 shrink-0 border border-border bg-surface-2"
          disabled={value === null}
          aria-label={`Cor de ${label}`}
        />

        <Input
          value={value ?? ''}
          placeholder={nullable ? 'sem cor' : '#RRGGBBAA'}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          className="font-mono text-2xs"
        />

        <input
          type="range"
          min={0}
          max={255}
          value={parsed.a}
          disabled={value === null}
          aria-label={`Opacidade de ${label}`}
          onChange={(event) =>
            onChange(formatHexColor({ ...parsed, a: Number(event.target.value) }))
          }
          className="w-16 shrink-0"
        />

        {nullable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(value === null ? '#FFFFFFFF' : null)}
            title={value === null ? 'Definir uma cor' : 'Voltar a não ter cor'}
          >
            {value === null ? '+' : '×'}
          </Button>
        )}
      </span>
    </Field>
  );
}

function NumberField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  hint?: string;
}) {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      <Input
        type="number"
        value={String(value)}
        onChange={(event) => {
          const next = Number(event.target.value);

          // NaN vira o valor anterior: um campo em branco no meio
          // da digitação não pode empurrar `NaN` para o modelo, que
          // é onde ele viraria uma âncora inválida no jogo.
          onChange(Number.isFinite(next) ? next : value);
        }}
        className="text-sm"
      />
    </Field>
  );
}

export function Inspector({ element, screens, onChange, onRemove }: InspectorProps) {
  /**
   * O shortname do item escolhido, SÓ para desenhar o ícone.
   *
   * Ele não entra no modelo: o que o CUI entende é o `itemId`, e
   * guardar o nome junto seria uma segunda fonte para a mesma
   * coisa — que divergiria no dia em que a Facepunch renomeasse um
   * item. Some ao trocar de elemento, e é o certo: o ícone volta a
   * aparecer na primeira busca.
   */
  const [itemPreview, setItemPreview] = useState('');

  useEffect(() => {
    setItemPreview('');
  }, [element?.id]);

  if (element === null) {
    return (
      <p className="p-3 text-2xs leading-relaxed text-muted">
        Selecione um elemento na árvore, ou clique nele no desenho, para ver as propriedades.
      </p>
    );
  }

  const rect = element.rect;
  const preset = matchAnchorPreset(rect);

  const patch = (changes: Partial<UiElement>): void => {
    onChange({ ...element, ...changes } as UiElement);
  };

  return (
    <div className="space-y-4 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-rust">
          {element.type}
        </span>
        <Button size="sm" variant="ghost" onClick={onRemove} title="Remover este elemento">
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>

      <Field label="Nome" hint="Só na árvore do editor. Não vai para o jogo.">
        <Input value={element.name} onChange={(event) => patch({ name: event.target.value })} />
      </Field>

      <Field
        label="Identificador"
        hint="É o endereço que o plugin usa, e o que a lista de escondidos por servidor mostra."
      >
        <Input value={element.id} readOnly className="font-mono text-2xs text-muted" />
      </Field>

      {/* ---- Posição ---- */}
      <div className="space-y-2 border-t border-border pt-3">
        <span className="block font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
          Âncora
        </span>

        <div className="grid grid-cols-4 gap-1">
          {ANCHOR_PRESETS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={preset?.id === option.id}
              title={`Ancorar em ${option.label} sem mover o elemento`}
              onClick={() =>
                patch({
                  rect: reanchor(rect, option.anchorMin, option.anchorMax, REFERENCE_SIZE),
                })
              }
              className={cn(
                'border px-1 py-1 font-condensed text-2xs font-bold uppercase tracking-wide',
                preset?.id === option.id
                  ? 'border-rust bg-surface-2 text-foreground'
                  : 'border-border text-muted hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Esq. (px)"
            value={rect.offsetMin.x}
            onChange={(x) => patch({ rect: { ...rect, offsetMin: { ...rect.offsetMin, x } } })}
          />
          <NumberField
            label="Dir. (px)"
            value={rect.offsetMax.x}
            onChange={(x) => patch({ rect: { ...rect, offsetMax: { ...rect.offsetMax, x } } })}
          />
          {/* No Unity o Y cresce para CIMA: `offsetMin.y` é a
              distância do FUNDO e `offsetMax.y` a do topo, com
              sinal invertido. Os rótulos dizem isso para ninguém
              procurar um "top" que não existe. */}
          <NumberField
            label="Base (px)"
            value={rect.offsetMin.y}
            onChange={(y) => patch({ rect: { ...rect, offsetMin: { ...rect.offsetMin, y } } })}
          />
          <NumberField
            label="Topo (px)"
            value={rect.offsetMax.y}
            onChange={(y) => patch({ rect: { ...rect, offsetMax: { ...rect.offsetMax, y } } })}
          />
        </div>
      </div>

      {/* ---- Por tipo ---- */}
      {element.type === 'panel' && (
        <div className="space-y-3 border-t border-border pt-3">
          <ColorField
            label="Cor"
            value={element.color}
            onChange={(color) => patch({ color: color ?? '#00000000' })}
          />

          <Field label="Sprite">
            <select
              value={element.sprite ?? ''}
              onChange={(event) =>
                patch({ sprite: event.target.value === '' ? null : event.target.value })
              }
              className="w-full border border-border bg-surface-2 px-2 py-1.5 text-sm text-foreground"
            >
              <option value="">nenhum (cor lisa)</option>
              {SPRITE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          {element.sprite !== null && (
            <Field label="Preenchimento">
              <Select
                value={element.imageType}
                options={UI_IMAGE_TYPES}
                onChange={(imageType) => patch({ imageType })}
              />
            </Field>
          )}

          <Field
            label="Material"
            hint="O desfoque só aparece com a cor abaixo de 100% de opacidade."
          >
            <select
              value={element.material ?? ''}
              onChange={(event) =>
                patch({ material: event.target.value === '' ? null : event.target.value })
              }
              className="w-full border border-border bg-surface-2 px-2 py-1.5 text-sm text-foreground"
            >
              <option value="">nenhum</option>
              {MATERIAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {element.type === 'label' && (
        <div className="space-y-3 border-t border-border pt-3">
          <Field label="Texto">
            <textarea
              value={element.text}
              onChange={(event) => patch({ text: event.target.value })}
              rows={3}
              className="w-full border border-border bg-surface-2 px-2 py-1.5 text-sm text-foreground"
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Tamanho"
              value={element.fontSize}
              onChange={(fontSize) => patch({ fontSize: Math.max(1, Math.round(fontSize)) })}
            />
            <Field label="Alinhamento">
              <Select
                value={element.align}
                options={UI_TEXT_ALIGNS}
                onChange={(align) => patch({ align })}
              />
            </Field>
          </div>

          <Field label="Fonte">
            <Select value={element.font} options={UI_FONTS} onChange={(font) => patch({ font })} />
          </Field>

          <ColorField
            label="Cor"
            value={element.color}
            onChange={(color) => patch({ color: color ?? '#FFFFFFFF' })}
          />
        </div>
      )}

      {element.type === 'button' && (
        <div className="space-y-3 border-t border-border pt-3">
          <Field label="Texto">
            <Input value={element.text} onChange={(event) => patch({ text: event.target.value })} />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Tamanho"
              value={element.fontSize}
              onChange={(fontSize) => patch({ fontSize: Math.max(1, Math.round(fontSize)) })}
            />
            <Field label="Alinhamento">
              <Select
                value={element.align}
                options={UI_TEXT_ALIGNS}
                onChange={(align) => patch({ align })}
              />
            </Field>
          </div>

          <ColorField
            label="Fundo"
            value={element.color}
            onChange={(color) => patch({ color: color ?? '#00000000' })}
          />
          <ColorField
            label="Texto"
            value={element.textColor}
            onChange={(textColor) => patch({ textColor: textColor ?? '#FFFFFFFF' })}
          />
          <ColorField
            label="Sob o cursor"
            value={element.hoverColor}
            onChange={(hoverColor) => patch({ hoverColor })}
            nullable
          />
          <ColorField
            label="Pressionado"
            value={element.pressedColor}
            onChange={(pressedColor) => patch({ pressedColor })}
            nullable
          />

          {/* ---- A AÇÃO ---- */}
          <div className="space-y-2 border-t border-border pt-3">
            <span className="block font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
              O que ele faz
            </span>

            <p className="text-2xs leading-relaxed text-muted">
              O botão carrega um <strong>endereço</strong>, nunca a intenção: quem decide o que
              acontece é o servidor, lendo o que está salvo aqui.
            </p>

            <Field label="Ação">
              <Select
                value={element.action.kind}
                options={UI_ACTION_KINDS}
                onChange={(kind) => patch({ action: createAction(kind, screens[0]?.id ?? null) })}
              />
            </Field>

            {/* A ação vai para uma const antes do callback: dentro
                dele o TypeScript não estreita `element.action`, e
                espalhar o objeto de um `close` com `screenId`
                produziria uma ação que o agente recusa. */}
            {(() => {
              const action = element.action;

              if (action.kind === 'navigate' || action.kind === 'modal.open') {
                return (
                  <Field label="Para qual tela">
                    <select
                      value={action.screenId}
                      onChange={(event) =>
                        patch({ action: { ...action, screenId: event.target.value } })
                      }
                      className="w-full border border-border bg-surface-2 px-2 py-1.5 text-sm text-foreground"
                    >
                      <option value="">(escolha uma tela)</option>
                      {screens.map((screen) => (
                        <option key={screen.id} value={screen.id}>
                          {screen.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                );
              }

              if (action.kind === 'chat') {
                return (
                  <Field label="Comando" hint="Roda COMO O JOGADOR. É o que /tpa significa.">
                    <Input
                      value={action.command}
                      onChange={(event) =>
                        patch({ action: { ...action, command: event.target.value } })
                      }
                    />
                  </Field>
                );
              }

              if (action.kind === 'console') {
                return (
                  <Field
                    label="Comando"
                    hint="Roda com autoridade do SERVIDOR. {steamid} vira o SteamID de quem clicou."
                  >
                    <Input
                      value={action.command}
                      onChange={(event) =>
                        patch({ action: { ...action, command: event.target.value } })
                      }
                    />
                  </Field>
                );
              }

              return null;
            })()}

            {element.action.kind === 'store.buy' && (
              <p className="text-2xs leading-relaxed text-muted">
                A compra é servida pela loja do agente. O preço e o item vêm de lá — nunca do que o
                cliente manda.
              </p>
            )}
          </div>

          {/* ---- Estado ativo ---- */}
          <div className="space-y-2 border-t border-border pt-3">
            <span className="block font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
              Estado ativo
            </span>

            <p className="text-2xs leading-relaxed text-muted">
              &quot;Você está aqui&quot; na navegação. Só faz sentido num botão do cabeçalho, que
              não é redesenhado ao trocar de tela.
            </p>

            <Field label="Ativo na tela">
              <select
                value={element.activeOnScreenId ?? ''}
                onChange={(event) =>
                  patch({ activeOnScreenId: event.target.value === '' ? null : event.target.value })
                }
                className="w-full border border-border bg-surface-2 px-2 py-1.5 text-sm text-foreground"
              >
                <option value="">nenhuma</option>
                {screens.map((screen) => (
                  <option key={screen.id} value={screen.id}>
                    {screen.name}
                  </option>
                ))}
              </select>
            </Field>

            {element.activeOnScreenId !== null && (
              <>
                <ColorField
                  label="Fundo ativo"
                  value={element.activeColor}
                  onChange={(activeColor) => patch({ activeColor })}
                  nullable
                />
                <ColorField
                  label="Texto ativo"
                  value={element.activeTextColor}
                  onChange={(activeTextColor) => patch({ activeTextColor })}
                  nullable
                />
              </>
            )}
          </div>
        </div>
      )}

      {element.type === 'image' && (
        <div className="space-y-3 border-t border-border pt-3">
          <Field label="Origem">
            <Select
              value={element.source.kind}
              options={['sprite', 'url', 'item', 'stored'] as const}
              onChange={(kind) => {
                const source =
                  kind === 'sprite'
                    ? { kind: 'sprite' as const, sprite: SPRITE_OPTIONS[0]?.value ?? '' }
                    : kind === 'url'
                      ? { kind: 'url' as const, url: 'https://' }
                      : kind === 'item'
                        ? { kind: 'item' as const, itemId: 0, skinId: '0' }
                        : { kind: 'stored' as const, key: 'ozcoin' };

                patch({ source });
              }}
            />
          </Field>

          {element.source.kind === 'sprite' && (
            <Field label="Sprite do jogo">
              <select
                value={element.source.sprite}
                onChange={(event) =>
                  patch({ source: { kind: 'sprite', sprite: event.target.value } })
                }
                className="w-full border border-border bg-surface-2 px-2 py-1.5 text-sm text-foreground"
              >
                {SPRITE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {element.source.kind === 'url' && (
            <Field label="Endereço" hint="O CLIENTE baixa. Precisa ser alcançável por quem joga.">
              <Input
                value={element.source.url}
                onChange={(event) => patch({ source: { kind: 'url', url: event.target.value } })}
              />
            </Field>
          )}

          {element.source.kind === 'item' && (
            <div className="space-y-2">
              {/* ####  ESCOLHER PELO NOME, E NÃO PELO NÚMERO  ####

                  É para isto que o catálogo do agente existe: sem
                  ele, pôr o ícone de uma AK aqui exige decorar
                  `1545779598`. O `itemPreview` guarda o shortname só
                  para o ícone — o que vai para o jogo é o id, que é
                  o que o CUI entende. */}
              <Field label="Item" hint="Busca no catálogo do agente. Funciona com tudo parado.">
                <ItemCombobox
                  value={itemPreview}
                  onValueChange={setItemPreview}
                  onItemChange={(item) => {
                    if (item !== null) {
                      patch({ source: { kind: 'item', itemId: item.itemId, skinId: '0' } });
                    }
                  }}
                />
              </Field>

              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="itemId"
                  value={element.source.itemId}
                  hint="Preenchido pela busca acima."
                  onChange={(itemId) =>
                    patch({
                      source: {
                        kind: 'item',
                        itemId: Math.round(itemId),
                        skinId: element.source.kind === 'item' ? element.source.skinId : '0',
                      },
                    })
                  }
                />
                <Field label="skinId" hint="0 = o ícone padrão do item.">
                  <Input
                    value={element.source.skinId}
                    onChange={(event) =>
                      patch({
                        source: {
                          kind: 'item',
                          itemId: element.source.kind === 'item' ? element.source.itemId : 0,
                          skinId: event.target.value.replace(/\D/g, ''),
                        },
                      })
                    }
                    className="font-mono text-2xs"
                  />
                </Field>
              </div>
            </div>
          )}

          {element.source.kind === 'stored' && (
            <Field label="Chave" hint="O nome do PNG em Assets\ui, sem a extensão.">
              <Input
                value={element.source.key}
                onChange={(event) =>
                  patch({ source: { kind: 'stored', key: event.target.value.toLowerCase() } })
                }
                className="font-mono text-2xs"
              />
            </Field>
          )}

          <ColorField
            label="Tingimento"
            value={element.color}
            onChange={(color) => patch({ color: color ?? '#FFFFFFFF' })}
          />
        </div>
      )}
    </div>
  );
}
