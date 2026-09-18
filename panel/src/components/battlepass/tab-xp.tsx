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
//
//  ####  A LINHA QUE TIRA XP SE LÊ DE LONGE  ####
//
//  Desde 18/09/2026 o valor aceita negativo: `team.kills` a −200
//  DESCONTA 200 por colega abatido (o dono). Um sinal de menos num
//  campo numérico, no meio de vinte linhas, não é aviso nenhum — e
//  esta é justamente a linha que ninguém quer ligar por engano.
//
//  Então a linha inteira muda: selo PENALIDADE ao lado do nome,
//  borda de acento no campo, e a frase do `penaltyNoteOf` embaixo
//  dele, dizendo o que acontece e o que NÃO acontece (o XP para em
//  zero, o nível não desce). A marca acompanha o RASCUNHO, e não o
//  que está gravado: ela aparece enquanto o admin digita, que é o
//  momento em que ele ainda pode mudar de ideia.
//
//  A cor é borda e ícone, nunca texto colorido: `--rust-red` mede
//  3,74:1 sobre o fundo e não passa nos 4,5:1 de texto corrido
//  (globals.css).
// ============================================================

import { AlertTriangle, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  buildXpRows,
  messageOf,
  penaltyNoteOf,
  periodLabel,
  safeXpRules,
  safeXpSources,
  xpAmountKind,
  XP_AMOUNT_MAX,
  XP_AMOUNT_MIN,
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
                    <th className="w-28 px-3 py-2">
                      <span className="inline-flex items-center gap-1">
                        XP por vez
                        <HelpTip topic={BATTLEPASS_HELP.penalty} />
                      </span>
                    </th>
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

  // A marca segue o RASCUNHO: o admin vê a linha virar penalidade
  // enquanto digita o menos, e não depois de salvar.
  const penalty = xpAmountKind(body.amount) === 'penalty';
  const penaltyNote = penaltyNoteOf(body.amount);

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

          {penalty && (
            <span className="inline-flex items-center gap-1 border border-rust px-1 text-2xs uppercase text-foreground">
              <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0 text-rust" />
              penalidade
            </span>
          )}

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

        {penaltyNote !== null && (
          <p className="mt-1 flex items-start gap-1 border-l-2 border-rust bg-surface-2 px-2 py-1 text-2xs text-foreground">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0 text-rust" />
            <span>{penaltyNote}</span>
          </p>
        )}

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
        {row.feed === 'event' ? (
          // ####  QUEM DIZ QUANTO VALE É A MISSÃO  ####
          //
          // O agente ignora o `amount` desta fonte: o XP de uma
          // missão é o que a recompensa DELA promete, e é o número
          // que o jogador leu antes de aceitar. Oferecer o campo
          // aqui faria o admin digitar 800 esperando 800 — e nada
          // aconteceria, sem nada dizendo por quê.
          //
          // A linha continua existindo porque o resto dela vale: é
          // por aqui que a fonte liga, desliga e ganha teto diário.
          <span className="text-2xs text-text-muted">
            cada missão paga o seu — o valor fica na recompensa dela
          </span>
        ) : (
          <>
            <input
              type="number"
              // Negativo é PENALIDADE (o dono, 18/09/2026), e a faixa
              // é a MESMA do agente: um `min={0}` aqui recusaria na
              // tela o que o schema aceita, e o admin não teria onde
              // digitar a multa que ele acabou de pedir.
              min={XP_AMOUNT_MIN}
              max={XP_AMOUNT_MAX}
              aria-label={`XP por ocorrência de ${row.label}`}
              className={cn(INPUT, penalty && 'border-rust')}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />

            {penalty && (
              // A frase inteira mora na coluna da fonte, que tem
              // largura para ela; aqui cabe o verbo, e ele basta
              // para ler a COLUNA de cima a baixo e ver qual linha
              // tira em vez de dar.
              <p className="mt-1 font-condensed text-2xs uppercase tracking-wide text-foreground">
                tira XP
              </p>
            )}
          </>
        )}
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
