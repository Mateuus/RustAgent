'use client';

// ============================================================
//  custom-item-dialog.tsx  -  criar e editar um item nosso.
//
//  ####  O QUE ESTA CAIXA REALMENTE FAZ  ####
//
//  Ela não cria um item: ela MARCA um item do jogo. Um itemid que
//  o cliente do Rust não conhece é descartado por ele — foi medido
//  no binário —, então todo item nosso empresta o corpo de um item
//  que já existe, e o que o distingue é a marca: o par
//  `(item base, skin)`.
//
//  Ver Docs\CustomItem\01-PESQUISA-ITEM-CUSTOM.md §3.
//
//  ####  A SKIN É SORTEADA, E NUNCA É ZERO  ####
//
//  Zero é proibido por dois motivos independentes, e o segundo
//  derruba jogador do servidor — ver `newSkinId` abaixo. E ela é
//  sorteada em vez de digitada porque quem cadastra não tem skin
//  publicada nenhuma no primeiro dia: o número é a MARCA, e a arte
//  vem depois, pelo ícone.
//
//  ####  A PRÉVIA NÃO É ENFEITE  ####
//
//  É o único lugar em que quem cadastra descobre, ANTES de gravar,
//  que o "Troféu Bleik Store" que ele acabou de criar tem cara de
//  presente de Natal — porque o modelo 3D emprestado e o icone sao
//  o que o jogador ve.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import { ItemPickerDialog } from '@/components/item-picker-dialog';
import { ItemIcon } from '@/components/item-icon';
import { RankingDialog } from '@/components/ranking/ranking-dialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  agent,
  ApiError,
  EFFECT_TYPES,
  iconUrl,
  type CatalogItem,
  type CustomItem,
  type CustomItemAction,
  type CustomItemEffect,
  type CustomItemInput,
  type EffectType,
  type RankingDefinition,
  type RankingDefinitionInput,
} from '@/lib/api';
import { ICON_SIZE, toIconFile } from '@/lib/icon-image';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * O que cada efeito faz, em português.
 *
 * Os oito nomes são do JOGO (o enum `MetabolismAttribute.Type`) e
 * viajam como estão até o plugin — traduzi-los quebraria o
 * contrato. O que se traduz é o RÓTULO.
 */
const EFFECT_LABELS: Record<EffectType, string> = {
  Health: 'Vida (na hora)',
  HealthOverTime: 'Vida (ao longo do tempo)',
  Bleeding: 'Sangramento',
  Calories: 'Fome',
  Hydration: 'Sede',
  Poison: 'Veneno',
  Radiation: 'Radiação',
  Heartrate: 'Batimentos',
};

/**
 * Uma skin nossa, sorteada bem longe das reais.
 *
 * ####  POR QUE UM NÚMERO TÃO ALTO  ####
 *
 * As skins do Steam Workshop têm id na casa dos bilhões (dez
 * dígitos: `2973264769`). Sorteando acima de 10^15 nós ficamos
 * numa faixa em que o Steam não chega — e uma marca nossa nunca
 * vai colidir com a skin de alguém, hoje ou daqui a cinco anos.
 *
 * ####  POR QUE NUNCA ZERO  ####
 *
 * 1. skin 0 é indistinguível de item comum: o plugin passaria a
 *    reconhecer como nosso o troféu do Twitch que o jogador já
 *    tinha no baú;
 * 2. skin 0 num item SEM skins DERRUBA O JOGADOR do servidor pelo
 *    caminho do CUI — o `FirstOrDefault` do cliente devolve o
 *    default do struct, cujo id também é 0, o `if` passa e o
 *    `invItem` nulo estoura. Ver `core/src/game/ui-cui.ts:309-330`.
 */
function newSkinId(): string {
  const base = 1_000_000_000_000_000;
  const spread = Math.floor(Math.random() * 900_000_000_000_000);

  return String(base + spread);
}

/**
 * O corpo que um item novo empresta quando ninguém escolheu outro.
 *
 * ####  A SACOLA PARECIA ÓBVIA, E FOI MEDIDA  ####
 *
 * O primeiro palpite foi `halloween.lootbag.small` — ela é o saco
 * genérico do jogo, e é o que o Rust mostra quando junta um monte
 * de coisa no chão. O `origemz.item.inspect` do plugin desmentiu:
 *
 *     halloween.lootbag.small
 *       mods: ItemModUpgrade, ItemModOpenLootBag
 *
 * Ou seja: ela ABRE e sorteia loot de Halloween, e ainda junta 10
 * para virar a média. Um troféu que dá loot ao ser clicado, e que
 * some quando o jogador tem dez, não é um troféu.
 *
 * ####  O CORPO EMPRESTADO TRAZ OS HÁBITOS JUNTO  ####
 *
 * É a regra que decide esta constante, e ela já mordeu uma vez: o
 * primeiro Troféu Bleik nasceu COLOCÁVEL no chão porque o `trophy`
 * tem `ItemModEntity`. O corpo certo para um item custom é o que
 * não faz NADA sozinho.
 *
 * ####  MEDIDO: 31 ITENS DE 182 NÃO TÊM MOD NENHUM  ####
 *
 * E entre eles há uma família inteira de plaquetas de metal — as ID
 * Tags, em nove cores (`blueidtag`, `greenidtag`, `redidtag`…),
 * todas com stack 5000 e zero comportamento.
 *
 * `dogtagneutral` é a neutra da família: forma de PLAQUETA, que é
 * o que mais se aproxima de uma medalha — e é exatamente o que a
 * arte do Troféu Bleik é. O stack alto não incomoda: o nosso teto
 * só sabe DIMINUIR.
 */
export const DEFAULT_BASE_SHORTNAME = 'researchpaper';

/**
 * Os corpos que caem no chão como a SACOLA.
 *
 * ####  MEDIDO NO SERVIDOR, EM 05/09/2026  ####
 *
 * A sacola de pano que o Rust desenha para a larva e para o tecido
 * não é um item: é o que o jogo mostra quando o item **não tem
 * `worldModelPrefab`**. O `origemz.item.inspect` do plugin confirmou
 * — `grub` e `worm` vêm com o campo vazio.
 *
 * Destes quatro, além de caírem como sacola, **nenhum tem `ItemMod`
 * nenhum**: não abrem, não vestem, não viram entidade. São os únicos
 * do catálogo com as duas propriedades ao mesmo tempo, de 182
 * candidatos varridos.
 *
 * `researchpaper` é o padrão pelo empilhamento (1000): o nosso teto
 * só sabe DIMINUIR, então quanto mais alto o do corpo, mais margem
 * sobra.
 */
export const SACK_BODIES = ['researchpaper', 'fertilizer', 'glue', 'fuse'] as const;

/** O item cai no chão como a sacola genérica? */
export function isSackBody(shortname: string): boolean {
  return (SACK_BODIES as readonly string[]).includes(shortname);
}

/**
 * Quanto empilha, quando o admin liga o limite.
 *
 * Três é o número do briefing do Troféu Bleik, e serve de ponto de
 * partida para qualquer item de prêmio — quem quiser outro troca no
 * campo ao lado.
 */
export const DEFAULT_STACK = 3;

/** A ação de pontos, com os campos que só ela tem. */
type PointsAction = Extract<CustomItemAction, { kind: 'points' }>;

/**
 * A frase que o cadastro sugere para o chat.
 *
 * ####  ELA É EXEMPLO E PADRÃO AO MESMO TEMPO  ####
 *
 * Serve de `placeholder` (mostra o formato sem gravar nada) e de
 * conteúdo do botão "usar a frase sugerida". Ela usa três dos
 * quatro marcadores de propósito: quem a adota já vê o `{item}`
 * funcionando, e descobre os outros pela ajuda ao lado.
 *
 * O `{total}` fica no FIM porque ele não é um número: o plugin não
 * conhece o total (quem soma é o agente) e o substitui pela frase
 * "veja o total no /menu".
 */
const MESSAGE_PLACEHOLDER = 'Você ganhou {pontos} {item}! {total}';

/**
 * O ranking que nasce pelo atalho daqui de dentro.
 *
 * Fora do componente de propósito: um objeto literal no JSX teria
 * identidade nova a cada tecla digitada no formulário do item, e a
 * caixa de ranking recomeçaria o formulário dela junto.
 */
const POINTS_RANKING_PRESET: Partial<RankingDefinitionInput> = {
  // O item é a fonte do número, e a temporada é a janela da
  // premiação: é o que o Troféu Bleik pede.
  source: 'item',
  valueKind: 'counter',
  window: 'season',
};

/**
 * A ação que nasce quando o admin troca o tipo no seletor.
 *
 * Cada tipo tem campos próprios, e trocar de tipo não pode carregar
 * os campos do anterior — um item de pontos com uma lista de
 * efeitos pendurada deixaria a dúvida de qual dos dois vale.
 */
function newAction(kind: string, defaultMetric: string): CustomItemAction {
  if (kind === 'consume') {
    return { kind: 'consume', trigger: 'use', consumes: 1, effects: [] };
  }

  if (kind === 'points') {
    // A métrica vem do CADASTRO DE RANKINGS, e não de uma lista
    // fixa aqui: dois lugares dizendo quais rankings existem é a
    // segunda fonte que o projeto proíbe.
    return { kind: 'points', metric: defaultMetric, perUnit: 1, onPickup: true };
  }

  return { kind: 'none' };
}

/**
 * Uma caixa de marcar, com o motivo embaixo.
 *
 * ####  POR QUE NÃO O `Toggle` DA CASA  ####
 *
 * O Toggle mostra os DOIS lados ("pode" / "não pode") e pinta o que
 * está valendo. Para ligar e desligar um servidor isso é bom: os
 * dois estados são ações. Aqui eles são uma REGRA, e regra se lê de
 * uma vez — marcada vale, desmarcada não.
 */
function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
  readonly label: string;
  readonly hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-rust"
      />
      <span className="text-2xs leading-relaxed">
        <span className="font-condensed font-bold uppercase tracking-wide text-foreground">
          {label}
        </span>
        {hint !== undefined && <span className="block text-muted">{hint}</span>}
      </span>
    </label>
  );
}

const EMPTY: CustomItemInput = {
  displayName: '',
  baseShortname: DEFAULT_BASE_SHORTNAME,
  skinId: '',
  category: '',
  description: null,
  iconFile: null,
  maxStack: null,
  deployable: true,
  consumeOnPickup: false,
  action: { kind: 'none' },
  message: null,
  enabled: true,
  servers: [],
};

interface CustomItemDialogProps {
  readonly open: boolean;
  /** `null` = criando. Preenchido = editando aquele item. */
  readonly item: CustomItem | null;
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly categories: readonly string[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}

export function CustomItemDialog({
  open,
  item,
  servers,
  categories,
  onClose,
  onSaved,
}: CustomItemDialogProps) {
  const [form, setForm] = useState<CustomItemInput>(EMPTY);
  const [base, setBase] = useState<CatalogItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [escolhendo, setEscolhendo] = useState(false);
  const [enviandoIcone, setEnviandoIcone] = useState(false);
  /** O que a redução fez com a arte escolhida: "2,9 MB → 96×96, 25 KB". */
  const [iconSummary, setIconSummary] = useState<string | null>(null);
  /**
   * A prévia com os bytes que ACABARAM de subir.
   *
   * ####  POR QUE NÃO ESPERAR A ROTA DO AGENTE  ####
   *
   * Porque reenviar a arte corrigida grava o MESMO nome com bytes
   * novos, e a rota do ícone responde com `max-age=60` — quem
   * acabou de trocar a imagem veria a antiga por um minuto e
   * concluiria que o envio falhou. Estes bytes são os que o canvas
   * produziu, sem passar por cache nenhum.
   */
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  /**
   * O mesmo endereço, num ref, para poder soltá-lo.
   *
   * Ele não vive num `useEffect` de limpeza de propósito: em
   * desenvolvimento o StrictMode monta, desmonta e remonta, e a
   * limpeza soltaria o blob que a tela ainda está mostrando.
   */
  const iconPreviewRef = useRef<string | null>(null);

  /** Solta o blob da prévia anterior e passa a mostrar o novo. */
  const showIconPreview = useCallback((file: File | null): void => {
    const previous = iconPreviewRef.current;
    const next = file === null ? null : URL.createObjectURL(file);

    iconPreviewRef.current = next;
    setIconPreview(next);

    if (previous !== null) URL.revokeObjectURL(previous);
  }, []);
  /** O catálogo de rankings, para a ação de pontos. */
  const [rankings, setRankings] = useState<readonly RankingDefinition[]>([]);
  const [criandoRanking, setCriandoRanking] = useState(false);

  // Reabrir a caixa para OUTRO item precisa recomeçar o formulário:
  // sem isto, editar o item B mostraria os campos do item A até a
  // primeira tecla.
  useEffect(() => {
    if (!open) return;

    // A prévia e o resumo são do arquivo que ALGUÉM acabou de
    // escolher nesta caixa. Carregá-los para o item seguinte
    // mostraria o ícone do anterior ao lado do nome do novo.
    showIconPreview(null);
    setIconSummary(null);

    if (item === null) {
      setForm({ ...EMPTY, skinId: newSkinId() });
      setBase(null);
      return;
    }

    setForm({
      displayName: item.displayName,
      baseShortname: item.baseShortname,
      skinId: item.skinId,
      category: item.category,
      description: item.description,
      iconFile: item.iconFile,
      maxStack: item.maxStack,
      deployable: item.deployable,
      consumeOnPickup: item.consumeOnPickup,
      action: item.action,
      message: item.message,
      enabled: item.enabled,
      servers: [...item.servers],
    });
    setBase(null);
  }, [open, item, showIconPreview]);

  // O item base pode vir de um CADASTRO, e não de um clique na
  // grade — no item novo (que já nasce com a sacola) e ao editar um
  // existente. Nos dois casos a tela precisa buscar o nome e o
  // empilhamento, senão mostra só o shortname cru.
  useEffect(() => {
    if (!open || form.baseShortname === '') return;
    if (base?.shortname === form.baseShortname) return;

    let ativo = true;

    void (async () => {
      try {
        const response = await agent.item(form.baseShortname);

        if (ativo) setBase(response.item);
      } catch {
        // Item base que o jogo não tem mais. A tela mostra o
        // shortname cru, e o aviso de verdade vem do core ao salvar.
        if (ativo) setBase(null);
      }
    })();

    return () => {
      ativo = false;
    };
  }, [open, form.baseShortname, base]);

  /**
   * Os rankings LIGADOS, que é o que a ação de pontos pode apontar.
   *
   * Ele é relido a cada abertura porque o admin pode ter criado um
   * ranking entre um cadastro e outro — inclusive pelo atalho aqui
   * de dentro.
   */
  const carregarRankings = useCallback(async (): Promise<void> => {
    try {
      const response = await agent.rankingMetrics({ enabledOnly: true });

      setRankings(response.rankings);
    } catch {
      // O catálogo é auxiliar do formulário: sem ele o campo mostra
      // a métrica que o item já tem, e o erro de verdade aparece ao
      // salvar.
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    void carregarRankings();
  }, [open, carregarRankings]);

  const patch = (changes: Partial<CustomItemInput>): void => {
    setForm((current) => ({ ...current, ...changes }));
  };

  const toggleServer = (id: string): void => {
    patch({
      servers: form.servers.includes(id)
        ? form.servers.filter((entry) => entry !== id)
        : [...form.servers, id],
    });
  };

  const setAction = (action: CustomItemAction): void => {
    patch({ action });
  };

  const effects: CustomItemEffect[] = form.action.kind === 'consume' ? form.action.effects : [];

  // A métrica apontada, fora do estreitamento de tipo: dentro de um
  // callback o TypeScript perde o `kind === 'points'`, e a leitura
  // volta a ser a união inteira.
  const pointsMetric = form.action.kind === 'points' ? form.action.metric : '';

  // ####  O QUE O ITEM PODE FAZER VEM DO CORPO EMPRESTADO  ####
  //
  // O teto de empilhamento é do item escolhido, e o nosso limite só
  // sabe DIMINUIR — por isso ele é o máximo do campo, e não uma
  // sugestão.
  const baseStack = base?.maxStack ?? 1000;

  // Se o item base é colocável, o CATÁLOGO ainda não sabe: a ficha
  // que o servidor guarda não distingue (medido: `trophy` e
  // `bandage` têm campos idênticos). Quem sabe é o plugin, pelo
  // `origemz.item.inspect`. Enquanto esse dado não chega ao
  // catálogo, `null` quer dizer "não dá para afirmar" — e a dica ao
  // lado da caixa muda de acordo.
  const baseDeployable: boolean | null = null;

  // ####  "QUANDO O JOGADOR USAR" NÃO EXISTE EM TODO ITEM  ####
  //
  // O menu do botão direito é montado pelo CLIENTE do jogo a partir
  // da `ItemDefinition`: sem `ItemModConsumable` não há "usar", e
  // nenhum plugin acrescenta a opção. Um troféu configurado assim
  // ficaria inerte no inventário, em silêncio.
  //
  // `null` NÃO bloqueia: é "o catálogo ainda não foi lido por um
  // agente que reporta este campo", e travar por falta de dado
  // impediria de cadastrar com os servidores parados — que é
  // justamente quando se cadastra. O core recusa pelo mesmo
  // critério, e o plugin avisa no log se a combinação chegar lá.
  const usarBloqueado = base?.consumable === false;

  /**
   * De onde a prévia do ícone vem.
   *
   * A local ganha da rota do agente: são os bytes que ACABARAM de
   * sair do canvas, e a rota responde com `max-age=60` — trocar a
   * arte e continuar vendo a antiga por um minuto passaria a
   * impressão de que o envio não funcionou.
   */
  const iconSrc = iconPreview ?? (form.iconFile === null ? null : iconUrl(form.iconFile));

  const patchEffect = (index: number, changes: Partial<CustomItemEffect>): void => {
    if (form.action.kind !== 'consume') return;

    setAction({
      ...form.action,
      effects: form.action.effects.map((effect, i) =>
        i === index ? { ...effect, ...changes } : effect,
      ),
    });
  };

  /**
   * Manda o PNG e guarda o NOME que voltou.
   *
   * O nome vem do agente, e não do `file.name`: é ele quem decide
   * como o arquivo ficou gravado em disco, e é esse nome que o
   * plugin vai procurar.
   */
  const enviarIcone = async (file: File): Promise<void> => {
    setEnviandoIcone(true);

    try {
      // ####  O RESIZE ACONTECE AQUI, ANTES DE SAIR  ####
      //
      // O teto não é uma preferência nossa: é o tamanho do frame do
      // WebRCON, porque o PNG viaja até o servidor dentro de uma
      // linha de console. A arte que o admin tem é a original —
      // 1254×1254 e 2,9 MB, no caso da medalha —, e mandá-la crua
      // dava "request file too large" sem explicar o que fazer.
      //
      // Quem cadastra não deveria precisar abrir um editor de
      // imagem para descobrir isso.
      const resized = await toIconFile(file);

      // A prévia vem ANTES do envio para aparecer na hora, com os
      // bytes que acabaram de sair do canvas — e some no `catch` se
      // o envio falhar: um ícone na tela ao lado de um cadastro sem
      // ícone seria uma mentira sobre o que foi salvo.
      showIconPreview(resized.file);
      setIconSummary(resized.summary);

      const response = await agent.uploadCustomItemIcon(resized.file);

      patch({ iconFile: response.icon.name });

      toast.success(`Ícone enviado: ${resized.summary}.`);
    } catch (cause) {
      // A frase vem do CORE quando é dele (o teto, a régua do nome)
      // e do resize quando é dele (arquivo que não é PNG, arte que
      // não reduz). `Error` e não `ApiError` porque o segundo caso
      // não passa pela rede: com `String(cause)` o toast mostraria
      // "Error: " grudado na frase.
      toast.error(cause instanceof Error ? cause.message : String(cause));

      showIconPreview(null);
      setIconSummary(null);
    } finally {
      setEnviandoIcone(false);
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);

    try {
      if (item === null) {
        await agent.createCustomItem(form);
        toast.success(`"${form.displayName}" criado.`);
      } else {
        await agent.updateCustomItem(item.id, form);
        toast.success(`"${form.displayName}" salvo.`);
      }

      onSaved();
      onClose();
    } catch (cause) {
      // A frase vem do CORE, inteira: ele conhece as regras (marca
      // duplicada, item base que não existe) e a nossa não.
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  // O que impede de salvar, e nesta ordem — a primeira frase é a
  // que aparece.
  const problem =
    form.displayName.trim() === ''
      ? 'Dê um nome ao item.'
      : form.baseShortname === ''
        ? 'Escolha o item do jogo que empresta o corpo.'
        : form.category.trim() === ''
          ? 'Escolha uma categoria.'
          : form.skinId === '' || form.skinId === '0'
            ? 'A marca (skin) não pode ser zero.'
            : form.action.kind === 'consume' && effects.length === 0
              ? 'Uma ação de uso precisa de pelo menos um efeito.'
              : // A mesma recusa que o core aplica (400
                // BASE_ITEM_NOT_CONSUMABLE). Aqui ela existe para o
                // botão não prometer o que a rota vai negar — e para
                // pegar o caso de trocar o item base DEPOIS de já ter
                // escolhido "quando usar".
                form.action.kind === 'points' && !form.consumeOnPickup && usarBloqueado
                ? `${base?.displayName ?? form.baseShortname} não é usável: escolha "assim que cair no inventário" ou troque o item base.`
                : form.servers.length === 0
                  ? 'Escolha ao menos um servidor — sem isso o item não é entregue em lugar nenhum.'
                  : null;

  return (
    <>
      <Dialog
        open={open}
        busy={saving}
        onClose={onClose}
        // A LARGURA vem em `w-`, e não em `max-w-`: o Dialog já
        // define `w-[min(30rem,92vw)]`, e um `max-w-*` não briga com
        // isso — são propriedades diferentes, então o tailwind-merge
        // deixa as duas de pé e a caixa fica com 30rem de qualquer
        // jeito. É preciso sobrescrever a MESMA propriedade.
        className="w-[min(58rem,94vw)]"
        title={item === null ? 'Novo item custom' : `Editar "${item.displayName}"`}
      >
        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-1">
          {/* ---- identidade ---- */}
          <section className="space-y-3">
            <div>
              <Label htmlFor="ci-name">Nome, como o jogador lê</Label>
              <Input
                id="ci-name"
                value={form.displayName}
                placeholder="Troféu Bleik Store"
                onChange={(event) => patch({ displayName: event.target.value })}
              />
            </div>

            {/* ####  A ESCOLHA DO CORPO É VISUAL  ####

              Quem escolhe aqui não está procurando um shortname:
              está procurando uma FORMA — o que o jogador vai
              segurar na mão. Por isso a escolha abre uma grade de
              ícones, e não uma lista de nomes em inglês. */}
            <div>
              <Label htmlFor="ci-base">O modelo 3D do item</Label>

              <div className="flex items-center gap-3 border border-border bg-surface-2 p-2">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center border border-border bg-surface">
                  <ItemIcon shortname={form.baseShortname} className="h-12 w-12" />
                </div>

                <div className="min-w-0 flex-1 text-2xs leading-relaxed">
                  {isSackBody(form.baseShortname) ? (
                    <>
                      <p className="font-condensed font-bold uppercase tracking-wide text-foreground">
                        Sacola — o padrão do jogo
                      </p>
                      <p className="text-muted">
                        No chão ele cai como a sacola de pano que o Rust usa para item{' '}
                        <strong>sem modelo próprio</strong> — é o mesmo da larva e do tecido.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="truncate font-condensed font-bold uppercase tracking-wide text-foreground">
                        {base?.displayName ?? form.baseShortname}
                      </p>
                      <p className="truncate font-mono text-muted">
                        {form.baseShortname}
                        {base === null ? '' : ` · empilha ${String(base.maxStack)}`}
                      </p>
                    </>
                  )}
                </div>

                {!isSackBody(form.baseShortname) && (
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    title="Volta para a sacola"
                    onClick={() => patch({ baseShortname: DEFAULT_BASE_SHORTNAME })}
                  >
                    Usar sacola
                  </Button>
                )}

                <Button
                  id="ci-base"
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => setEscolhendo(true)}
                >
                  {isSackBody(form.baseShortname) ? 'Escolher outro' : 'Trocar'}
                </Button>
              </div>

              <p className="mt-1 text-2xs leading-relaxed text-muted">
                É o que o jogador <strong>segura na mão</strong> e vê no chão — o item custom
                empresta o modelo 3D, o slot e o empilhamento dele. A sacola é o padrão porque não
                promete forma nenhuma.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="ci-category">Categoria (nossa)</Label>
                <Input
                  id="ci-category"
                  list="ci-categories"
                  value={form.category}
                  placeholder="Troféus"
                  onChange={(event) => patch({ category: event.target.value })}
                />
                <datalist id="ci-categories">
                  {categories.map((entry) => (
                    <option key={entry} value={entry} />
                  ))}
                </datalist>
              </div>

              <div>
                <Label htmlFor="ci-skin">Marca (skin)</Label>
                <div className="flex gap-2">
                  <Input
                    id="ci-skin"
                    value={form.skinId}
                    className="font-mono"
                    onChange={(event) => patch({ skinId: event.target.value.replace(/\D/g, '') })}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    title="Sorteia outra marca"
                    onClick={() => patch({ skinId: newSkinId() })}
                  >
                    Sortear
                  </Button>
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-muted">
                  É o que distingue este item de um comum dentro do jogo.{' '}
                  <strong>Nunca use skin da loja do Rust</strong> — servidor que entrega skin paga a
                  quem não comprou é removido da lista.
                </p>
              </div>
            </div>

            <div>
              <Label htmlFor="ci-description">Descrição</Label>
              <Input
                id="ci-description"
                value={form.description ?? ''}
                placeholder="Prêmio da temporada. Cada troféu vale 1 ponto no ranking."
                onChange={(event) =>
                  patch({
                    description: event.target.value === '' ? null : event.target.value,
                  })
                }
              />
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                Aparece no painel do item, abaixo da descrição original — que vem do jogo e não pode
                ser apagada.
              </p>
            </div>

            {/* ####  O ÍCONE É ENVIADO, E NÃO DIGITADO  ####

              Pedir o nome do arquivo obrigava quem cadastra a
              copiar o PNG para uma pasta do servidor por fora do
              painel — e a errar o nome, descobrindo isso só quando
              o ícone não aparecesse no jogo. */}
            <div>
              <Label htmlFor="ci-icon">Ícone do item</Label>

              <div className="flex items-center gap-3 border border-border bg-surface-2 p-2">
                <div className="min-w-0 flex-1 text-2xs leading-relaxed">
                  {form.iconFile === null ? (
                    <p className="text-muted">
                      Sem ícone próprio — o item vai usar o do corpo emprestado.
                    </p>
                  ) : (
                    <p className="truncate font-mono text-foreground">{form.iconFile}</p>
                  )}

                  {/* ####  O QUE O RESIZE FEZ, ESCRITO  ####

                      O arquivo que subiu não é o que a pessoa
                      escolheu, e ela precisa saber disso — senão a
                      conclusão, ao ver o ícone borrado no slot, é
                      que o jogo estragou a arte dela. */}
                  {iconSummary !== null && (
                    <p className="mt-0.5 text-muted">Reduzido aqui: {iconSummary}.</p>
                  )}
                </div>

                {form.iconFile !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    disabled={enviandoIcone}
                    onClick={() => {
                      patch({ iconFile: null });
                      showIconPreview(null);
                      setIconSummary(null);
                    }}
                  >
                    Tirar
                  </Button>
                )}

                <label
                  className={cn(
                    'cursor-pointer border border-border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide text-foreground hover:bg-surface',
                    enviandoIcone && 'pointer-events-none opacity-60',
                  )}
                >
                  {enviandoIcone ? 'Enviando…' : 'Enviar PNG'}
                  <input
                    id="ci-icon"
                    type="file"
                    accept="image/png"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];

                      // O input é limpo sempre: sem isso, escolher o
                      // MESMO arquivo duas vezes seguidas não dispara
                      // o evento, e o segundo envio parece travado.
                      event.target.value = '';

                      if (file !== undefined) void enviarIcone(file);
                    }}
                  />
                </label>
              </div>

              <p className="mt-1 text-2xs leading-relaxed text-muted">
                Mande a arte no tamanho em que ela está: o painel a{' '}
                <strong>reduz para {ICON_SIZE}×{ICON_SIZE} aqui mesmo</strong> antes de subir — o
                PNG viaja até o jogo dentro de uma linha de console, e acima de 33 KB ela não passa.
                Arte menor que isso sobe como está, sem ser esticada. Depois disso o{' '}
                <strong>cliente baixa uma vez só</strong>.
              </p>
            </div>

            {/* ####  A PRÉVIA  ####

                É o único lugar em que quem cadastra vê o item como
                o JOGADOR vai vê-lo: o ícone que ele acabou de
                enviar, com o nome que ele acabou de digitar, no
                tamanho de um slot de inventário.

                Sem ela, o cadastro é um formulário no escuro — e o
                erro só aparece dentro do jogo. */}
            <div>
              <Label>Como vai aparecer no inventário</Label>

              <div className="flex flex-wrap items-center gap-4 border border-border bg-surface p-3">
                <div className="flex h-20 w-20 shrink-0 items-center justify-center border border-border bg-surface-2">
                  {iconSrc === null ? (
                    <ItemIcon shortname={form.baseShortname} className="h-16 w-16" />
                  ) : (
                    // O <img> cru, e nao o next/image: a imagem vem do
                    // AGENTE, que nao passa pelo otimizador do Next.
                    <img
                      src={iconSrc}
                      alt=""
                      className="h-16 w-16 object-contain"
                      // O ícone pode ter sido apagado do disco por
                      // fora do painel. Cair para o do corpo é
                      // melhor que um retângulo quebrado.
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
                </div>

                <div className="min-w-0 text-2xs leading-relaxed">
                  <p className="font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
                    {form.displayName.trim() === '' ? 'Sem nome ainda' : form.displayName}
                  </p>

                  {form.description !== null && form.description.trim() !== '' && (
                    <p className="mt-1 max-w-md text-muted">{form.description}</p>
                  )}

                  <p className="mt-1 text-muted">
                    {isSackBody(form.baseShortname)
                      ? 'No chão: sacola'
                      : `No chão: ${base?.displayName ?? form.baseShortname}`}
                    {form.maxStack === null ? '' : ` · empilha ${String(form.maxStack)}`}
                    {form.consumeOnPickup ? ' · some ao ser recebido' : ''}
                  </p>
                </div>
              </div>

              <p className="mt-1 text-2xs leading-relaxed text-muted">
                A descrição do item base do jogo continua aparecendo <strong>acima</strong> da
                nossa, e não pode ser apagada — ela vem da definição do Rust.
              </p>
            </div>
          </section>

          {/* ---- comportamento ---- */}
          <section className="space-y-3 border-t border-border pt-4">
            <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Comportamento
            </h3>

            {/* ####  REGRA MARCADA É REGRA APLICADA  ####

                Antes isto era um par de botões "pode / não pode",
                que obrigava a ler os dois para saber qual estava
                valendo. Caixa marcada diz o que vale, e só. */}
            <div className="space-y-2">
              <Check
                checked={form.deployable}
                onChange={(value) => patch({ deployable: value })}
                label="Pode ser colocado no chão"
                hint={
                  baseDeployable === false
                    ? 'O item escolhido não é colocável — marcar isto não muda nada.'
                    : 'Desmarque para o item ser só um prêmio, e não decoração de base.'
                }
              />

              <Check
                checked={form.maxStack !== null}
                onChange={(value) =>
                  patch({ maxStack: value ? Math.min(DEFAULT_STACK, baseStack) : null })
                }
                label="Limitar o empilhamento"
                hint={
                  base === null
                    ? 'Sem limite nosso, ele empilha o que o item do jogo empilhar.'
                    : `Sem limite nosso, ele empilha ${String(base.maxStack)} — o do item escolhido.`
                }
              />

              {form.maxStack !== null && (
                <div className="ml-6 flex items-center gap-2">
                  <Input
                    id="ci-stack"
                    type="number"
                    min={1}
                    max={baseStack}
                    value={form.maxStack}
                    aria-label="Quantidade máxima por pilha"
                    className="w-24"
                    onChange={(event) =>
                      patch({ maxStack: Math.max(1, Number(event.target.value) || 1) })
                    }
                  />
                  <span className="text-2xs leading-relaxed text-muted">
                    por pilha.{' '}
                    <strong>Só sabe diminuir</strong> — o teto vive na definição do jogo
                    {base === null ? '' : `, que é ${String(base.maxStack)}`}.
                  </span>
                </div>
              )}

              <Check
                checked={form.enabled}
                onChange={(value) => patch({ enabled: value })}
                label="Ligado (o item é entregue)"
                hint="Desligar tira de circulação sem deixar órfão: quem já tem continua com ele."
              />
            </div>

            <div>
              <Label htmlFor="ci-action">O que o item faz</Label>
              <select
                id="ci-action"
                value={form.action.kind}
                onChange={(event) =>
                  setAction(newAction(event.target.value, rankings[0]?.metric ?? ''))
                }
                className="w-full border border-border bg-surface-2 px-2 py-2 font-condensed text-2xs font-bold uppercase tracking-wide text-foreground"
              >
                <option value="none">Nada</option>
                <option value="consume">Efeito ao usar (cura, fome, sede…)</option>
                <option value="points">Pontos de ranking</option>
              </select>
            </div>

            {/* ####  O MOMENTO DA CONVERSÃO É UMA ESCOLHA DE DOIS  ####

                Antes era uma caixa de marcar, e ela escondia o
                outro lado: desmarcada, ninguém sabia o que
                acontecia. Dois rótulos lado a lado dizem os dois
                desfechos, e quem cadastra escolhe um deles.

                Não aparece com ação "Nada": não há o que agendar
                quando o item não faz nada. */}
            {form.action.kind !== 'none' && (
              <div>
                <Label htmlFor="ci-when">Quando a ação acontece</Label>
                <select
                  id="ci-when"
                  value={form.consumeOnPickup ? 'pickup' : 'use'}
                  onChange={(event) => patch({ consumeOnPickup: event.target.value === 'pickup' })}
                  className="w-full border border-border bg-surface-2 px-2 py-2 font-condensed text-2xs font-bold uppercase tracking-wide text-foreground"
                >
                  <option value="pickup">Assim que cair no inventário</option>

                  {/* ####  DESABILITADA, E NUNCA ESCONDIDA  ####

                      Sumir com a opção faria o admin procurá-la.
                      Ela fica visível, cinza, e o motivo está
                      escrito logo abaixo — junto do que fazer. */}
                  <option value="use" disabled={usarBloqueado}>
                    {usarBloqueado
                      ? 'Quando o jogador usar (este item não é usável)'
                      : 'Quando o jogador usar'}
                  </option>
                </select>

                <p className="mt-1 text-2xs leading-relaxed text-muted">
                  {usarBloqueado ? (
                    <>
                      <strong>
                        {base?.displayName ?? form.baseShortname} não é um item consumível do
                        Rust
                      </strong>{' '}
                      — o menu do botão direito é montado pelo cliente do jogo, e nenhum plugin
                      acrescenta opção nele. Configurado para esperar o uso, o item ficaria no
                      inventário sem nunca virar ponto. Para usar esse modo, escolha um item
                      base consumível (uma comida, uma bebida, um remédio).
                    </>
                  ) : form.consumeOnPickup ? (
                    <>
                      O item é gasto na hora e a ação acontece — o jogador não chega a guardá-lo,
                      e com isso <strong>guardar, dropar e transferir se resolvem sozinhos</strong>.
                    </>
                  ) : (
                    <>
                      O item fica no inventário até o jogador usá-lo. Enquanto ele existir,{' '}
                      <strong>guardar em baú e largar no chão são bloqueados</strong> — senão o
                      prêmio viraria decoração de base.
                    </>
                  )}
                </p>
              </div>
            )}

            {/* ####  PONTOS: O ITEM É UM RECIBO  ####

                Ele nasce, é visto por alguns segundos e morre,
                deixando atrás de si um número que só cresce. É o
                desenho do Troféu Bleik, e a parte de somar é do
                RANKING — a lista abaixo vem de lá, de
                `GET /api/rankings/metrics`. */}
            {form.action.kind === 'points' && (
              <div className="space-y-3 border border-border bg-surface-2 p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="ci-metric">Ranking</Label>
                    <select
                      id="ci-metric"
                      value={form.action.metric}
                      onChange={(event) =>
                        setAction({ ...(form.action as PointsAction), metric: event.target.value })
                      }
                      className="w-full border border-border bg-surface px-2 py-2 text-2xs text-foreground"
                    >
                      {/* O rótulo é o que se lê; o que viaja no
                          corpo é a MÉTRICA — a mesma string que o
                          ranking guarda. */}
                      {rankings.map((entry) => (
                        <option key={entry.id} value={entry.metric}>
                          {entry.label}
                        </option>
                      ))}

                      {/* A métrica que este item já aponta, quando
                          o ranking dela foi desligado ou apagado.
                          Sem esta linha o seletor trocaria o valor
                          sozinho, e o item passaria a dar ponto em
                          outro lugar sem ninguém pedir. */}
                      {pointsMetric !== '' &&
                        !rankings.some((entry) => entry.metric === pointsMetric) && (
                          <option value={pointsMetric}>{pointsMetric} (fora do catálogo)</option>
                        )}
                    </select>
                  </div>

                  <div>
                    <Label htmlFor="ci-per-unit">Pontos por unidade</Label>
                    <Input
                      id="ci-per-unit"
                      type="number"
                      min={1}
                      value={form.action.perUnit}
                      onChange={(event) =>
                        setAction({
                          ...(form.action as PointsAction),
                          perUnit: Math.max(1, Number(event.target.value) || 1),
                        })
                      }
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="max-w-md text-2xs leading-relaxed text-muted">
                    {rankings.length === 0 ? (
                      <>
                        <strong>Nenhum ranking ligado ainda.</strong> Crie um aqui mesmo — sem sair
                        deste cadastro, e sem perder o que já foi digitado.
                      </>
                    ) : (
                      <>
                        A lista vem do <strong>cadastro de rankings</strong>. O ponto é somado pelo{' '}
                        <strong>agente</strong>, e não pelo plugin, porque um contador dentro do jogo
                        morre no primeiro <code>oxide.reload</code>.
                      </>
                    )}
                  </p>

                  {/* ####  O ATALHO EXISTE PARA NÃO PERDER O CADASTRO  ####

                      Sem ele, quem descobre no meio do formulário
                      que o ranking não existe precisa sair, criar o
                      ranking e recomeçar o item do zero. */}
                  <Button size="sm" variant="outline" onClick={() => setCriandoRanking(true)}>
                    Criar ranking
                  </Button>
                </div>
              </div>
            )}

            {form.action.kind === 'consume' && (
              <div className="space-y-2 border border-border bg-surface-2 p-3">
                {effects.map((effect, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <select
                      value={effect.type}
                      aria-label="Tipo de efeito"
                      onChange={(event) =>
                        patchEffect(index, {
                          type: event.target.value as EffectType,
                        })
                      }
                      className="border border-border bg-surface px-2 py-1 text-2xs text-foreground"
                    >
                      {EFFECT_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {EFFECT_LABELS[type]}
                        </option>
                      ))}
                    </select>

                    <Input
                      type="number"
                      value={effect.amount}
                      aria-label="Quantidade"
                      className="w-24"
                      onChange={(event) =>
                        patchEffect(index, {
                          amount: Number(event.target.value),
                        })
                      }
                    />

                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      onClick={() =>
                        setAction({
                          ...form.action,
                          effects: effects.filter((_, i) => i !== index),
                        } as CustomItemAction)
                      }
                    >
                      Remover
                    </Button>
                  </div>
                ))}

                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() =>
                    setAction({
                      ...form.action,
                      effects: [...effects, { type: 'Health', amount: 10 }],
                    } as CustomItemAction)
                  }
                >
                  Acrescentar efeito
                </Button>

                <p className="text-2xs leading-relaxed text-muted">
                  Os oito efeitos são os do próprio jogo — os mesmos que a bandagem comum usa.
                  Número negativo tira: <code>Sangramento -100</code> estanca.
                </p>
              </div>
            )}

            <div>
              <Label htmlFor="ci-message">Frase no chat quando a ação acontece</Label>
              <Input
                id="ci-message"
                value={form.message ?? ''}
                placeholder={MESSAGE_PLACEHOLDER}
                onChange={(event) =>
                  patch({
                    message: event.target.value === '' ? null : event.target.value,
                  })
                }
              />

              {/* ####  OS MARCADORES PRECISAM ESTAR À VISTA  ####

                  Sem esta lista, quem cadastra escreve "Você ganhou
                  pontos!" — porque não tem como adivinhar que
                  `{pontos}` existe. E quem adivinha metade escreve
                  "Você tem {total} pontos", que sai torto: o
                  `{total}` é uma FRASE, e não um número. */}
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                <code>{'{pontos}'}</code> quantos entraram agora ·{' '}
                <code>{'{item}'}</code> o nome do item ·{' '}
                <code>{'{ranking}'}</code> o nome do ranking ·{' '}
                <code>{'{total}'}</code> vira a frase{' '}
                <em>&quot;veja o total no /menu&quot;</em>, e por isso serve no{' '}
                <strong>fim</strong> da mensagem.
              </p>

              <p className="mt-1 text-2xs leading-relaxed text-muted">
                Conversões seguidas do mesmo item viram{' '}
                <strong>uma linha só</strong>, com os pontos somados — dar 4 troféus escreve
                uma frase com 4, e não quatro frases iguais.
              </p>

              {form.message === null && (
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  className="mt-2"
                  onClick={() => patch({ message: MESSAGE_PLACEHOLDER })}
                >
                  Usar a frase sugerida
                </Button>
              )}
            </div>
          </section>

          {/* ---- servidores ---- */}
          <section className="space-y-2 border-t border-border pt-4">
            <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Em quais servidores
            </h3>

            {servers.length === 0 ? (
              <p className="text-2xs text-muted">Nenhum servidor cadastrado no agente.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {servers.map((server) => (
                  <button
                    key={server.id}
                    type="button"
                    onClick={() => toggleServer(server.id)}
                    className={cn(
                      'border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                      form.servers.includes(server.id)
                        ? 'border-olive bg-olive/10 text-foreground'
                        : 'border-border text-muted hover:border-muted',
                    )}
                  >
                    {server.name}
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
          {/* O motivo fica visível o tempo todo, e não escondido atrás
            de um botão desabilitado sem explicação. */}
          <p className="text-2xs text-rust">{problem}</p>

          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving || problem !== null}>
              {saving ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* ####  O PICKER É IRMÃO, E NÃO FILHO  ####

          Ele estava DENTRO do <Dialog> acima, e um <dialog> dentro
          de outro é onde a escolha se perdia: o `showModal` põe o
          elemento no top layer do browser, e fechar o de dentro
          mexe no de fora — o clique acontecia, mas o estado não
          sobrevivia ao fechamento.

          Como irmãos, cada um tem o seu ciclo e o clique na grade
          só faz o que mandamos. */}
      <ItemPickerDialog
        open={escolhendo}
        selected={form.baseShortname}
        onClose={() => setEscolhendo(false)}
        onPick={(picked) => {
          setBase(picked);
          patch({ baseShortname: picked.shortname });
        }}
      />

      {/* Irmã pela MESMA razão do picker acima. Criar o ranking
          daqui é o que impede o admin de perder o item que ele
          estava cadastrando só porque o ranking não existia. */}
      <RankingDialog
        open={criandoRanking}
        ranking={null}
        preset={POINTS_RANKING_PRESET}
        onClose={() => setCriandoRanking(false)}
        onSaved={(created) => {
          setRankings((current) => [...current, created]);
          setForm((current) =>
            current.action.kind === 'points'
              ? { ...current, action: { ...current.action, metric: created.metric } }
              : current,
          );
        }}
      />
    </>
  );
}
