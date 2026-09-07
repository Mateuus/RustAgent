'use client';

// ============================================================
//  PROPAGANDAS — o overlay animado do canto da tela.
//
//  É a aba "Propagandas" da página do servidor, e não uma rota
//  própria: o overlay desce para UM servidor (ver
//  components/server-page.tsx). Por isso não há <PageHeader/> aqui —
//  quem nomeia o servidor é o cabeçalho da página que hospeda a aba,
//  e o que sobrou do cabeçalho antigo são os BOTÕES, que viraram uma
//  barra própria no topo da aba.
//
//  Três blocos, e eles mudam por motivos diferentes:
//
//    PREVIEW    toca os MESMOS quadros que descem ao jogo. Não é
//               uma imitação — ver ads-preview.tsx.
//    AJUSTE     tamanho, posição, relógio e animação. Salvar aqui
//               refaz a animação inteira, e por isso a prévia
//               volta junto da resposta.
//    A LISTA    o que aparece, em que ordem e quando.
//
//  ------------------------------------------------------------
//  ####  SALVAR E EXPLICITO, COMO NO EDITOR DE KITS  ####
//
//  Arrastar um controle deslizante dispara dezenas de eventos por
//  segundo. Salvar a cada um encheria o banco de estados
//  intermediários de um desenho que ainda não existe — e cada
//  gravação reenvia a configuração ao servidor de Rust.
//
//  ------------------------------------------------------------
//  ####  A IMAGEM E BAIXADA PELO AGENTE, E ISSO DEMORA  ####
//
//  Cadastrar uma propaganda grava a URL e responde. O download
//  acontece depois, no agente, e o resultado aparece como
//  "pendente", "pronta" ou o erro em português — por isso o botão
//  "Recarregar imagens" existe e por isso o estado de cada uma
//  fica visível na linha.
// ============================================================

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Image as ImageIcon,
  LayoutTemplate,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdsPreview, type PreviewScene } from '@/components/ads-preview';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { agent, AD_LOGO_ANCHORS } from '@/lib/api';
import type { UiDocument } from '@/lib/ui-doc/model';
import type { AdLogoAnchor, Advertisement, AdsSettings, AdsTimeline } from '@/lib/api';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { toast } from '@/lib/toast';
import {
  ADS_DOCUMENT_ID,
  buildAdsOverlayDocument,
  readAdsOverlayLayout,
} from '@/lib/ui-doc/presets/ads-overlay';
import { cn } from '@/lib/utils';

/**
 * A prévia de antes de o agente responder.
 *
 * Ela existe para o preview ter o que tocar no primeiro quadro,
 * e não para representar nada: tudo zerado desenha a tela vazia,
 * que é o estado honesto enquanto a resposta não chegou.
 */
const EMPTY_ADS_ANIMATION = { durationMs: 0, frames: [] } as const;

const EMPTY_ADS_TIMELINE: AdsTimeline = {
  root: [],
  opening: { ...EMPTY_ADS_ANIMATION, frames: [] },
  adEnter: { ...EMPTY_ADS_ANIMATION, frames: [] },
  adExit: { ...EMPTY_ADS_ANIMATION, frames: [] },
  closing: { ...EMPTY_ADS_ANIMATION, frames: [] },
};

/**
 * A maquete no editor de Interface, achada pelo SLUG.
 *
 * ####  O ID DO DOCUMENTO AQUI E UM NUMERO  ####
 *
 * No painel antigo `saveUiDocument` recebia o id de texto e fazia
 * upsert sozinho. Aqui a interface tem duas identidades: o `slug`
 * — que é o `ADS_DOCUMENT_ID` do preset — e um id NUMÉRICO, que é
 * o que as rotas de gravação usam. Estas duas funções são a
 * tradução, e existem para os botões não precisarem saber disso.
 *
 * `null` = a maquete ainda não foi criada.
 */
async function findOverlayDocumentId(): Promise<number | null> {
  const { documents } = await agent.uiDocuments();

  return documents.find((item) => item.slug === ADS_DOCUMENT_ID)?.id ?? null;
}

/**
 * Grava a maquete, criando-a se for a primeira vez.
 *
 * Regerar SUBSTITUI em vez de duplicar: o slug é fixo, e uma
 * segunda "Overlay de Propagandas" na lista do editor seria uma
 * cópia que ninguém saberia qual abrir.
 */
async function saveOverlayDocument(document: unknown): Promise<void> {
  const id = await findOverlayDocumentId();

  if (id === null) {
    await agent.createUiDocument(document);
    return;
  }

  await agent.saveUiDocument(id, document);
}

/**
 * O que cada camada "de tela" faz, na frase de quem escolhe.
 *
 * ####  `Hud.Menu` NAO ESTA AQUI, E ISSO E O ACHADO  ####
 *
 * O nome dela sugere "o menu", e ela foi a primeira tentativa de
 * "so no inventario" — em 07/09/2026, no jogo, a propaganda
 * apareceu com o inventario FECHADO. Ela e uma camada sempre
 * visivel, so que acima do HUD.
 *
 * Quem some junto com a tela sao os containers que o cliente
 * monta e destroi: `Inventory`, `Crafting`, `Map`.
 */
const SCREEN_LAYER_HINT: Readonly<Record<string, string>> = {
  Inventory: 'O painel e desenhado dentro do inventario: aparece quando o jogador abre, e some quando ele fecha.',
  Crafting: 'O painel so existe enquanto a tela de crafting estiver aberta.',
  Map: 'O painel so existe enquanto o mapa estiver aberto.',
};

const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const;

/**
 * As cenas, e o "Parado" vem PRIMEIRO.
 *
 * ####  ELE E O QUE SE USA PARA ENCAIXAR  ####
 *
 * As outras tocam e voltam ao repouso — boas para conferir a
 * animacao, ruins para ajustar uma margem, porque o painel some
 * antes de a pessoa terminar de olhar. "Parado" desenha o estado
 * final e fica ali, e e sobre ele que se arrasta o painel ate o
 * lugar certo.
 */
const SCENES: readonly { readonly id: PreviewScene; readonly label: string }[] = [
  { id: 'parado', label: 'Parado' },
  { id: 'idle', label: 'Repouso' },
  { id: 'cycle', label: 'Ciclo completo' },
  { id: 'opening', label: 'Abertura' },
  { id: 'swap', label: 'Troca' },
  { id: 'closing', label: 'Fechamento' },
];

/**
 * O overlay de propagandas de UM servidor.
 *
 * ####  O `serverId` E PROP, E NAO ESTADO DAQUI  ####
 *
 * A lista e o ajuste são daquele mundo — o overlay do PVP anuncia
 * o Discord do PVP. Quem escolhe o servidor é a PÁGINA, que tem o
 * seletor; este componente recebe a escolha pronta e recarrega
 * tudo quando ela muda.
 */
export function AdsPage({ serverId }: { readonly serverId: string }) {
  const [settings, setSettings] = useState<AdsSettings | null>(null);
  const [draft, setDraft] = useState<AdsSettings | null>(null);
  const [timeline, setTimeline] = useState<AdsTimeline>(EMPTY_ADS_TIMELINE);
  const [ads, setAds] = useState<readonly Advertisement[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Qual das duas coisas se esta editando.
   *
   * Comeca no LOGO: e a peca que todo servidor tem, e a que o dono
   * mexe primeiro. Propaganda e campanha, e nem todo mundo roda uma.
   */
  const [tab, setTab] = useState<'logo' | 'propaganda'>('logo');

  const [scene, setScene] = useState<PreviewScene>('idle');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * Os grupos e permissões que EXISTEM no servidor.
   *
   * Vazio quando o RCON está fora ou o plugin é antigo: aí o
   * campo vira texto livre, que é como ele funcionava antes.
   */
  const [audience, setAudience] = useState<{
    available: boolean;
    groups: readonly string[];
    permissions: readonly string[];
  }>({ available: false, groups: [], permissions: [] });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const view = await agent.ads(serverId, signal);

      setSettings(view.settings);
      setDraft(view.settings);
      setTimeline(view.timeline);
      setAds(view.ads);
      setState('ready');
      setError(null);
    } catch (cause) {
      // Aborto é o efeito desmontando, não uma falha: tratá-lo
      // como erro mostraria "não deu para carregar" a cada
      // remontagem em desenvolvimento.
      if (cause instanceof DOMException && cause.name === 'AbortError') return;

      setError(cause instanceof Error ? cause.message : String(cause));
      setState('error');
    }
  }, [serverId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);

    // Falha aqui não é erro de tela: sem a lista, o campo de
    // público-alvo volta a ser texto livre.
    void agent.adsAudience(serverId, controller.signal)
      .then(setAudience)
      .catch(() => {
        /* segue com a lista vazia */
      });

    return () => {
      controller.abort();
    };
  }, [load, serverId]);

  const selected = useMemo(
    () => ads.find((ad) => ad.id === selectedId) ?? null,
    [ads, selectedId],
  );

  const dirty = useMemo(
    () => draft !== null && settings !== null && JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );

  // ####  A PREVIA ACOMPANHA O RASCUNHO  ####
  //
  // Sem isto, mover "largura do painel" não mudaria nada na tela
  // até alguém salvar — e ajustar no escuro é exatamente o que a
  // prévia existe para evitar.
  //
  // Quem GERA os quadros continua sendo o agente: o navegador
  // manda o rascunho e recebe a animação pronta. Gerá-la aqui
  // seria uma segunda implementação do mesmo cálculo, e a
  // divergência apareceria dentro do jogo.
  //
  // Debounce porque um controle deslizante dispara dezenas de
  // eventos por segundo, e cada um seria uma ida à rede.
  const debouncedDraft = useDebouncedValue(draft, 250);

  useEffect(() => {
    if (debouncedDraft === null || settings === null) return;

    // Nada mudou: a prévia que está na tela já é a certa, e pedir
    // de novo seria uma requisição para receber o que já se tem.
    if (JSON.stringify(debouncedDraft) === JSON.stringify(settings)) return;

    const controller = new AbortController();

    void agent
      .previewAdsSettings(serverId, { ...debouncedDraft, updatedAt: undefined })
      .then((fresh) => {
        setTimeline(fresh.timeline);
      })
      .catch(() => {
        // Falha aqui é só a prévia ficando velha por um instante.
        // Um toast a cada arrasto de controle seria pior que o
        // problema.
      });

    return () => {
      controller.abort();
    };
  }, [debouncedDraft, settings, serverId]);

  /** Um campo do rascunho. Nada vai à rede até salvar. */
  const set = useCallback(<K extends keyof AdsSettings>(key: K, value: AdsSettings[K]) => {
    setDraft((current) => (current === null ? current : { ...current, [key]: value }));
  }, []);

  const run = useCallback(
    async (what: string, action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
      } catch (cause) {
        toast.error(what, {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const save = useCallback(async () => {
    if (draft === null) return;

    await run('Não consegui salvar os ajustes', async () => {
      // Só o que MUDOU viaja: o PUT é parcial, e mandar tudo
      // sempre sobrescreveria o que outra aba acabou de gravar.
      const patch: Record<string, unknown> = {};

      for (const key of Object.keys(draft) as (keyof AdsSettings)[]) {
        if (key === 'updatedAt') continue;
        if (settings === null || draft[key] !== settings[key]) {
          patch[key] = draft[key];
        }
      }

      const saved = await agent.saveAdsSettings(serverId, patch);

      setSettings(saved.settings);
      setDraft(saved.settings);
      setTimeline(saved.timeline);

      toast.success('Ajustes salvos', {
        description: saved.settings.enabled
          ? 'O overlay foi reenviado ao servidor.'
          : 'O overlay está DESLIGADO: nada aparece no jogo.',
      });
    });
  }, [draft, settings, run, serverId]);

  if (state === 'loading') {
    return <StateBlock variant="loading" title="Carregando o overlay…" />;
  }

  if (state === 'error' || draft === null || settings === null) {
    return (
      <StateBlock
        variant="error"
        title="Sem contato com o agente"
        detail={error ?? 'O agente não respondeu.'}
      />
    );
  }

  return (
    <>
      {/* ####  A BARRA DE AÇÕES SOBREVIVEU AO CABEÇALHO  ####

          Ela morava no `aside` do <PageHeader/>, que saiu quando a
          tela virou aba. O selo e os dois botões continuam aqui, e
          alinhados à direita: "Salvar ajustes" é o único caminho
          para o rascunho virar overlay, e escondê-lo no fim da
          página faria alguém desenhar meia hora e sair sem gravar.

          O <main> que hospeda a aba já espaça os irmãos diretos; a
          barra e o bloco abaixo são dois deles. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <StatusPill enabled={settings.enabled} count={ads.filter((ad) => ad.live).length} />

        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            void run('Não consegui enviar ao servidor', async () => {
              const result = await agent.syncAds(serverId);

              if (result.ok) {
                toast.success('Overlay enviado ao servidor', {
                  description: `${String(result.ads ?? 0)} propaganda(s), ${String(
                    result.bytes ?? 0,
                  )} bytes.`,
                });
              } else {
                toast.warning('O envio não foi feito', {
                  description: result.reason ?? 'Confira se o servidor de Rust está no ar.',
                });
              }
            });
          }}
        >
          <Upload aria-hidden="true" className="h-3.5 w-3.5" />
          Enviar ao jogo
        </Button>

        <Button
          variant="primary"
          size="sm"
          disabled={busy || !dirty}
          onClick={() => {
            void save();
          }}
        >
          <Save aria-hidden="true" className="h-3.5 w-3.5" />
          {dirty ? 'Salvar ajustes' : 'Salvo'}
        </Button>
      </div>

      <div className="space-y-4">
        {!settings.enabled && (
          <StateBlock
            variant="empty"
            title="O overlay está desligado"
            detail={
              <>
                Nada aparece no jogo enquanto <strong>Ativar o overlay</strong> estiver desmarcado.
                Ele nasce assim de propósito — um agente recém-instalado não deveria pôr um painel
                na tela de ninguém.
              </>
            }
          />
        )}

        <Section title="O overlay">
          <div className="space-y-3">
            <Toggle
              label="Ativar o overlay"
              checked={draft.enabled}
              onChange={(value) => {
                set('enabled', value);
              }}
            />


            <AudienceField
              label="Quem vê o overlay"
              value={draft.permission}
              audience={audience}
              onChange={(value) => {
                set('permission', value);
              }}
            />

            {/* ####  O DESENHO TAMBEM MORA NO EDITOR  ####

                "360 por 120 no canto com 24 de margem" é fácil
                de escrever e difícil de imaginar. Os dois
                botões abaixo põem o MESMO widget dentro do
                editor de Interface, onde ele pode ser
                arrastado e medido contra o resto da tela — e
                trazem as medidas de volta.

                A ida e a volta são explícitas de propósito: o
                agente NÃO lê aquele documento. Se lesse,
                haveria duas verdades sobre onde o painel fica,
                e a que diverge é sempre a que ninguém olha. */}
            <div className="space-y-1 border-t border-border pt-3">
              <Label>Desenhar no editor de Interface</Label>
              <div className="flex flex-wrap gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void run('Não consegui criar o desenho', async () => {
                      await saveOverlayDocument(
                        buildAdsOverlayDocument(
                          {
                            anchor: draft.anchor,
                            marginTop: draft.marginTop,
                            marginRight: draft.marginRight,
                            logoWidth: draft.logoWidth,
                            logoHeight: draft.logoHeight,
                            panelWidth: draft.panelWidth,
                            panelHeight: draft.panelHeight,
                            panelColor: draft.panelColor,
                            panelBorderColor: draft.panelBorderColor,
                            logoImageUrl: draft.logoImageUrl,
                          },
                          { layer: draft.layer as 'Hud' },
                        ),
                      );

                      toast.success('Desenho criado em Interface', {
                        description:
                          'Abra a tela Interface, escolha "Overlay de Propagandas" e arraste à vontade.',
                      });
                    });
                  }}
                >
                  <LayoutTemplate aria-hidden="true" className="h-3.5 w-3.5" />
                  Mandar para o editor
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void run('Não consegui ler o desenho', async () => {
                      const id = await findOverlayDocumentId();
                      // `document` do detalhe é `unknown` de propósito:
                      // quem sabe a forma é o modelo de `lib/ui-doc`,
                      // e o `readAdsOverlayLayout` devolve `null` se o
                      // desenho não seguir a convenção.
                      const document =
                        id === null
                          ? null
                          : // O `.document.document` não é engano: a resposta
                            // traz o DETALHE (id, slug, revisão), e o desenho
                            // é um campo dentro dele.
                            ((await agent.uiDocument(id)).document.document as UiDocument);

                      if (document === null) {
                        toast.warning('Nenhum desenho salvo ainda', {
                          description: 'Use "Mandar para o editor" primeiro.',
                        });
                        return;
                      }

                      const layout = readAdsOverlayLayout(document);

                      if (layout === null) {
                        toast.warning('O desenho não segue a convenção', {
                          description:
                            'O elemento "ads-root" foi renomeado ou apagado — nada foi alterado.',
                        });
                        return;
                      }

                      setDraft((current) =>
                        current === null ? current : { ...current, ...layout },
                      );

                      toast.success('Medidas trazidas do editor', {
                        description: 'Confira a prévia e clique em SALVAR AJUSTES.',
                      });
                    });
                  }}
                >
                  <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                  Trazer as medidas de volta
                </Button>
              </div>
              <p className="text-2xs text-muted">
                O que roda no jogo é gerado a partir dos números desta tela. O documento no
                editor é uma <strong>maquete</strong>: serve para desenhar e medir, e não é lido
                pelo agente.
              </p>
            </div>

            <Field
              label="De onde o cliente tira a imagem"
              hint={
                draft.imageMode === 'stored'
                  ? 'Recomendado: o agente baixa uma vez e o servidor guarda. A troca de cartas fica instantânea.'
                  : 'O CLIENTE baixa do endereço. Aguenta imagens maiores, mas na primeira exibição ele mostra o quadrado de "carregando" do Rust — o overlay pré-carrega em repouso para disfarçar.'
              }
            >
              <select
                value={draft.imageMode}
                onChange={(event) => {
                  set('imageMode', event.target.value as AdsSettings['imageMode']);
                }}
                className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
              >
                <option value="stored">O agente prepara (recomendado)</option>
                <option value="url">O cliente baixa da URL</option>
              </select>
            </Field>
                          </div>
        </Section>

        {/* ============================================
            AS DUAS COISAS QUE O OVERLAY DESENHA

            ####  ELAS NAO SAO A MESMA COISA  ####

            O LOGO e a marca do servidor: fica parado, nao gira, e
            pode estar na tela o tempo todo. A PROPAGANDA e uma
            campanha: tem calendario, publico-alvo e rodizio.

            Ate 07/09/2026 as duas dividiam uma coluna de ajustes so,
            e a separacao existia apenas no `logoEnabled`. Agora cada
            uma tem a sua aba, o seu preview e a sua CAMADA — e e a
            camada que faz a separacao valer dentro do jogo: sem ela,
            por a propaganda no inventario levaria o logo junto.
            ============================================ */}
        <div className="flex gap-1 border-b border-border">
          {(
            [
              { id: 'logo', label: 'Logo do servidor' },
              { id: 'propaganda', label: `Propaganda (${String(ads.length)})` },
            ] as const
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setTab(entry.id);
                // A aba da propaganda abre no que o JOGO vai
                // desenhar: com o modo estatico ligado isso e o
                // painel parado, e nao uma animacao que o servidor
                // nunca toca. A do logo abre no repouso, que e o
                // unico estado dela.
                setScene(entry.id === 'propaganda' && draft.staticMode ? 'parado' : 'idle');
              }}
              className={cn(
                'border-b-2 px-3 py-2 text-xs font-medium uppercase tracking-wide transition-colors',
                tab === entry.id
                  ? 'border-rust text-foreground'
                  : 'border-transparent text-muted hover:text-foreground',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {/* ---------------- A ABA DO LOGO ---------------- */}
        {tab === 'logo' && (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Section title="Onde o logo fica">
              <AdsPreview
                settings={draft}
                timeline={timeline}
                ads={ads}
                scene="idle"
                selected={null}
                onFinished={() => {
                  /* o repouso nao termina sozinho */
                }}
              />

              <p className="mt-2 text-xs text-muted">
                Esta e a tela <strong>em repouso</strong>: o que o jogador ve quando nenhuma
                propaganda esta passando. A previsualizacao usa a mesma geometria que desce ao
                servidor, numa base de 1280&times;720 — o jogo escala o resto.
              </p>
            </Section>

            <div className="space-y-4">
              <Section title="Logo">
                <div className="space-y-3">
                  <Toggle
                    label="Mostrar o logo em repouso"
                    checked={draft.logoEnabled}
                    onChange={(value) => {
                      set('logoEnabled', value);
                    }}
                  />

                  <Field label="URL do logo" hint="PNG com fundo transparente fica melhor.">
                    <Input
                      value={draft.logoImageUrl ?? ''}
                      placeholder="https://meuservidor.com/assets/logo.png"
                      onChange={(event) => {
                        const value = event.target.value.trim();
                        set('logoImageUrl', value === '' ? null : value);
                      }}
                    />
                  </Field>

                  <div className="grid grid-cols-2 gap-2">
                    <NumberField
                      label="Largura"
                      value={draft.logoWidth}
                      min={16}
                      max={400}
                      onChange={(value) => {
                        set('logoWidth', value);
                      }}
                    />
                    <NumberField
                      label="Altura"
                      value={draft.logoHeight}
                      min={16}
                      max={400}
                      onChange={(value) => {
                        set('logoHeight', value);
                      }}
                    />
                  </div>

                  {/* ####  O LOGO PODE SAIR DO CANTO DO PAINEL  ####

                      Por padrão ele é a versão recolhida do painel:
                      mesmo canto, mesma margem. Isso deixa de fazer
                      sentido quando alguém quer o logo no alto e ao
                      centro — e esse é um pedido normal. */}
                  <div className="space-y-2 border-t border-border pt-3">
                    <Toggle
                      label="Logo em lugar próprio"
                      checked={draft.logoDetached}
                      onChange={(value) => {
                        set('logoDetached', value);
                      }}
                    />

                    {!draft.logoDetached && (
                      <p className="text-2xs text-muted">
                        Hoje ele acompanha o painel: mesmo canto, mesma margem.
                      </p>
                    )}

                    {draft.logoDetached && (
                      <>
                        {/* ####  E ESTE CAMPO QUE SEPARA OS DOIS  ####

                            Sem ele, por a propaganda em "so com o
                            inventario aberto" levaria o logo junto:
                            os dois eram pendurados na mesma camada.
                            Ver o parent do logo em ads-timeline.ts. */}
                        <Field label="Quando o logo aparece">
                          <select
                            value={draft.logoLayer ?? ''}
                            onChange={(event) => {
                              const escolha = event.target.value;
                              set(
                                'logoLayer',
                                escolha === ''
                                  ? null
                                  : (escolha as NonNullable<AdsSettings['logoLayer']>),
                              );
                            }}
                            className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
                          >
                            <option value="">A mesma hora que a propaganda</option>
                            <optgroup label="Sempre na tela">
                              <option value="Hud">Enquanto ele joga</option>
                              <option value="Hud.Menu">Por cima do HUD (Hud.Menu)</option>
                              <option value="Overlay">Por cima de mais coisas</option>
                              <option value="Overall">Acima de tudo</option>
                            </optgroup>
                            <optgroup label="So enquanto a tela estiver aberta">
                              <option value="Inventory">So no inventario</option>
                              <option value="Crafting">So na tela de crafting</option>
                              <option value="Map">So no mapa</option>
                            </optgroup>
                          </select>
                          <p className="mt-1 text-2xs text-muted">
                            {draft.logoLayer === null ? (
                              draft.layer === 'Hud.Menu' ? (
                                <>
                                  Como a propaganda esta em <strong>so com o inventario aberto</strong>,
                                  o logo tambem some fora do menu. Escolha{' '}
                                  <strong>sempre</strong> aqui para a marca do servidor ficar na tela.
                                </>
                              ) : (
                                <>Ele acompanha a camada da propaganda.</>
                              )
                            ) : (
                              <>
                                O logo tem camada propria: ele nao depende mais de onde a
                                propaganda aparece.
                              </>
                            )}
                          </p>
                        </Field>

                        <AnchorPicker
                          value={draft.logoAnchor}
                          onChange={(value) => {
                            set('logoAnchor', value);
                          }}
                        />

                        <div className="grid grid-cols-2 gap-2">
                          <NumberField
                            label={
                              draft.logoAnchor.endsWith('-center')
                                ? 'Deslocar na horizontal'
                                : 'Margem lateral'
                            }
                            value={draft.logoMarginX}
                            min={-640}
                            max={640}
                            onChange={(value) => {
                              set('logoMarginX', value);
                            }}
                          />
                          <NumberField
                            label={
                              draft.logoAnchor.startsWith('middle-')
                                ? 'Deslocar na vertical'
                                : 'Margem vertical'
                            }
                            value={draft.logoMarginY}
                            min={-360}
                            max={360}
                            onChange={(value) => {
                              set('logoMarginY', value);
                            }}
                          />
                        </div>

                        {/* No meio de um eixo não há borda de onde
                            medir: o número vira deslocamento, e o
                            negativo passa a ser um pedido legítimo. */}
                        <p className="text-2xs text-muted">
                          {draft.logoAnchor.includes('center') || draft.logoAnchor.startsWith('middle')
                            ? 'No centro, o número desloca a partir dele — negativo vai para o outro lado.'
                            : 'Num canto, o número é a distância até a borda.'}
                        </p>
                      </>
                    )}
                  </div>

                  <Slider
                    label="Opacidade"
                    value={draft.logoOpacity}
                    min={0.1}
                    max={1}
                    step={0.05}
                    format={(value) => `${String(Math.round(value * 100))}%`}
                    onChange={(value) => {
                      set('logoOpacity', value);
                    }}
                  />

                </div>
              </Section>
            </div>
          </div>
        )}

        {/* ---------------- A ABA DA PROPAGANDA ---------------- */}
        {tab === 'propaganda' && (
          <>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
              <Section
                title="Pré-visualização"
                aside={
                  <div className="flex flex-wrap gap-1">
                    {SCENES.map((entry) => (
                      <Button
                        key={entry.id}
                        variant={scene === entry.id ? 'primary' : 'ghost'}
                        size="sm"
                        onClick={() => {
                          // Volta ao repouso primeiro: sem isso,
                          // clicar duas vezes na mesma cena não a
                          // reinicia (o estado não mudou).
                          setScene('idle');
                          window.setTimeout(() => {
                            setScene(entry.id);
                          }, 30);
                        }}
                      >
                        {entry.label}
                      </Button>
                    ))}
                  </div>
                }
              >
                <AdsPreview
                  settings={draft}
                  timeline={timeline}
                  ads={ads}
                  scene={scene}
                  selected={selected}
                  onFinished={() => {
                    setScene('idle');
                  }}
                  // Arrastar grava direto no rascunho: e o mesmo
                  // `set` dos campos de numero, e por isso o botao
                  // "Salvar" continua sendo quem manda ao jogo.
                  onMove={(patch) => {
                    setDraft((current) => (current === null ? current : { ...current, ...patch }));
                  }}
                />

                <p className="mt-2 text-xs text-muted">
                  A prévia toca <strong>os mesmos quadros</strong> que descem ao servidor: mesma
                  geometria, mesmos tempos. O que ela não reproduz é a resolução do monitor de cada
                  jogador — o CUI mede tudo numa base de 1280&times;720 e o jogo escala o resto.
                </p>
              </Section>

              <div className="space-y-4">
                <Section title="Onde e como aparece">
                  <div className="space-y-3">
                    <Field label="Quando a propaganda aparece">
                      <select
                        value={draft.layer}
                        onChange={(event) => {
                          set('layer', event.target.value as AdsSettings['layer']);
                        }}
                        className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
                      >
                        <optgroup label="Sempre na tela">
                          <option value="Hud">Enquanto ele joga</option>
                          <option value="Hud.Menu">Por cima do HUD (Hud.Menu)</option>
                          <option value="Overlay">Por cima de mais coisas</option>
                          <option value="Overall">Acima de tudo</option>
                        </optgroup>
                        <optgroup label="So enquanto a tela estiver aberta">
                          <option value="Inventory">So no inventario</option>
                          <option value="Crafting">So na tela de crafting</option>
                          <option value="Map">So no mapa</option>
                        </optgroup>
                      </select>
                      <p className="mt-1 text-xs text-muted">
                        {SCREEN_LAYER_HINT[draft.layer] ?? 'O painel fica na tela enquanto o jogador joga.'}
                      </p>
                      {SCREEN_LAYER_HINT[draft.layer] !== undefined && (
                        <p className="mt-1 text-2xs text-amber">
                          Quem resolve isso e o CLIENTE, pelo nome do container na interface do
                          jogo — o servidor nunca ve esses objetos. Se o Rust renomear um deles num
                          update, o overlay simplesmente <strong>para de desenhar</strong>, sem erro
                          nenhum. Confira no jogo depois de salvar, e volte para{' '}
                          <strong>Enquanto ele joga</strong> se nao aparecer.
                        </p>
                      )}
                    </Field>

                    <Toggle
                      label="Ficar parada, sem girar"
                      checked={draft.staticMode}
                      onChange={(value) => {
                        set('staticMode', value);
                      }}
                    />

                    <p className="text-xs text-muted">
                      {draft.staticMode ? (
                        <>
                          O painel e desenhado <strong>uma vez</strong>, com uma propaganda so — a
                          de maior prioridade entre as que aquele jogador pode ver — e fica ali. Sem
                          abrir, sem girar, sem fechar. O <strong>Ciclo e animacao</strong> abaixo
                          para de ter efeito; o giro entre campanhas passa a acontecer de uma
                          aparicao para a outra.
                        </>
                      ) : (
                        <>
                          O painel abre de tempos em tempos, gira as campanhas e fecha. Os tempos
                          estao em <strong>Ciclo e animacao</strong>.
                        </>
                      )}
                    </p>
                    <Field label="Posição na tela">
                      <select
                        value={draft.anchor}
                        onChange={(event) => {
                          set('anchor', event.target.value as AdsSettings['anchor']);
                        }}
                        className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
                      >
                        <option value="top-right">Superior direito</option>
                        <option value="top-left">Superior esquerdo</option>
                        <option value="bottom-right">Inferior direito</option>
                        <option value="bottom-left">Inferior esquerdo</option>
                      </select>
                    </Field>

                    <div className="grid grid-cols-2 gap-2">
                      <NumberField
                        label="Margem topo"
                        value={draft.marginTop}
                        min={0}
                        max={400}
                        onChange={(value) => {
                          set('marginTop', value);
                        }}
                      />
                      <NumberField
                        label="Margem lateral"
                        value={draft.marginRight}
                        min={0}
                        max={400}
                        onChange={(value) => {
                          set('marginRight', value);
                        }}
                      />
                    </div>

                  </div>
                </Section>

                <Section title="Painel">
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <NumberField
                        label="Largura"
                        value={draft.panelWidth}
                        min={80}
                        max={900}
                        onChange={(value) => {
                          set('panelWidth', value);
                        }}
                      />
                      <NumberField
                        label="Altura"
                        value={draft.panelHeight}
                        min={40}
                        max={500}
                        onChange={(value) => {
                          set('panelHeight', value);
                        }}
                      />
                    </div>

                    <p className="text-2xs text-muted">
                      Proporção atual: <strong>{ratioOf(draft.panelWidth, draft.panelHeight)}</strong>.
                      Imagens com proporção diferente ficam esticadas no modo <em>cover</em> — o CUI não
                      recorta.
                    </p>

                    <Color
                      label="Fundo do painel"
                      value={draft.panelColor}
                      onChange={(value) => {
                        set('panelColor', value);
                      }}
                    />

                    <Toggle
                      label="Moldura de 1 px"
                      checked={draft.panelBorderEnabled}
                      onChange={(value) => {
                        set('panelBorderEnabled', value);
                      }}
                    />

                    {draft.panelBorderEnabled && (
                      <Color
                        label="Cor da moldura"
                        value={draft.panelBorderColor}
                        onChange={(value) => {
                          set('panelBorderColor', value);
                        }}
                      />
                    )}
                  </div>
                </Section>


                <Section title="Ciclo e animação">
                  <div className="space-y-3">
                    <NumberField
                      label="Intervalo entre ciclos (segundos)"
                      value={draft.intervalSeconds}
                      min={15}
                      max={86400}
                      onChange={(value) => {
                        set('intervalSeconds', value);
                      }}
                    />

                    {/* O piso de 15 s existe para TESTAR. Deixá-lo sem
                        aviso faria alguém esquecê-lo em produção e
                        descobrir pelo jogador reclamando. */}
                    {draft.intervalSeconds < 60 && (
                      <p className="text-2xs text-amber">
                        Menos de um minuto é ótimo para ajustar o desenho e agressivo para valer: o
                        painel abre {String(Math.round(60 / draft.intervalSeconds))}&times; por minuto
                        na tela de quem está jogando.
                      </p>
                    )}

                    <NumberField
                      label="Tempo padrão de cada propaganda (segundos)"
                      value={draft.defaultDisplayDuration}
                      min={1}
                      max={120}
                      onChange={(value) => {
                        set('defaultDisplayDuration', value);
                      }}
                    />

                    <NumberField
                      label="Propagandas por ciclo (0 = todas)"
                      value={draft.adsPerCycle}
                      min={0}
                      max={50}
                      onChange={(value) => {
                        set('adsPerCycle', value);
                      }}
                    />

                    <Field label="Ordem">
                      <select
                        value={draft.orderMode}
                        onChange={(event) => {
                          set('orderMode', event.target.value as AdsSettings['orderMode']);
                        }}
                        className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
                      >
                        <option value="sequential">Sequencial (rodízio)</option>
                        <option value="random">Aleatória (por peso)</option>
                      </select>
                    </Field>

                    <div className="grid grid-cols-3 gap-2">
                      <NumberField
                        label="Abertura (ms)"
                        value={draft.openingMs}
                        min={100}
                        max={3000}
                        onChange={(value) => {
                          set('openingMs', value);
                        }}
                      />
                      <NumberField
                        label="Troca (ms)"
                        value={draft.transitionMs}
                        min={100}
                        max={2000}
                        onChange={(value) => {
                          set('transitionMs', value);
                        }}
                      />
                      <NumberField
                        label="Fechamento (ms)"
                        value={draft.closingMs}
                        min={100}
                        max={3000}
                        onChange={(value) => {
                          set('closingMs', value);
                        }}
                      />
                    </div>

                    <Slider
                      label="Suavidade das transições"
                      value={draft.animationFps}
                      min={5}
                      max={30}
                      step={1}
                      format={(value) => `${String(value)} fps`}
                      onChange={(value) => {
                        set('animationFps', Math.round(value));
                      }}
                    />
                  </div>
                </Section>
              </div>
            </div>

            {/* ---------------- A LISTA ---------------- */}
            <Section
              title={`Propagandas (${String(ads.length)})`}
              aside={
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void run('Não consegui recarregar as imagens', async () => {
                        const { ads: updated } = await agent.refreshAdImages(serverId, true);
                        setAds(updated);

                        const broken = updated.filter((ad) => ad.imageStatus === 'error').length;
                        if (broken > 0) {
                          toast.warning(`${String(broken)} imagem(ns) não carregaram`, {
                            description: 'O motivo de cada uma está na linha dela.',
                          });
                        } else {
                          toast.success('Imagens recarregadas');
                        }
                      });
                    }}
                  >
                    <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                    Recarregar imagens
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void run('Não consegui limpar o cache', async () => {
                        await agent.clearAdsCache(serverId);
                        await load();
                        toast.success('Cache limpo', {
                          description: 'As imagens serão baixadas de novo no próximo envio.',
                        });
                      });
                    }}
                  >
                    <ImageIcon aria-hidden="true" className="h-3.5 w-3.5" />
                    Limpar cache
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void run('Não consegui mostrar no jogo', async () => {
                        await agent.showAds(serverId);
                        toast.success('Ciclo disparado no servidor');
                      });
                    }}
                  >
                    <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                    Mostrar no jogo
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void run('Não consegui esconder', async () => {
                        await agent.hideAds(serverId);
                        toast.success('Overlay retirado da tela de todos');
                      });
                    }}
                  >
                    <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
                    Esconder
                  </Button>

                  <Button
                    variant="confirm"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void run('Não consegui cadastrar', async () => {
                        const created = await agent.createAd(serverId, {
                          name: 'Nova propaganda',
                          imageUrl: 'https://exemplo.com/propaganda.png',
                          enabled: false,
                        });

                        setAds((current) => [...current, created.ad]);
                        setSelectedId(created.ad.id);
                      });
                    }}
                  >
                    <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                    Nova
                  </Button>
                </div>
              }
            >
              {ads.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title="Nenhuma propaganda cadastrada"
                  detail="Clique em NOVA, cole o endereço de uma imagem e ligue. O agente baixa e confere sozinho."
                />
              ) : (
                <ul className="space-y-2">
                  {ads.map((ad, index) => (
                    <AdRow
                      key={ad.id}
                      ad={ad}
                      index={index}
                      total={ads.length}
                      busy={busy}
                      selected={ad.id === selectedId}
                      defaultDuration={settings.defaultDisplayDuration}
                      imageMode={settings.imageMode}
                      audience={audience}
                      onSelect={() => {
                        setSelectedId(ad.id);
                      }}
                      onPatch={(patch) => {
                        void run('Não consegui salvar a propaganda', async () => {
                          const updated = (await agent.updateAd(serverId, ad.id, patch)).ad;
                          if (updated !== null) {
                            setAds((current) =>
                              current.map((item) => (item.id === ad.id ? updated : item)),
                            );
                          }
                        });
                      }}
                      onMove={(direction) => {
                        void run('Não consegui reordenar', async () => {
                          const ids = ads.map((item) => item.id);
                          const target = index + direction;

                          if (target < 0 || target >= ids.length) return;

                          const moved = [...ids];
                          const [taken] = moved.splice(index, 1);
                          if (taken !== undefined) moved.splice(target, 0, taken);

                          setAds((await agent.reorderAds(serverId, moved)).ads);
                        });
                      }}
                      onDuplicate={() => {
                        void run('Não consegui duplicar', async () => {
                          const copy = await agent.duplicateAd(serverId, ad.id);
                          setAds((current) => [...current, copy.ad]);
                        });
                      }}
                      onDelete={() => {
                        void run('Não consegui excluir', async () => {
                          await agent.deleteAd(serverId, ad.id);
                          setAds((current) => current.filter((item) => item.id !== ad.id));
                          if (selectedId === ad.id) setSelectedId(null);
                        });
                      }}
                      onTest={() => {
                        void run('Não consegui testar no jogo', async () => {
                          await agent.testAd(serverId, ad.id);
                          toast.success('Enviada ao servidor', {
                            description: 'Ela aparece agora na tela de quem está online.',
                          });
                        });
                      }}
                      onPreview={() => {
                        setSelectedId(ad.id);
                        setScene('idle');
                        window.setTimeout(() => {
                          setScene('single');
                        }, 30);
                      }}
                    />
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------
//  UMA PROPAGANDA
// ------------------------------------------------------------

interface AdRowProps {
  readonly ad: Advertisement;
  readonly index: number;
  readonly total: number;
  readonly busy: boolean;
  readonly selected: boolean;
  readonly defaultDuration: number;
  /**
   * ####  O ERRO DE PREPARO SO EXISTE NUM DOS MODOS  ####
   *
   * Em `url` quem baixa é o cliente: o cache do agente não vale
   * nada ali, e mostrar um erro dele seria acusar de quebrado
   * algo que está funcionando no jogo.
   */
  readonly imageMode: 'stored' | 'url';
  readonly audience: AudienceList;
  readonly onSelect: () => void;
  readonly onPatch: (patch: Record<string, unknown>) => void;
  readonly onMove: (direction: 1 | -1) => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  readonly onTest: () => void;
  readonly onPreview: () => void;
}

function AdRow({
  ad,
  index,
  total,
  busy,
  selected,
  defaultDuration,
  imageMode,
  audience,
  onSelect,
  onPatch,
  onMove,
  onDuplicate,
  onDelete,
  onTest,
  onPreview,
}: AdRowProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(ad.name);
  const [url, setUrl] = useState(ad.imageUrl);

  useEffect(() => {
    setName(ad.name);
    setUrl(ad.imageUrl);
  }, [ad.name, ad.imageUrl]);

  return (
    <li
      className={cn(
        'border bg-surface-2',
        selected ? 'border-amber' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <ImageBadge ad={ad} imageMode={imageMode} />

        <button
          type="button"
          onClick={() => {
            onSelect();
            setOpen((value) => !value);
          }}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
            {ad.name}
          </p>
          <p className="truncate text-2xs text-muted">{ad.imageUrl}</p>
        </button>

        <span className="text-2xs text-muted">
          {String(ad.displayDuration ?? defaultDuration)}s
        </span>

        <Toggle
          label=""
          checked={ad.enabled}
          onChange={(value) => {
            onPatch({ enabled: value });
          }}
        />

        <div className="flex items-center gap-1">
          <IconButton
            title="Subir"
            disabled={busy || index === 0}
            onClick={() => {
              onMove(-1);
            }}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            title="Descer"
            disabled={busy || index === total - 1}
            onClick={() => {
              onMove(1);
            }}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Ver na prévia" disabled={busy} onClick={onPreview}>
            <Play className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Mostrar no jogo agora" disabled={busy} onClick={onTest}>
            <Eye className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Duplicar" disabled={busy} onClick={onDuplicate}>
            <Copy className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Excluir" disabled={busy} danger onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {ad.imageStatus === 'error' && imageMode === 'stored' && (
        <p className="border-t border-rust/40 bg-rust/10 px-3 py-2 text-xs text-foreground">
          {ad.imageError ?? 'A imagem não pôde ser preparada.'}
        </p>
      )}

      {!ad.inSchedule && ad.enabled && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted">
          Fora da janela de exibição agora — ela volta sozinha quando a data/horário entrar.
        </p>
      )}

      {open && (
        <div className="space-y-3 border-t border-border p-3">
          <div className="grid gap-2 md:grid-cols-2">
            <Field label="Nome">
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                onBlur={() => {
                  if (name !== ad.name) onPatch({ name });
                }}
              />
            </Field>

            <Field label="URL da imagem" hint="Trocar o endereço faz o agente baixar de novo.">
              <Input
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                }}
                onBlur={() => {
                  if (url !== ad.imageUrl) onPatch({ imageUrl: url.trim() });
                }}
              />
            </Field>
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            <NumberField
              label="Tempo na tela (s)"
              value={ad.displayDuration ?? defaultDuration}
              min={1}
              max={120}
              onChange={(value) => {
                onPatch({ displayDuration: value });
              }}
            />
            <NumberField
              label="Prioridade"
              value={ad.priority}
              min={0}
              max={1000}
              onChange={(value) => {
                onPatch({ priority: value });
              }}
            />
            <NumberField
              label="Peso (sorteio)"
              value={ad.weight}
              min={1}
              max={1000}
              onChange={(value) => {
                onPatch({ weight: value });
              }}
            />
            <Field label="Enquadramento">
              <select
                value={ad.fit}
                onChange={(event) => {
                  onPatch({ fit: event.target.value });
                }}
                className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
              >
                <option value="cover">Preencher (pode esticar)</option>
                <option value="contain">Caber inteira</option>
              </select>
            </Field>
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            <Field label="A partir de">
              <Input
                type="date"
                value={ad.startDate ?? ''}
                onChange={(event) => {
                  onPatch({ startDate: event.target.value === '' ? null : event.target.value });
                }}
              />
            </Field>
            <Field label="Até">
              <Input
                type="date"
                value={ad.endDate ?? ''}
                onChange={(event) => {
                  onPatch({ endDate: event.target.value === '' ? null : event.target.value });
                }}
              />
            </Field>
            <Field label="Das">
              <Input
                type="time"
                value={ad.startTime ?? ''}
                onChange={(event) => {
                  onPatch({ startTime: event.target.value === '' ? null : event.target.value });
                }}
              />
            </Field>
            <Field label="Às" hint="Pode virar a meia-noite: 22:00 às 02:00 funciona.">
              <Input
                type="time"
                value={ad.endTime ?? ''}
                onChange={(event) => {
                  onPatch({ endTime: event.target.value === '' ? null : event.target.value });
                }}
              />
            </Field>
          </div>

          <Field label="Dias da semana" hint="Nenhum marcado = todos os dias.">
            <div className="flex flex-wrap gap-1">
              {DAY_LABELS.map((label, day) => {
                const active = ad.daysOfWeek.includes(day);

                return (
                  <Button
                    key={label}
                    variant={active ? 'primary' : 'outline'}
                    size="sm"
                    onClick={() => {
                      const next = active
                        ? ad.daysOfWeek.filter((item) => item !== day)
                        : [...ad.daysOfWeek, day];

                      onPatch({ daysOfWeek: next });
                    }}
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
          </Field>

          <div className="grid gap-2 md:grid-cols-3">
            <AudienceField
              label="Quem vê esta"
              value={ad.permission}
              audience={audience}
              onChange={(value) => {
                onPatch({ permission: value });
              }}
            />

            <Color
              label="Fundo"
              value={ad.backgroundColor}
              onChange={(value) => {
                onPatch({ backgroundColor: value });
              }}
            />

            <div className="text-2xs text-muted">
              <p className="mb-1 font-condensed font-bold uppercase tracking-wide">Imagem</p>
              {ad.imageWidth !== null && ad.imageHeight !== null ? (
                <p>
                  {String(ad.imageWidth)}&times;{String(ad.imageHeight)} px
                  {ad.imageBytes !== null && ` — ${String(Math.round(ad.imageBytes / 1024))} KB`}
                </p>
              ) : (
                <p>ainda não foi baixada</p>
              )}
              <p className="mt-1">
                Exibida {String(ad.shownCount)}&times;
                {ad.lastShownAt !== null && ` — última em ${formatWhen(ad.lastShownAt)}`}
              </p>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------
//  PEÇAS
// ------------------------------------------------------------

function StatusPill({ enabled, count }: { readonly enabled: boolean; readonly count: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 border px-2 py-1 font-condensed text-2xs font-bold uppercase tracking-wide',
        enabled ? 'border-olive text-foreground' : 'border-border text-muted',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-2 w-2 rounded-full', enabled ? 'bg-olive' : 'bg-muted')}
      />
      {enabled ? `${String(count)} no ar` : 'desligado'}
    </span>
  );
}

function ImageBadge({
  ad,
  imageMode,
}: {
  readonly ad: Advertisement;
  readonly imageMode: 'stored' | 'url';
}) {
  // No modo `url` não há preparo nenhum: o cliente busca o
  // endereço na hora de desenhar. Um selo de "pendente" ali
  // ficaria pendente para sempre.
  if (imageMode === 'url') {
    return <CheckCircle2 aria-label="o cliente baixa" className="h-4 w-4 shrink-0 text-muted" />;
  }

  if (ad.imageStatus === 'ready') {
    return <CheckCircle2 aria-label="imagem pronta" className="h-4 w-4 shrink-0 text-olive" />;
  }

  if (ad.imageStatus === 'error') {
    return <AlertTriangle aria-label="imagem com erro" className="h-4 w-4 shrink-0 text-rust" />;
  }

  return <Loader2 aria-label="imagem pendente" className="h-4 w-4 shrink-0 text-muted" />;
}

/**
 * Os nove pontos da tela, como uma grade clicável.
 *
 * ####  UMA LISTA SUSPENSA NAO SERVIA AQUI  ####
 *
 * "middle-right" é uma palavra; o quadradinho à direita no meio é
 * o lugar. A grade mostra a tela inteira e onde o logo vai cair —
 * que é exatamente a pergunta que se faz ao escolher.
 */
function AnchorPicker({
  value,
  onChange,
}: {
  readonly value: AdLogoAnchor;
  readonly onChange: (value: AdLogoAnchor) => void;
}) {
  return (
    <div className="space-y-1">
      <Label>Onde o logo fica</Label>
      <div
        role="radiogroup"
        aria-label="Posição do logo na tela"
        className="grid aspect-[16/9] w-full max-w-[220px] grid-cols-3 grid-rows-3 gap-px border border-border bg-border"
      >
        {AD_LOGO_ANCHORS.map((anchor) => {
          const active = anchor === value;

          return (
            <button
              key={anchor}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={anchor}
              title={anchor}
              onClick={() => {
                onChange(anchor);
              }}
              className={cn(
                'flex items-center justify-center bg-surface-2 transition-colors',
                active ? 'bg-amber' : 'hover:bg-surface',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  active ? 'bg-background' : 'bg-muted',
                )}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface AudienceList {
  readonly available: boolean;
  readonly groups: readonly string[];
  readonly permissions: readonly string[];
}

/**
 * Quem vê: um grupo, uma permissão, ou todo mundo.
 *
 * ####  ESCOLHER DA LISTA, E NAO DIGITAR  ####
 *
 * Um nome digitado errado (`vips` em vez de `vip`) não dá erro
 * nenhum: a propaganda simplesmente não aparece para ninguém — e
 * isso é indistinguível de "ainda não chegou a hora dela".
 *
 * A lista vem do Oxide do servidor. Sem RCON (ou com um plugin
 * antigo) ela chega vazia, e aí o campo volta a ser texto livre:
 * pior, mas não impede o trabalho.
 *
 * ####  GRUPO E PERMISSAO NO MESMO CAMPO  ####
 *
 * São coisas diferentes no Oxide, e quem administra não pensa
 * nessa diferença — pensa em "mostrar para o VIP". O plugin
 * resolve as duas (ver `AdsAllows`), então a tela não precisa
 * obrigar ninguém a saber em qual família o nome cai. Os grupos
 * vêm primeiro porque são o caso comum.
 */
function AudienceField({
  label,
  value,
  audience,
  onChange,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly audience: AudienceList;
  readonly onChange: (value: string | null) => void;
}) {
  const [custom, setCustom] = useState(false);

  // O valor gravado sumiu da lista (o grupo foi apagado no
  // servidor, ou veio de outro lugar). Mostrá-lo como opção
  // extra é o que impede o campo de "corrigir" sozinho para
  // "todo mundo" — o que abriria a propaganda para todos sem
  // ninguém pedir.
  const known = [...audience.groups, ...audience.permissions];
  const orphan = value !== null && !known.includes(value);

  if (!audience.available || custom) {
    return (
      <Field
        label={label}
        hint={
          audience.available
            ? 'Digitando à mão: confira o nome, ele não é validado.'
            : 'Sem contato com o servidor — a lista de grupos não pôde ser lida.'
        }
      >
        <div className="flex items-center gap-1">
          <Input
            defaultValue={value ?? ''}
            placeholder="todo mundo"
            onBlur={(event) => {
              const next = event.target.value.trim();
              onChange(next === '' ? null : next);
            }}
          />
          {audience.available && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCustom(false);
              }}
            >
              Lista
            </Button>
          )}
        </div>
      </Field>
    );
  }

  return (
    <Field label={label} hint="Vazio = todo mundo vê.">
      <div className="flex items-center gap-1">
        <select
          value={value ?? ''}
          onChange={(event) => {
            onChange(event.target.value === '' ? null : event.target.value);
          }}
          className="h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
        >
          <option value="">Todo mundo</option>

          {orphan && <option value={value}>{value} (não existe mais)</option>}

          {audience.groups.length > 0 && (
            <optgroup label="Grupos">
              {audience.groups.map((group) => (
                <option key={`g:${group}`} value={group}>
                  {group}
                </option>
              ))}
            </optgroup>
          )}

          {audience.permissions.length > 0 && (
            <optgroup label="Permissões">
              {audience.permissions.map((permission) => (
                <option key={`p:${permission}`} value={permission}>
                  {permission}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        <Button
          variant="ghost"
          size="sm"
          title="Digitar à mão"
          onClick={() => {
            setCustom(true);
          }}
        >
          ✎
        </Button>
      </div>
    </Field>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      {label !== '' && <Label>{label}</Label>}
      {children}
      {hint !== undefined && <p className="text-2xs text-muted">{hint}</p>}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          // NaN vira o mínimo: um campo vazio no meio da digitação
          // não pode virar `NaN` no rascunho e viajar assim para o
          // agente.
          onChange(Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min);
        }}
      />
    </Field>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="font-condensed text-2xs font-bold text-foreground">{format(value)}</span>
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
        className="w-full accent-amber"
      />
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        className="h-4 w-4 accent-amber"
      />
      {label !== '' && (
        <span className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
          {label}
        </span>
      )}
    </label>
  );
}

/**
 * Cor em `#RRGGBBAA`.
 *
 * O `<input type=color>` do navegador NÃO tem alfa, e o alfa
 * importa aqui (o fundo do painel é translúcido de propósito).
 * Por isso são dois controles: o seletor cuida do RGB e o campo
 * de texto guarda o valor inteiro.
 */
function Color({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const rgb = value.slice(0, 7);
  const alpha = value.length >= 9 ? value.slice(7, 9) : 'FF';

  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={rgb}
          onChange={(event) => {
            onChange(`${event.target.value.toUpperCase()}${alpha}`);
          }}
          className="h-9 w-10 shrink-0 border border-border bg-surface-2"
        />
        <Input
          value={value}
          onChange={(event) => {
            const next = event.target.value.trim().toUpperCase();
            if (/^#[0-9A-F]{0,8}$/.test(next)) onChange(next);
          }}
        />
      </div>
    </Field>
  );
}

function IconButton({
  title,
  disabled,
  danger,
  onClick,
  children,
}: {
  readonly title: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 items-center justify-center border border-transparent text-muted',
        'hover:border-border hover:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-40',
        danger === true && 'hover:border-rust hover:text-rust',
      )}
    >
      {children}
    </button>
  );
}

/** "360x120" -> "3:1". Só para orientar quem escolhe a imagem. */
function ratioOf(width: number, height: number): string {
  if (height <= 0) return '—';

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);

  const w = width / divisor;
  const h = height / divisor;

  // Proporções feias (37:12) não ajudam ninguém: acima de duas
  // casas, o decimal diz mais.
  return w > 30 || h > 30 ? `${(width / height).toFixed(2)}:1` : `${String(w)}:${String(h)}`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR');
}
