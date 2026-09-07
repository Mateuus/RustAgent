'use client';

// ============================================================
//  O ícone de um item do jogo.
//
//  Sai de `public/item-icons/<shortname>.webp`, que é um pacote
//  GERADO — ver `scripts/build-item-icons.mjs`.
//
//  ####  ELE NÃO PODE VIR DA API, E ISSO FOI CONFERIDO  ####
//
//  Os ícones só existem na instalação do CLIENTE do Rust. O
//  servidor dedicado tem os `.json` dos ~1250 itens em
//  `Bundles/items` e NENHUM `.png` — o agente não teria de onde
//  servi-los. Uma rota que lesse o ícone do disco funcionaria na
//  máquina de quem tem o jogo instalado e devolveria 404 no VPS.
//
//  Por isso o pacote é gerado uma vez, versionado junto do painel
//  e viaja com o build. A consequência prática é que o caminho é
//  do PAINEL, e não do agente: quem serve o HTML serve o ícone.
//
//  ------------------------------------------------------------
//  ####  ÍCONE FALTANDO É NORMAL  ####
//
//  Alguns itens do catálogo não têm PNG no cliente
//  (`researchpaper`, `vehicle.chassis`, as prateleiras da base):
//  são itens internos que o jogo nunca desenha no inventário.
//
//  Por isso a falha é tratada como estado esperado, e não como
//  erro: o `onError` troca a imagem por um quadro neutro DO MESMO
//  TAMANHO. Sem isso a linha da tabela pularia de altura quando a
//  imagem não carregasse, e a tabela inteira dançaria durante a
//  rolagem.
// ============================================================

import { Package } from 'lucide-react';
import { useEffect, useState } from 'react';

import { iconUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Os tamanhos em uso, em pixels.
 *
 * Lista fechada em vez de número livre: o pacote é gerado a 64 px,
 * e pedir mais do que isso só entrega borrão. `sm` é a lista de um
 * autocomplete, `md` a tabela do catálogo, `lg` a linha de um
 * editor — onde o ícone é a confirmação visual do que foi
 * escolhido, e por isso é o maior dos três.
 */
const SIZES = { sm: 20, md: 28, lg: 40 } as const;

export type ItemIconSize = keyof typeof SIZES;

interface ItemIconProps {
  /** Shortname do item. Vazio = ainda não escolheram nada. */
  readonly shortname: string;
  readonly size?: ItemIconSize;
  /**
   * Nome do item, para o `alt`.
   *
   * Ausente = ícone DECORATIVO (`alt=""`), que é o certo quando o
   * nome do item já está escrito ao lado: um leitor de tela que
   * anunciasse "imagem: Assault Rifle, Assault Rifle" só faria a
   * lista demorar o dobro para ser ouvida.
   */
  readonly label?: string;
  readonly className?: string;
}

export function ItemIcon({ shortname, size = 'md', label, className }: ItemIconProps) {
  const [failed, setFailed] = useState(false);
  const pixels = SIZES[size];

  // O shortname muda enquanto se digita numa busca. Sem rearmar, o
  // primeiro item inexistente deixaria o quadro neutro no lugar
  // para sempre — inclusive depois de a pessoa digitar um item que
  // existe.
  useEffect(() => {
    setFailed(false);
  }, [shortname]);

  // O ícone é arte sobre fundo transparente: sem uma caixa atrás,
  // itens escuros (a maioria das armas) somem no fundo quase preto
  // do painel.
  const box = cn('shrink-0 border border-border bg-surface-2', className);

  if (shortname === '' || failed) {
    return (
      <span
        aria-hidden="true"
        className={cn(box, 'inline-flex items-center justify-center')}
        style={{ width: pixels, height: pixels }}
        title={shortname === '' ? undefined : `Sem ícone para ${shortname}`}
      >
        <Package className="h-1/2 w-1/2 text-muted" />
      </span>
    );
  }

  return (
    // `<img>`, e não o `<Image>` do Next: o otimizador dele não
    // existe num export estático, e o pacote já sai do build no
    // tamanho final. Um `<Image>` aqui só acrescentaria um passo
    // de build que não tem o que otimizar.
    <img
      // `encodeURIComponent` não é zelo: alguns shortnames do Rust
      // têm ESPAÇO no nome ("2module car", "mini fridge"), e o
      // arquivo no disco também.
      src={`/item-icons/${encodeURIComponent(shortname)}.webp`}
      alt={label ?? ''}
      width={pixels}
      height={pixels}
      // A tabela do catálogo desenha dezenas de linhas por página;
      // `lazy` faz o navegador só baixar o que entrou na tela.
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => {
        setFailed(true);
      }}
      className={cn(box, 'object-contain')}
      style={{ width: pixels, height: pixels }}
    />
  );
}

// ============================================================
//  ####  O ÍCONE DE UM ITEM NOSSO VEM DO AGENTE  ####
//
//  O de um item do jogo é um arquivo do PAINEL, gerado uma vez e
//  versionado (ver o cabeçalho). O nosso é o oposto: ele foi
//  ENVIADO no cadastro, mora em `Assets\items\` na máquina do
//  agente, e chega à tela pela rota `/api/custom-items/icons/:name`.
//
//  Por isso ele precisa de um componente próprio, e não de mais
//  uma prop no `ItemIcon`: a origem do arquivo é outra, e o
//  fallback também — quando o item nosso não tem arte própria
//  (`iconFile` nulo, que é o caso do Troféu hoje), o que se
//  desenha é o ícone do CORPO EMPRESTADO, porque é ele que o
//  jogador vê no inventário enquanto a arte não sobe.
// ============================================================

interface CustomItemIconProps {
  /** O PNG enviado no cadastro. `null` = usa o do corpo. */
  readonly iconFile: string | null;
  /** O corpo emprestado, que é o fallback. */
  readonly baseShortname: string;
  readonly size?: ItemIconSize;
  readonly label?: string;
  readonly className?: string;
}

export function CustomItemIcon({
  iconFile,
  baseShortname,
  size = 'md',
  label,
  className,
}: CustomItemIconProps) {
  const [failed, setFailed] = useState(false);
  const pixels = SIZES[size];

  // Mesmo motivo do `ItemIcon`: o cadastro pode trocar o arquivo
  // debaixo do componente, e um `failed` grudado deixaria o
  // fallback no lugar mesmo depois de a arte nova subir.
  useEffect(() => {
    setFailed(false);
  }, [iconFile]);

  if (iconFile === null || failed) {
    return (
      <ItemIcon
        shortname={baseShortname}
        size={size}
        {...(label === undefined ? {} : { label })}
        className={className}
      />
    );
  }

  return (
    // `<img>` cru: a imagem vem do AGENTE, e o otimizador do Next
    // não existe num export estático.
    <img
      src={iconUrl(iconFile)}
      alt={label ?? ''}
      width={pixels}
      height={pixels}
      loading="lazy"
      decoding="async"
      draggable={false}
      // O PNG pode ter sido apagado do disco por fora do painel.
      // Cair para o ícone do corpo é melhor do que um retângulo
      // quebrado no meio de uma lista de escolha.
      onError={() => {
        setFailed(true);
      }}
      className={cn('shrink-0 border border-border bg-surface-2 object-contain', className)}
      style={{ width: pixels, height: pixels }}
    />
  );
}
