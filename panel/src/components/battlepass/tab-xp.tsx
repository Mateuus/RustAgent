'use client';

// ============================================================
//  tab-xp.tsx  -  "o que vai dar XP o administrador vai
//  administrar isso" (o dono, 17/09/2026).
//
//  Cada linha é uma FONTE, com quatro campos: ligada, quanto vale
//  cada ocorrência, o teto diário DELA, e o rótulo que o jogador
//  lê. O teto é por fonte e não um teto único somando tudo — é o
//  que deixa a missão generosa e o farm contido sem escolher entre
//  as duas coisas (01 §3).
//
//  ####  O CARDÁPIO VEM DO AGENTE  ####
//
//  E não de uma lista escrita aqui. É a exigência do 05 §3, e o
//  motivo é direto: com uma constante no painel, o admin configura
//  XP por "saquear caixa", o agente não mede aquilo, e NADA
//  ACONTECE — em silêncio, sem erro, sem aviso.
//
//  Quem serve o cardápio é a frente B. Enquanto ela não entra, esta
//  aba mostra o que já foi gravado, diz na tela que o agente desta
//  versão não tem a lista, e NÃO oferece um campo de texto livre
//  para inventar fonte. A recusa aparece; ela não é escondida.
//
//  ####  E ELA AVISA SOBRE AS FONTES COM PEGADINHA  ####
//
//  `sleeper.kills` paga quem anda de machado por base vazia;
//  `gather.*` morre em silêncio se o ranking correspondente for
//  desligado. São `HelpTip` ao lado do nome — nota de rodapé
//  ninguém lê, e a reclamação chega antes.
// ============================================================

import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  buildXpRows,
  messageOf,
  periodLabel,
  safeXpRules,
  safeXpSources,
  type XpRow,
} from '@/components/battlepass/normalize';
import { SeasonPicker } from '@/components/battlepass/season-picker';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { INPUT } from '@/components/ui/field';
import { HelpTip } from '@/components/ui/help-tip';
import { Toggle } from '@/components/ui/toggle';
import { BATTLEPASS_HELP, caveatTopic } from '@/lib/help/battlepass';
import {
  agent,
  type BattlePassSeason,
  type BattlePassXpRule,
  type BattlePassXpRuleInput,
  type BattlePassXpSource,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export function TabXp({
  seasons,
  season,
  onPickSeason,
}: {
  readonly seasons: readonly BattlePassSeason[];
  readonly season: BattlePassSeason | null;
  readonly onPickSeason: (seasonId: number) => void;
}) {
  const [rules, setRules] = useState<readonly BattlePassXpRule[] | null>(null);
  const [sources, setSources] = useState<readonly BattlePassXpSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const seasonId = season?.id ?? null;

  const load = useCallback(async () => {
    if (seasonId === null) {
      setRules(null);
      setLoading(false);

      return;
    }

    setLoading(true);

    try {
      // Essencial: sem as regras não há o que editar nesta aba.
      setRules(safeXpRules((await agent.battlePassXpRules(seasonId)).rules));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
      setRules(null);
    }

    try {
      // Secundário: sem o cardápio ainda dá para mexer no que já
      // existe. O que some é a possibilidade de LIGAR uma fonte
      // nova — e a tela diz isso, em vez de oferecer um campo livre.
      setSources(safeXpSources((await agent.battlePassXpSources()).sources));
      setCatalogError(null);
    } catch (cause) {
      setSources(null);
      setCatalogError(messageOf(cause));
    }

    setLoading(false);
  }, [seasonId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(source: string, body: BattlePassXpRuleInput): Promise<void> {
    if (seasonId === null) return;

    setBusy(true);

    try {
      await agent.setBattlePassXpRule(seasonId, source, body);
      toast.success(`Fonte "${source}" salva`);
      await load();
    } catch (cause) {
      toast.error('Não consegui salvar a fonte', { description: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(source: string): Promise<void> {
    if (seasonId === null) return;

    setBusy(true);

    try {
      await agent.removeBattlePassXpRule(seasonId, source);
      toast.success(`Fonte "${source}" tirada desta temporada`);
      await load();
    } catch (cause) {
      toast.error('Não consegui tirar a fonte', { description: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  const rows = buildXpRows(sources ?? [], rules ?? []);

  return (
    <div className="space-y-4">
      <SeasonPicker seasons={seasons} value={seasonId} busy={busy} onChange={onPickSeason} />

      {season !== null && (
        <Section
          title={`O que dá XP · ${periodLabel(season.period)}`}
          aside={<HelpTip topic={BATTLEPASS_HELP.catalog} />}
          contentClassName="p-0"
        >
          {error !== null && (
            <div className="p-3">
              <StateBlock variant="error" title="Não consegui ler as regras de XP." detail={error} />
            </div>
          )}

          {catalogError !== null && (
            <div className="p-3">
              <StateBlock
                variant="error"
                title="Este agente não me deu o cardápio de fontes."
                detail={
                  <>
                    {catalogError} A lista do que dá XP vem do agente, e não deste painel: sem ela,
                    só dá para mexer nas fontes que já estão gravadas abaixo. Oferecer um campo de
                    texto livre aqui deixaria configurar XP por algo que ninguém mede — e nada
                    aconteceria, em silêncio.
                  </>
                }
              />
            </div>
          )}

          {loading && rules === null && error === null && (
            <div className="p-3">
              <StateBlock variant="loading" title="Lendo as fontes…" />
            </div>
          )}

          {rules !== null && rows.length === 0 && (
            <div className="p-3">
              <StateBlock
                variant="empty"
                title="Nenhuma fonte configurada, e nenhuma oferecida."
                detail="Sem fonte ligada ninguém ganha XP, e a trilha fica parada no nível 1 o mês inteiro."
              />
            </div>
          )}

          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[60rem] text-left text-xs">
                <thead className="border-b border-border font-condensed text-2xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2">Fonte</th>
                    <th className="w-36 px-3 py-2">Ligada</th>
                    <th className="w-28 px-3 py-2">XP por vez</th>
                    <th className="w-32 px-3 py-2">
                      <span className="inline-flex items-center gap-1">
                        Teto diário
                        <HelpTip topic={BATTLEPASS_HELP.dailyCap} />
                      </span>
                    </th>
                    <th className="w-40 px-3 py-2">Rótulo</th>
                    <th className="w-32 px-3 py-2 text-right">O que fazer</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row) => (
                    <RuleRow
                      // A chave leva o `updatedAt`: gravou, a linha
                      // renasce com o que o agente devolveu, e o
                      // rascunho local não fica por cima da verdade.
                      key={`${row.source}:${row.rule?.updatedAt ?? 'novo'}`}
                      row={row}
                      busy={busy}
                      onSave={(body) => void save(row.source, body)}
                      onRemove={() => void remove(row.source)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

/**
 * Uma linha, com rascunho próprio.
 *
 * O botão de salvar só aparece quando algo mudou: numa tabela de
 * vinte fontes, vinte botões acesos não dizem nada sobre qual delas
 * está esperando gravação.
 */
function RuleRow({
  row,
  busy,
  onSave,
  onRemove,
}: {
  readonly row: XpRow;
  readonly busy: boolean;
  readonly onSave: (body: BattlePassXpRuleInput) => void;
  readonly onRemove: () => void;
}) {
  const saved = row.rule;
  const [enabled, setEnabled] = useState(saved?.enabled === true);
  const [amount, setAmount] = useState(String(saved?.amount ?? 0));
  // Vazio é "sem teto", que é o que o contrato chama de `null`. Um
  // zero aqui fecharia a torneira sem ninguém ter pedido.
  const [dailyCap, setDailyCap] = useState(
    saved === null || saved.dailyCap === null ? '' : String(saved.dailyCap),
  );
  const [label, setLabel] = useState(saved?.label ?? '');

  const body: BattlePassXpRuleInput = {
    enabled,
    amount: Number(amount === '' ? 0 : amount),
    dailyCap: dailyCap.trim() === '' ? null : Number(dailyCap),
    label: label.trim() === '' ? null : label.trim(),
  };

  const dirty =
    row.rule === null ||
    row.rule.enabled !== body.enabled ||
    row.rule.amount !== body.amount ||
    row.rule.dailyCap !== body.dailyCap ||
    row.rule.label !== body.label;

  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
            {row.label}
          </span>

          {row.warning !== null && <HelpTip topic={caveatTopic(row.label, row.warning)} />}

          {row.recommended && (
            <span className="border border-olive px-1 text-2xs uppercase text-foreground">
              recomendada
            </span>
          )}

          {row.orphan && (
            <span className="border border-amber px-1 text-2xs uppercase text-foreground">
              fora do cardápio
            </span>
          )}
        </div>

        <p className="font-mono text-2xs text-muted">{row.source}</p>

        {row.hint !== null && <p className="mt-0.5 text-2xs text-muted">{row.hint}</p>}

        {row.orphan && (
          <p className="mt-0.5 text-2xs text-muted">
            Este agente não oferece mais esta fonte: ela pode ter sido renomeada, e então não mede
            mais nada. A regra continua gravada até alguém tirá-la.
          </p>
        )}
      </td>

      <td className="px-3 py-2">
        <Toggle
          on={enabled}
          busy={busy}
          label={`Fonte ${row.label}`}
          labels={['Ligada', 'Desligada']}
          onChange={setEnabled}
        />
      </td>

      <td className="px-3 py-2">
        <input
          type="number"
          min={0}
          aria-label={`XP por ocorrência de ${row.label}`}
          className={INPUT}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </td>

      <td className="px-3 py-2">
        <input
          type="number"
          min={1}
          aria-label={`Teto diário de ${row.label}`}
          placeholder="sem teto"
          className={INPUT}
          value={dailyCap}
          onChange={(event) => setDailyCap(event.target.value)}
        />
      </td>

      <td className="px-3 py-2">
        <input
          aria-label={`Rótulo de ${row.label}`}
          placeholder={row.label}
          maxLength={60}
          className={INPUT}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </td>

      <td className="px-3 py-2">
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !dirty}
            className={cn(!dirty && 'invisible')}
            onClick={() => onSave(body)}
          >
            Salvar
          </Button>

          {row.rule !== null && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Tirar a fonte ${row.label} desta temporada`}
              disabled={busy}
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
