# OrigemZWorkshop — caixa, coleções e acessos

**Substitui o §6 do [00-LEVANTAMENTO.md](00-LEVANTAMENTO.md).** Na manhã de 16/09/2026 a
decisão era "o item já nasce com a skin". Na noite do mesmo dia o dono a revogou:

> "O sistema atual está incorreto. Os itens não devem nascer automaticamente com a skin."

O resto do levantamento (o que o jogo dá, o modo streamer, a arte no Workshop) continua
valendo. Este documento é para quem vai operar, testar ou mexer no módulo.

---

## 1. Os dois setores

```text
  CADASTRO                                   APLICAÇÃO
  ─────────                                  ─────────
  painel /workshop  ─┐                       /skin          → caixa virtual
                     ├─→ banco do agente     /skin <coleção> → pinta o que veste
  /skin add (jogo) ──┘   (uma tabela só)            ↑
                              │                     │
                              └── origemz.workshop.sync ──→ OrigemZWorkshop.cs
```

Os dois caminhos de cadastro chamam **o mesmo código** (`core/src/game/workshop-catalog.ts`):
mesma conferência de item, de duplicado e da Steam, mesma linha no registro. O plugin nunca
grava uma skin sozinho — a cópia dele só muda quando a carga volta do agente.

## 2. O cadastro

### Pelo jogo

```text
/skin add "metal.facemask" "3802433262"
```

Exige `origemzworkshop.admin` (ou ser admin do servidor). O plugin confere na hora:

| Conferência | Onde |
|---|---|
| o item existe | `ItemManager.FindItemDefinition` |
| não é variante de redirect | `ItemDefinition.isRedirectOf` |
| o item aceita skin do Workshop | `Skinnable.All` — **só se a lista do jogo for confiável** (ver §7) |
| é um workshop id (não zero, sem zero à esquerda, não é id de inventário Steam) | `ItemSkinDirectory.FindByInventoryDefinitionId` |
| a marca (item + id) ainda não está no catálogo | a cópia local |
| o agente está conectado | o segredo do último `sync` |

Depois manda `#OZWORKSHOP#{"kind":"add",…}` ao agente, que:

1. confere o id na Steam (`GetPublishedFileDetails`, sem chave de API);
2. recusa id inexistente, de outro jogo, banido, ou publicado para **outro item** (a tag da
   Steam é o nome do item em inglês — "Metal Facemask");
3. grava com `source = game`, **só no servidor de onde veio**, sem permissão, sem coleção;
4. responde no chat do admin pelo `origemz.workshop.reply` e reenvia a carga.

O nome da skin é o título publicado no Workshop. Sem resposta em 20 s, o plugin avisa o
admin para conferir no painel antes de repetir.

### Pelo painel

Os mesmos campos, mais os que o jogo não pergunta: nome, permissão, coleção, "liberada para
todos", esconder no modo streamer, ligada, servidores. O Workshop ID é consultado enquanto se
digita (`GET /api/workshop/lookup/:id`), que mostra a prévia e sugere o item.

**Steam fora do ar não barra o cadastro.** A linha entra e o aviso vai para a tela e para o
registro.

## 3. A aplicação

### A caixa — `/skin`

Abre um painel de loot com **um slot**. Só entra item que tenha ao menos uma skin que aquele
jogador pode usar. Ao lado, uma grade com o ícone de cada skin (o cliente desenha a arte a
partir do par item + skin), paginada de 15 em 15, e o botão **Sem skin**.

**O item é o mesmo objeto do começo ao fim.** O plugin troca `item.skin` no lugar, com as
quatro linhas do `RepairBench.ApplySkinToItem` da vanilla. Nada é criado, nada é destruído —
quantidade, condição, munição, pente e acessórios continuam onde estavam. É isso que torna
duplicação impossível por construção.

O item volta ao jogador em **todo** caminho de fechamento:

| Caminho | Quem pega |
|---|---|
| fechou o painel | `OnPlayerLootEnd` |
| morreu | `OnPlayerDeath` — antes do cadáver, então o item cai com a mochila |
| caiu ferido | `OnPlayerWound` |
| desconectou | `OnPlayerDisconnected` — vai para a mochila do corpo dormindo |
| plugin descarregado / servidor desligando | `Unload` |
| qualquer outro | o relógio de 1 s que confere se o container ainda está no loot |

Mochila cheia: o item cai aos pés do jogador, com aviso. O container só é destruído
comprovadamente vazio — `ItemContainer.Kill()` termina num `Clear()` que **apaga** o que
estiver dentro (medido no decompilado).

### As coleções — `/skin neve`

A coleção é um mapa `item → skin` com um nome de comando. O plugin percorre o que o jogador
**veste e a barra de atalhos** (uma coleção pode ter arma), pinta o que casa e responde:

```text
Neve 2026: 3 itens alterados. 1 já estava com a skin.
```

Uma skin mora em **uma** coleção, e dentro de cada coleção cabe **uma skin por item** (índice
único no banco). Nomes reservados: `add`, `adicionar`, `ajuda`, `help`, `lista`, `list`,
`caixa`, `box`. `/skin ajuda` lista as coleções que o jogador pode usar.

## 4. Quem pode usar

Qualquer um destes libera — é um **OU**:

1. a skin, ou a coleção dela, está **liberada para todos**;
2. o jogador tem a **permissão** da skin, ou a da coleção dela;
3. existe um **acesso** vivo para ele, ou para um **grupo Oxide** dele, na skin ou na coleção;
4. ele tem `origemzworkshop.admin`.

Liberar uma coleção libera todas as skins dela, tanto na caixa quanto no `/skin <coleção>`.

A permissão é opcional e **não é única**: `origemzworkshop.vip` pode liberar vinte skins. O
plugin registra cada permissão quando a carga desce.

### Acessos individuais

Na aba **Acessos**: buscar jogador por nome ou SteamID64 (ou escolher um grupo do Oxide),
liberar skin ou coleção, com prazo (1, 7, 30, 90 dias, data livre) ou permanente, e remover.

- Liberar de novo o mesmo alvo **renova** o prazo — não cria uma segunda linha.
- O prazo é conferido **no plugin, na hora**. O agente também reenvia a carga quando um
  acesso vence e registra o vencimento — inclusive o que venceu com o agente desligado.
- Acesso por grupo usa a membership do Oxide **naquele servidor**.

**Acesso removido ou vencido não despinta o que já foi pintado.** O item pode estar numa caixa
do outro lado do mapa, e seguir item pelo mundo não cabe nesta feature. Daí em diante o
jogador só não consegue pintar de novo.

## 5. O registro

Toda mudança de catálogo, coleção e acesso vira uma linha em `workshop_audit`, com quem fez
(usuário do painel, `jogo:<nome> (<steamId>)` ou `sistema`), de onde, o alvo em texto e o
detalhe. Também entram os cadastros recusados pelo jogo. A aba **Registro** filtra por
SteamID64.

Não entram as aplicações de skin pelo jogador (caixa e coleção) — são ações de uso, não de
configuração, e aconteceriam milhares de vezes por dia.

## 6. Sincronia e reinício

| Quem | Onde guarda | Sobrevive a reinício? |
|---|---|---|
| agente | SQLite, migrações **095** e **096** | sim — é a fonte |
| plugin | `oxide/data/OrigemZWorkshop/cache.json` | sim — cópia, reescrita inteira a cada carga, sem o segredo |

A carga desce **inteira** (nunca delta) a cada boot, reconexão de RCON, `ready` do plugin,
mudança no painel, `/streamer` e vencimento de acesso. Passando de 40 KB, desce em pedaços:

```text
origemz.workshop.sync <lote> <i> <n> <pedaço base64>
```

O plugin só troca o catálogo quando o último pedaço chega; lote incompleto é descartado e a
carga anterior continua inteira.

O cache existe para o servidor que reinicia com o agente fora do ar continuar com a caixa
funcionando. Ele não é editável e não diverge: qualquer carga nova o substitui.

## 7. O que não foi medido

- **A posição da grade na tela.** Ela está ancorada no pé da tela, centro, com deslocamento
  para a coluna do painel de loot (`OffsetMin "192 118"`, `OffsetMax "572 470"`). Estimado,
  não visto no cliente. Se encavalar, é só esse par de números em `DrawBox`.
- **A camada `Overlay` acima do painel de loot aberto.** É o que os plugins de loot usam, mas
  não foi conferido neste cliente — quem resolve a camada é o cliente, e o servidor não tem
  como ver (ver o comentário de `UI_LAYERS` em `core/src/types/ui-document.ts`).
- **O cliente desenhar a arte.** Depende de a skin estar publicada e de o cliente baixá-la —
  o servidor só manda o número.

### Medido ao vivo no server01 (16/09/2026)

- o plugin compila e carrega no Oxide do servidor;
- `Skinnable.All` casa com **160** shortnames; `metal.facemask`, `rifle.ak`, `rock`, `hoodie` e
  `hatchet` aceitam skin do Workshop, `stones` não;
- cadastro pelo painel com a Steam de verdade: o 3802433262 entrou como
  "MetalFacemaskOrigemZ", foi recusado no `hatchet` (`WORKSHOP_OTHER_ITEM`), e o id `1` foi
  recusado (`WORKSHOP_NOT_FOUND`);
- carga com 1502 acessos desceu em **6 pedaços** (211 KB) e o plugin confirmou os 1502;
- `oxide.reload` do plugin: a cópia em disco foi lida antes de o agente reenviar.

Não testado ao vivo, por falta de um jogador conectado: a caixa, o `/skin <coleção>` e o
`/skin add` digitado no chat. Os três estão cobertos pelos testes do agente só do lado dele.

## 8. Onde está cada coisa

| Camada | Arquivo |
|---|---|
| Plugin | `Plugins/OrigemZWorkshop.cs` |
| Contrato | `core/src/types/workshop.ts` |
| Migrações | `core/src/db/migrations.ts` — 095 e 096 |
| Catálogo e coleções | `core/src/db/workshop-repository.ts` |
| Acessos e registro | `core/src/db/workshop-access-repository.ts` |
| Regras de cadastro | `core/src/game/workshop-catalog.ts` |
| Consulta à Steam | `core/src/game/steam-workshop.ts` |
| Carga, `/skin add`, vencimento | `core/src/game/workshop.ts` |
| Rotas | `core/src/http/routes/workshop.ts` |
| Testes | `core/test/workshop.test.ts` |
| Painel | `panel/src/app/workshop/page.tsx`, `panel/src/components/workshop/` |

O `OrigemZPlayer` **não** consulta mais o catálogo ao montar o kit: o hook `GetWorkshopSkin`
foi removido junto com o carimbo no nascimento.
