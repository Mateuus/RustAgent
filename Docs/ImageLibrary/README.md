# ImageLibrary — o que aproveitamos, e o que não

`ImageLibrary.cs` nesta pasta é o **2.0.67** de Absolut & K1lly0u, sem uma linha
editada. Ele estava em `Plugins\` e saiu de lá em 11/09/2026: fica aqui como
**referência**, e não como plugin. O nosso equivalente é o
`Plugins\OrigemZImages.cs`.

Ele só volta a ser instalado se um plugin de terceiro o exigir (o
`Docs\RemoverTools Plugin\RemoverTool.cs` o usa como opcional, para a UI dele).
Os dois convivem sem conflito: gravam no mesmo `FileStorage`, o CRC sai do
conteúdo, e cada um guarda o próprio mapa de nomes.

## A entrega ao cliente é a mesma

A pergunta de partida era se ele passa imagem ao cliente de um jeito melhor que
o nosso. Não passa. As duas linhas que importam são idênticas:

| | chamada |
|---|---|
| ImageLibrary (`ImageLibrary.cs:1197`) | `FileStorage.server.Store(bytes, FileStorage.Type.png, CommunityEntity.ServerInstance.net.ID)` |
| nós (`OrigemZImages.cs`, `CmdEnd`) | a mesma |

Nos dois casos o CUI recebe o CRC no campo `png` (ou o item o recebe em
`iconImageId`), e o cliente pede os bytes pelo canal do jogo na primeira vez
que vê aquele número. O `GetImage` dele devolve esse CRC como texto. O que ele
acrescenta é um **baixador de URL** e um **registro de nomes**.

## O que veio para o OrigemZImages

| Ideia dele | Como ficou aqui |
|---|---|
| Um plugin dono das imagens, que os outros consultam (`Call("GetImage")`) | `OrigemZImages` com `GetImage`/`HasImage`/`GetApiVersion`. OrigemZUI e OrigemZItems perderam o armazenamento próprio |
| Mapa salvo em `oxide\data`, conferido pelo id da `CommunityEntity` | Igual. Um `oxide.reload` não perde mais as imagens. Com outro id, a tabela é descartada e o agente reenvia — não lemos o banco do save anterior por SQLite, porque o agente tem os originais |
| `HasImage` antes de baixar | Virou protocolo: `origemz.image.list` devolve chave → sha256, e o agente manda só o que falta ou mudou |
| `callback` quando a imagem fica pronta | O hook `OnOrigemZImageStored(key, crc)`. O OrigemZItems o usa para vestir o ícone novo em quem está online |
| Teto de 3 MiB por imagem (limite de transferência do FileStorage) | O mesmo número, conferido no agente e no plugin |

## O que ficou de fora, de propósito

- **Baixar URL de dentro do servidor.** Quem baixa e confere é o agente, que tem
  timeout, teto e teste. Ele baixa com `UnityWebRequest` **sem timeout**, um de
  cada vez (`ImageLibrary.cs:1151`).
- **Recodificar tudo em PNG** (`ImageLibrary.cs:1167-1172`). Incha o JPEG que
  cada jogador baixa e decodifica na thread principal do servidor.
- **CDN de terceiro**: imgur para as imagens de carregando/nenhuma (`:151-152`),
  um JSON no GitHub de outra pessoa (`:266`), `cdn.rusthelp.com` para ícone de
  item (`:1266`) e a API da Steam. Ícone de item do jogo o CUI já desenha por
  `itemid`/`skinid`, dos assets do próprio cliente, sem download nenhum.
- **Comandos de console chamados `yes` e `no`** (`:1004`, `:1020`).

## Defeitos que achamos lendo o código

1. **A fila trava para sempre.** Se o download volta sem dados, o ramo de
   `ImageLibrary.cs:1165` não chama `Next()`; o `orderPending` fica preso e todo
   `AddImage` de qualquer plugin para de andar.
2. **Falha que parece sucesso.** O retorno de `texture.LoadImage` é ignorado
   (`:1168`): uma página de erro em HTML vira "imagem" com CRC válido. O
   OrigemZImages confere a assinatura PNG/JPEG antes de guardar.

## O pré-envio: a ideia dele, por outro caminho

O `SendImage` dele (`ImageLibrary.cs:549`) empurra os bytes ao cliente pelo RPC
`CL_ReceiveFilePng` **antes** de a UI abrir, para a imagem não entrar vazia na
primeira exibição. O problema é real também no nosso modo `stored`: com `png`, o
cliente procura o CRC no cache dele, não acha na primeira vez, pede ao servidor —
e a propaganda já está na tela enquanto os bytes viajam.

**Resolvemos pedindo, e não empurrando.** O `AdsPreload` do `OrigemZUI` já
desenhava, junto com o logo, um pixel 1×1 transparente por propaganda para o modo
`url`; agora ele faz o mesmo no `stored`, com `png` no lugar de `url`. O pedido
sai durante os minutos de repouso, e quando o painel abre a textura já está lá.

Duas razões para não copiar o `SendImage`:

- ele usa `ClientRPCStart`/`ClientRPCSend`, **API interna do Rust** que já mudou
  uma vez — o próprio arquivo guarda a versão antiga comentada em `:560-564`;
- ele manda o arquivo **inteiro a cada chamada**, mesmo para quem já o tem. Uma
  propaganda de 575 KB viraria 575 KB por jogador a cada conexão. O pedido do
  cliente só acontece quando o cache dele não tem.

O que fica de fora: o modo PARADO (`staticMode`), onde a propaganda é desenhada no
mesmo instante do logo e não há repouso a adiantar; e os ícones do menu, que têm
17 KB e não chegam a piscar.

**Não medido:** o efeito na tela, que exige um cliente conectado. O que dá para
afirmar é o que o código faz.

## O protocolo do OrigemZImages

| Comando | Resposta |
|---|---|
| `origemz.image.begin <chave> <partes> <bytes> <sha256>` | `{"ok":true}` |
| `origemz.image.part <chave> <índice> <base64>` | `{"ok":true}` |
| `origemz.image.end <chave>` | `{"ok":true,"crc":N}` |
| `origemz.image.list` | `{"ok":true,"ready":true,"images":{"chave":"sha256"}}` |
| `origemz.image.forget <chave>\|*` | `{"ok":true,"forgotten":N}` — esquece o mapa, não os bytes |

Chaves em uso: o nome do arquivo de `Assets\ui` (`ozcoin`), `ad` + 12 dígitos do
sha para as propagandas, e `item.<id>` para os ícones de item custom. O lado do
agente é `core/src/game/image-library.ts`.
