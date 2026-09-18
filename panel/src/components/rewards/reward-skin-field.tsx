'use client';

// ============================================================
//  reward-skin-field.tsx  -  a skin que a recompensa dá, escolhida
//  no catálogo.
//
//  ####  O QUE FICA GRAVADO É A MARCA, E NÃO O ID  ####
//
//  `workshop_skins.id` é desta máquina: a mesma skin tem outro
//  número em outro agente, e o cadastro que veio do painel não nasce
//  com o número do que veio do jogo. O par `(shortname, skinId)` é o
//  mesmo em toda parte — é por ele que a entrega do site e o
//  `/skin give` acham a skin.
//
//  Então a lista é escolhida por id (é o que o seletor da aba Posse
//  já faz) e o que sai daqui é a MARCA da escolhida.
//
//  ####  O SELETOR É O DA ABA POSSE  ####
//
//  `SkinCatalogPicker` já agrupa por item, busca por nome, item ou
//  Workshop ID e mostra a raridade. Uma segunda lista aqui
//  divergiria dele no primeiro campo novo do cadastro.
//
//  ####  O CATÁLOGO É LIDO UMA VEZ, E NÃO UMA POR RECOMPENSA  ####
//
//  Uma missão pode prometer duas skins, e o editor monta um campo
//  por recompensa. Sem cache, abrir a missão dispararia a mesma
//  requisição duas vezes. É o mesmo cache de módulo do
//  `use-custom-items`, com a mesma validade curta — e, como lá,
//  falha não fica guardada.
// ============================================================

import { Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { messageOf, safeSkin } from '@/components/workshop/normalize';
import { RarityBadge, SkinCatalogPicker, SkinThumb } from '@/components/workshop/owned-parts';
import { agent, type WorkshopSkin } from '@/lib/api';

/** Quanto tempo a lista lida vale. O mesmo minuto do `use-custom-items`. */
const TTL_MS = 60_000;

interface Cached {
  readonly at: number;
  readonly skins: Promise<readonly WorkshopSkin[]>;
}

let cache: Cached | null = null;

function loadWorkshopSkins(): Promise<readonly WorkshopSkin[]> {
  const now = Date.now();

  if (cache !== null && now - cache.at < TTL_MS) {
    return cache.skins;
  }

  const skins = agent
    .workshopSkins()
    .then((response) => (Array.isArray(response.skins) ? response.skins : []).map(safeSkin))
    .catch((cause: unknown) => {
      // Erro não fica guardado: senão o campo ficaria sem catálogo
      // até o minuto virar, mesmo depois de a rede voltar.
      cache = null;

      throw cause instanceof Error ? cause : new Error(String(cause));
    });

  cache = { at: now, skins };

  return skins;
}

export interface RewardSkinFieldProps {
  /** O item base da marca. Vazio = nada escolhido ainda. */
  readonly shortname: string;
  /** O Workshop ID. TEXTO: ele passa de 2^53. */
  readonly skinId: string;
  readonly onChange: (mark: { readonly shortname: string; readonly skinId: string }) => void;
}

export function RewardSkinField({ shortname, skinId, onChange }: RewardSkinFieldProps) {
  const [skins, setSkins] = useState<readonly WorkshopSkin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Nasce escolhendo quando não há marca, e vira o cartão assim que
  // houver. Trocar volta para a lista — é o padrão do campo de item.
  const [searching, setSearching] = useState(shortname === '');

  useEffect(() => {
    let alive = true;

    void loadWorkshopSkins()
      .then((list) => {
        if (alive) {
          setSkins(list);
          setLoaded(true);
        }
      })
      .catch((cause: unknown) => {
        if (alive) {
          setError(messageOf(cause));
          setLoaded(true);
        }
      });

    return () => {
      // O editor pode fechar antes de a lista chegar.
      alive = false;
    };
  }, []);

  const chosen =
    skins.find((skin) => skin.shortname === shortname && skin.skinId === skinId) ?? null;

  if (searching || shortname === '') {
    return (
      <div className="space-y-2">
        {error !== null && (
          <p className="text-2xs text-rust">Não deu para ler o catálogo de skins: {error}</p>
        )}

        <SkinCatalogPicker
          skins={skins}
          selected={chosen === null ? [] : [chosen.id]}
          multiple={false}
          onChange={(ids) => {
            const picked = skins.find((skin) => skin.id === ids[0]) ?? null;

            if (picked === null) {
              return;
            }

            // ####  SAI A MARCA, E NUNCA O `id`  ####
            //
            // Ver o cabeçalho: o id é desta máquina.
            onChange({ shortname: picked.shortname, skinId: picked.skinId });
            setSearching(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 border border-border bg-surface-2 p-2">
      <SkinThumb previewUrl={chosen?.previewUrl ?? null} shortname={shortname} />

      <div className="min-w-0 flex-1 text-2xs leading-relaxed">
        <p className="flex items-center gap-2">
          <span className="truncate font-condensed font-bold uppercase tracking-wide text-foreground">
            {chosen?.label ?? shortname}
          </span>
          <RarityBadge rarity={chosen?.rarity ?? null} />
        </p>

        <p className="truncate font-mono text-muted">
          {shortname} · skin {skinId}
        </p>

        {/* A skin saiu do catálogo depois de a recompensa ter sido
            salva. O agente vai recusar a entrega com essa mesma
            explicação, e é melhor descobrir aqui. Só depois de a
            lista chegar: enquanto ela não chega, ninguém sabe. */}
        {loaded && error === null && chosen === null && (
          <p className="text-rust">Esta skin não está mais no catálogo.</p>
        )}
      </div>

      <Button
        size="sm"
        variant="outline"
        type="button"
        title="Escolher outra skin"
        onClick={() => setSearching(true)}
      >
        <Pencil className="mr-1 h-3 w-3" />
        Trocar
      </Button>
    </div>
  );
}
