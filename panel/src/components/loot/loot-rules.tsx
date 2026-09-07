'use client';

// ============================================================
//  loot-rules.tsx  -  a lista: o que a casa acrescenta ao loot.
//
//  ####  A CHANCE APARECE TRADUZIDA, E NÃO CRUA  ####
//
//  "0,0002" numa coluna não diz nada; "1 em 5.000 · ≈ 2 por
//  semana" diz. A tradução usa a MESMA suposição de caixas por dia
//  do formulário, e o campo que a muda fica em cima da tabela —
//  mexer nele move a coluna inteira, que é como se compara uma
//  regra com a outra.
//
//  ####  E A REGRA EM MEDIÇÃO PRECISA GRITAR  ####
//
//  Ela não cria item nenhum. Uma etiqueta discreta faria o admin
//  ligar a regra, esperar uma semana e concluir que o loot não
//  funciona — por isso a coluna da chance dela começa com
//  "TERIA", e a linha carrega a etiqueta em âmbar.
// ============================================================

import { BarChart3, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { describeChance } from '@/components/loot/chance';
import { ContainersPerDayInput } from '@/components/loot/chance-explainer';
import { labelOfName } from '@/components/loot/containers';
import { describeAmount, describeLimits, ruleToInput } from '@/components/loot/rule-form';
import { CustomItemIcon } from '@/components/item-icon';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { agent, type LootRule } from '@/lib/api';
import { EM_DASH } from '@/lib/format';
import { useCustomItems } from '@/lib/hooks/use-custom-items';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** Quantos contêineres a coluna mostra antes de resumir. */
const CONTAINER_CHIPS = 3;

interface LootRulesProps {
  readonly rules: readonly LootRule[];
  readonly error: string | null;
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly containersPerDay: number;
  readonly onContainersPerDayChange: (value: number) => void;
  readonly onCreate: () => void;
  readonly onEdit: (rule: LootRule) => void;
  readonly onStats: (rule: LootRule) => void;
  readonly onChanged: () => void;
}

export function LootRules({
  rules,
  error,
  servers,
  containersPerDay,
  onContainersPerDayChange,
  onCreate,
  onEdit,
  onStats,
  onChanged,
}: LootRulesProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const { items: customItems } = useCustomItems();

  const serverName = (id: string): string =>
    servers.find((server) => server.id === id)?.name ?? id;

  const toggle = async (rule: LootRule): Promise<void> => {
    setBusy(rule.id);

    try {
      // O PUT reescreve a regra inteira — é a regra da rota, e não
      // um PATCH que a API não tem.
      await agent.updateLootRule(rule.id, { ...ruleToInput(rule), enabled: !rule.enabled });

      toast.success(rule.enabled ? `"${rule.label}" desligada` : `"${rule.label}" ligada`);
      onChanged();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (rule: LootRule): Promise<void> => {
    setBusy(rule.id);

    try {
      await agent.removeLootRule(rule.id);
      toast.success(`"${rule.label}" apagada.`);
      onChanged();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-2xs leading-relaxed text-muted">
          Cada linha <strong>acrescenta</strong> um item nosso a contêineres escolhidos. O jogo
          continua enchendo a caixa como sempre — nada aqui tira nem substitui o loot dele, e
          desligar a regra devolve tudo ao normal.
        </p>

        <Button variant="primary" onClick={onCreate}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          Nova regra
        </Button>
      </div>

      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler as regras" detail={error} />
      )}

      {rules.length === 0 && error === null && (
        <StateBlock
          variant="empty"
          title="Nenhuma regra de loot"
          detail="Nada é acrescentado ao loot hoje. Uma regra nova nasce só medindo: ela conta quantas vezes teria disparado, sem criar item nenhum, até você mandar valer."
        />
      )}

      {rules.length > 0 && (
        <>
          <ContainersPerDayInput
            id="loot-list-per-day"
            value={containersPerDay}
            onChange={onContainersPerDayChange}
          />

          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>Regra</HeaderCell>
                  <HeaderCell>Item</HeaderCell>
                  <HeaderCell>Onde</HeaderCell>
                  <HeaderCell>Com que frequência</HeaderCell>
                  <HeaderCell>Freios</HeaderCell>
                  <HeaderCell>Servidores</HeaderCell>
                  <HeaderCell className="text-right">
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {rules.map((rule) => {
                  const item = customItems.find((entry) => entry.id === rule.customItemId) ?? null;
                  const limits = describeLimits(rule);
                  const measuring = rule.mode === 'measuring';

                  return (
                    <tr key={rule.id} className={cn('hover:bg-surface-2', !rule.enabled && 'opacity-60')}>
                      <td className="px-3 py-2 align-top">
                        <span className="text-foreground">{rule.label}</span>

                        {measuring && (
                          <span
                            className="ml-2 border border-amber px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-amber"
                            title="Em medição a regra é sorteada e CONTADA, e não cria item nenhum. É assim que se descobre a chance certa antes de soltar."
                          >
                            só medindo
                          </span>
                        )}

                        {!rule.enabled && (
                          <span
                            className="ml-2 border border-muted px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
                            title="Desligada não é apagada: a regra fica no cadastro e para de ser sorteada."
                          >
                            desligada
                          </span>
                        )}

                        <span className="block font-mono text-2xs text-muted">{rule.id}</span>
                      </td>

                      <td className="px-3 py-2 align-top">
                        {item === null ? (
                          // O item pode ter sido apagado do cadastro
                          // por fora. Mostrar o id cru é melhor que um
                          // travessão: é o que permite achar o que
                          // sumiu.
                          <span className="text-2xs text-amber" title="Nenhum item nosso com este id. A regra não tem o que criar.">
                            item não encontrado ({rule.customItemId})
                          </span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <CustomItemIcon
                              iconFile={item.iconFile}
                              baseShortname={item.baseShortname}
                              size="sm"
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-foreground">
                                {item.displayName}
                              </span>
                              <span className="block text-2xs text-muted">
                                {describeAmount(rule.amountMin, rule.amountMax)} por caixa
                              </span>
                            </span>
                          </span>
                        )}
                      </td>

                      <td className="px-3 py-2 align-top">
                        {rule.containers.length === 0 ? (
                          <span className="text-2xs text-amber" title="Sem contêiner, a regra nunca dispara.">
                            nenhum contêiner
                          </span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {rule.containers.slice(0, CONTAINER_CHIPS).map((name) => (
                              <span
                                key={name}
                                title={name}
                                className="border border-border px-1.5 py-0.5 text-2xs text-muted"
                              >
                                {labelOfName(name)}
                              </span>
                            ))}

                            {rule.containers.length > CONTAINER_CHIPS && (
                              <span
                                className="border border-border px-1.5 py-0.5 text-2xs text-muted"
                                title={rule.containers.slice(CONTAINER_CHIPS).join(', ')}
                              >
                                +{String(rule.containers.length - CONTAINER_CHIPS)}
                              </span>
                            )}
                          </span>
                        )}
                      </td>

                      <td className="px-3 py-2 align-top text-2xs">
                        <span className={measuring ? 'text-muted' : 'text-foreground'}>
                          {measuring && <span className="text-amber">teria: </span>}
                          {describeChance({
                            chance: rule.chance,
                            containersPerDay,
                            dailyCap: rule.dailyCap,
                          })}
                        </span>
                      </td>

                      <td className="px-3 py-2 align-top text-2xs text-muted">
                        {limits.length === 0 ? (
                          <span title="Sem teto e sem carência: a emissão acompanha quanto se joga.">
                            sem freio
                          </span>
                        ) : (
                          limits.map((line) => (
                            <span key={line} className="block">
                              {line}
                            </span>
                          ))
                        )}
                      </td>

                      <td className="px-3 py-2 align-top text-2xs text-muted">
                        {rule.servers.length === 0 ? (
                          <span className="text-amber" title="Sem servidor nenhum, a regra existe no cadastro e não vale em lugar algum.">
                            nenhum
                          </span>
                        ) : (
                          rule.servers.map((id) => (
                            <span key={id} className="block">
                              {serverName(id)}
                            </span>
                          ))
                        )}
                      </td>

                      <td className="px-3 py-2 text-right align-top">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === rule.id}
                            onClick={() => onStats(rule)}
                          >
                            <BarChart3 aria-hidden="true" className="h-4 w-4" />
                            Contagem
                          </Button>

                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === rule.id}
                            onClick={() => onEdit(rule)}
                          >
                            Editar
                          </Button>

                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === rule.id}
                            onClick={() => void toggle(rule)}
                          >
                            {rule.enabled ? 'Desligar' : 'Ligar'}
                          </Button>

                          <ConfirmButton
                            variant="danger"
                            disabled={busy === rule.id}
                            icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
                            label="Apagar"
                            confirmLabel="Apagar mesmo"
                            hint="Some do cadastro, e a contagem por dia dela vai junto. Para só parar de sortear, use Desligar."
                            onConfirm={() => void remove(rule)}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="text-2xs leading-relaxed text-muted">
        Salvar uma regra <strong>não mexe nos contêineres que já existem no mapa</strong>. Ela vale
        para o que nascer e para o que refizer o loot — o que, na maioria dos contêineres, é de uma
        a duas horas; nos outros, só no wipe seguinte.
      </p>

      {rules.length > 0 && customItems.length === 0 && (
        <p className="text-2xs text-muted">
          {EM_DASH} os itens nossos ainda não chegaram: a coluna do item aparece pelo id até a
          lista de cadastro responder.
        </p>
      )}
    </div>
  );
}

function HeaderCell({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-left font-condensed text-2xs font-bold uppercase tracking-wide text-muted',
        className,
      )}
    >
      {children}
    </th>
  );
}
