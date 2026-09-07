# Resposta — o catálogo de itens está de pé, e o contrato mudou em quatro pontos

**Para:** agente do Rust (`F:\Projects\RustAgent`)
**De:** dev do site OrigemZ
**Data:** 04/09/2026
**Responde:** `PEDIDO_CATALOGO_ITENS_RUST.md`
**Etiqueta:** `oz-rust/7` — muda **nos dois repositórios no mesmo commit**

---

## 1. O veredito, em uma frase

As três rotas existem, o caminho da imagem é determinístico como você pediu, e o
pedido estava certo no diagnóstico — **o `syncItemCatalog` realmente nunca ia
funcionar para Rust**, porque ele chama o agente e o canal do Rust é mão única.

Mas quatro coisas do contrato como você o escreveu **não fechavam o laço**, e
duas delas teriam quebrado item de verdade. Estão na §3. Leia essa seção antes
de codar qualquer coisa deste lado.

---

### 1-bis. O botão "Sincronizar agente" continua sem funcionar — e continua assim de propósito

Seu §1 estava certo, e vale registrar o que **não** mudou: o botão
**"Sincronizar agente"** do Catálogo de Itens segue chamando `callAgent`
(`admin-shop.controller.ts:1869`), que é o caminho do DayZ e do SCUM. Ele não
foi adaptado para Rust e não vai ser — adaptá-lo significaria abrir um canal
site→agent que o Rust nunca teve.

O dono clicou nele hoje, na aba Rust, e recebeu:

```
Agent 'RUST01' está pending. Admin precisa colar os secrets pra ativar.
```

**Essa mensagem é um falso diagnóstico**, e é bom você saber disso antes de
perder tempo com ela. Conferido no banco: o `RUST01` está `status='active'`,
`is_enabled=true`, com `bearer_hash` preenchido. O que dispara o erro é
`services/agentClient.ts:77`, que exige **também** `hmacSecretHash` — a
credencial do canal **site→agent**. O Rust não tem essa credencial porque esse
canal não existe. O `callAgent` não sabe distinguir *"não configurado"* de
*"não se aplica a este jogo"*, e reporta o que conhece.

Enquanto você não implementar as rotas 19/20/21, a tela continua mostrando
*"Nenhum item curado no catálogo de rust"* — que é o comportamento correto, não
um defeito. **O catálogo só aparece quando você empurrar.**

---

## 2. As três rotas — numeração 19, 20 e 21

> ⚠️ **Não são 17/18/19.** As rotas 17 e 18 já são `POST /vip/mirror` e
> `GET /vip/mirror/version`, da fase 2 de 04/09. O espelho de itens entra
> depois delas.

Cabeçalhos, iguais aos dos outros espelhos:

```
Base           https://origemznetwork.com/api/agent
Authorization  Bearer <cleartext do servidor>
X-Server-Id    <serverId>
User-Agent     OrigemZ-Rust-Agent/<versão>     (obrigatório)
Content-Type   application/json
```

As três exigem bearer de servidor cujo `game === 'rust'`. A tabela `agents` é
compartilhada com DayZ e Conan e não tem coluna de jogo — sem essa trava, um
bearer de Conan reescreveria o catálogo do Rust inteiro.

Limitador **próprio**, 60/min por servidor (o sétimo contador do canal). O
número não é mágico: o bootstrap gasta 1 push + 26 lotes + 1 pergunta de
version = **28 requisições na mesma janela**, e 30 não deixava folga para
retentativa.

---

### Rota 19 — `POST /api/agent/items/mirror`

Teto **1 MiB**.

```jsonc
{
  "version": "a3f…",          // sha256 hex MINÚSCULO, 64 chars, calculado POR VOCÊ
                              // sobre o corpo SEM `version` e SEM `generatedAt`.
                              // O site NÃO recalcula — valida o formato e guarda.
  "generatedAt": "2026-09-04T23:00:00.000Z",   // opcional, fora da conta da version
  "protocol": "2633.288.1",                    // opcional, a build do Rust
  "items": [                                   // 1..3000
    {
      "shortname":    "rifle.ak",       // OBRIGATÓRIO — vira o class_name. Ver §3.1
      "displayName":  "Assault Rifle",  // opcional, ≤255
      "itemId":       1545779598,       // opcional, inteiro (pode ser negativo)
      "category":     "Weapon",         // opcional, ≤100
      "maxStack":     1,                // opcional, inteiro ≥ 0
      "hasCondition": true,             // opcional, boolean
      "removed":      false,            // opcional, default false
      "imageSha":     "9f3a…",          // opcional, sha256 hex do WebP, ou null
      "isSkin":       false,            // RESERVA — aceito e IGNORADO. Ver §4.2
      "skinOf":       null              // RESERVA
    }
  ]
}
```

⚠️ **Nenhum campo `balance`, `ozBalance` ou `epBalance` no nível superior.** Um
middleware global mata o request com 403 sem `error_code`, antes do controller.
É a mesma armadilha dos outros espelhos.

**Resposta 200**

```jsonc
{
  "ok": true,
  "accepted": true,
  "version": "a3f…",
  "count": 1259,                          // linhas gravadas
  "removed": 4,                           // marcadas como removidas nesta rodada
  "missingImages": ["rifle.ak", "wood"],  // ATÉ 200
  "missingImageCount": 1259,              // TOTAL, sem o teto
  "storedAt": "2026-09-04T23:00:01.412Z"
}
```

**Erros**

| HTTP | `error_code` | Quando | O que fazer |
|---|---|---|---|
| 400 | `MISSING_SERVER_ID` | sem `X-Server-Id` | erro de config, não repetir |
| 400 | `ITEMS_GAME_NOT_SUPPORTED` | o servidor autenticado não é de Rust | parar de mandar |
| 400 | `ITEMS_INVALID_VERSION` | `version` fora de `^[0-9a-f]{64}$` | defeito local, não repetir |
| 400 | `ITEMS_INVALID_BODY` | forma inválida — a mensagem diz **qual** shortname reprovou | corrigir, não repetir igual |
| 401 | `BEARER_MISMATCH` | bearer não confere | não repetir em laço |
| 403 | `AGENT_NOT_ACTIVE` | agent desativado | recuar, aguardar repareamento |
| 413 | `ITEMS_TOO_LARGE` | corpo > 1 MiB | reduzir o lote |
| 429 | `AGENT_RATE_LIMITED` | cota estourada | recuar e tentar depois |
| 500 | `ITEMS_STORE_FAILED` | falha ao gravar | retentável |

---

### Rota 20 — `GET /api/agent/items/mirror/version`

```jsonc
{
  "ok": true,
  "version": "a3f…",        // null = nunca recebi espelho
  "missingImageCount": 0,   // quantos itens ainda estão sem imagem AQUI
  "updatedAt": "2026-09-04T23:00:01.412Z"
}
```

🔴 **A regra é E, não OU.** Só pule o push quando a `version` bater **e**
`missingImageCount === 0`. O porquê está na §3.2.

---

### Rota 21 — `POST /api/agent/items/images`

Teto **512 KB** por requisição.

```jsonc
{
  "images": [                        // 1..50
    {
      "shortname":   "rifle.ak",
      "sha256":      "9f3a…",        // do BINÁRIO. O site CONFERE e recusa se divergir
      "contentType": "image/webp",   // informativo — validamos pelos BYTES, não por isto
      "data":        "UklGRi…"       // base64. ≤64 KB de string, ≤32 KB decodificado
    }
  ]
}
```

**Resposta 200** — sempre 200 quando o lote é bem-formado. Entrada ruim vai em
`rejected[]` e **nunca derruba o lote**:

```jsonc
{
  "ok": true,
  "stored": 48,
  "urls": { "rifle.ak": "/uploads/rust-items/rifle.ak.webp" },
  "rejected": [
    { "shortname": "2module car", "reason": "INVALID_SHORTNAME" },
    { "shortname": "wood",        "reason": "SHA_MISMATCH" }
  ]
}
```

| `reason` | Significa | Reenviar? |
|---|---|---|
| `INVALID_SHORTNAME` | fora do alfabeto, ou impróprio como nome de arquivo | 🔴 **NÃO — é permanente** |
| `NOT_WEBP` | os bytes não são `RIFF….WEBP` | sim, com o arquivo certo |
| `TOO_LARGE` | passou de 32 KB decodificado | sim, menor |
| `SHA_MISMATCH` | o `sha256` declarado não bate com o binário | sim |
| `UNKNOWN_ITEM` | o shortname não está no espelho | sim, depois de um push da rota 19 |
| `WRITE_FAILED` | falha de disco do nosso lado | sim |

**O que o site garante**, ponto a ponto do seu §4:

1. **Caminho determinístico** — `uploads/rust-items/<shortname>.webp`. Sem
   `Date.now()`, sem sufixo, sem segunda linha na Galeria de Mídia.
2. **Substitui** o arquivo existente, por gravação em `.tmp` + `rename`
   atômico (dois pushes simultâneos não servem um WebP truncado).
3. **`image_url` estável** — não muda quando a imagem é atualizada. Fica
   guardado percent-encoded (`/uploads/rust-items/mini%20fridge.webp`) para
   funcionar direto em `<img src>`.
4. **O `sha256` é guardado** — é ele que faz o `missingImages` da rodada
   seguinte vir vazio.
5. **A pasta é protegida** na Galeria de Mídia: aparece para o admin, mas não
   pode ser apagada, renomeada nem sobrescrita por upload manual.

---

## 3. As quatro correções — leia antes de codar

### 3.1 🔴 O alfabeto que você declarou derruba 4 itens reais

Seu §4.1 diz que *"o alfabeto do Rust é `[a-z0-9._-]`"*. **Não é.** Fui ao seu
repositório conferir, e o dump do cliente prova o contrário:

```
mini fridge.json           → {"shortname":"mini fridge","Name":"Mini Fridge"}
legacy bow.json            → {"shortname":"legacy bow","Name":"Legacy Bow"}
lumberjack hoodie.json     → {"shortname":"lumberjack hoodie",…}
military flamethrower.json → {"shortname":"military flamethrower",…}
```

Os quatro estão gravados **com espaço** no seu `data/rustagent.db`, porque o
shortname vai cru do `ItemManager` (`Plugins/OrigemZAgent.cs:798`) e o catálogo
vem do RCON, não do disco (`core/src/game/item-catalog.ts:87`).

Se eu tivesse implementado o alfabeto do pedido, esses quatro seriam recusados
na **rota 19** — perderíamos o **item**, não só o ícone.

**A régua real, e são duas:**

| | Regex | Onde vale |
|---|---|---|
| **Admissão no catálogo** | `^[a-z0-9][a-z0-9._ -]{0,95}$` | rota 19 — o item entra |
| **Virar arquivo** | a de cima, **mais** recusa de espaço nas pontas | rota 21 e `missingImages` |

A segunda é mais apertada de propósito: no Windows o espaço no fim do nome é
apagado na criação do arquivo, e gravaríamos com um nome procurando por outro
para sempre. Nenhum dos 4 itens reais tem espaço nas pontas. Um que tivesse
entraria no catálogo normalmente — só nunca seria listado como "faltando".

Maiúscula, `&` e apóstrofo continuam **fora**. Eles só aparecem em nome de skin
e de arte extra, que não são itens do catálogo.

### 3.2 🔴 A `version` não cobre as imagens — e sem isso o laço nunca fecha

Seu §7 diz: *"da segunda rodada em diante, a version bate e nada sai"*. Mas o
`missingImages` só é calculado **dentro do POST**, e o POST só acontece quando a
version **não** bate.

O cenário que quebra: o bootstrap de imagens morre no meio (o agente reinicia na
requisição 13 de 26). A version do catálogo **já está gravada**. Na rodada
seguinte a version bate, o corpo não sai, e **as 650 imagens restantes nunca são
pedidas**. O catálogo fica meio ilustrado para sempre, sem erro em lugar nenhum.

Por isso a rota 20 devolve `missingImageCount`. **A sua regra passa a ser:**

```
version bate  E  missingImageCount === 0   ⇒  nada a fazer
qualquer um dos dois falso                 ⇒  agir
```

Se só a contagem for maior que zero, você não precisa reenviar o catálogo — basta
mandar um push da rota 19 para receber a lista atualizada de `missingImages` e
seguir com os lotes da 21.

### 3.3 🔴 `missingImages` × recusa por formato: o laço infinito que evitamos

Um shortname que o site **recusa por formato** nunca entra em `missingImages`.
Ele é "sem imagem, permanentemente" — não "faltando".

Sem essa cláusula: você manda, o site recusa, o site continua listando como
faltando, você manda de novo. Para sempre. Era o que aconteceria com os 42
arquivos do seu pacote que estão fora do alfabeto.

Do seu lado, a contrapartida é honrar `INVALID_SHORTNAME` como **permanente**.
As outras cinco `reason` são retentáveis.

**A terceira ponta desse mesmo laço — corrigida em 05/09/2026, e é do nosso
lado.** A regra acima vale igualmente para o item que **você** declarou com
`imageSha: null`, que no contrato significa *"o agente não tem ícone para esse
item"*. O site estava contando esses como "faltando", e como você só para de
mandar quando `missingImageCount` zera, a contagem **travava** e você reenviaria
para sempre um ícone que não existe.

Medimos no dev: **27 itens** — `researchpaper`, `vehicle.chassis`, `pooltable`,
`jukebox`, `dartboard`, os cinco `rifle.ak.glass*`, e mais. Com a correção,
`missingImageCount` foi de **27 para 0**, e eles passaram a aparecer como *"sem
ícone no jogo"* — que é fato, não pendência.

**Você não precisa mudar nada, e a etiqueta não sobe:** nenhum byte da
requisição ou da resposta mudou. Era o site pedindo o impossível. A regra geral,
escrita de uma vez só:

> O site nunca lista como faltando o que ele sabe que não virá — seja porque
> recusa o shortname por formato, seja porque você disse `imageSha: null`.

### 3.4 O espelho é SNAPSHOT — mande sempre o catálogo inteiro

Item que **sumiu do `items[]`** é marcado como removido, igual a quem veio com
`removed: true`. Não mande delta, não mande página: `items[]` é o retrato
completo do que o jogo tem naquele momento.

Duas consequências:

- **Shortname fora do alfabeto reprova o push INTEIRO com 400**, e a mensagem
  diz qual. Descartar em silêncio faria os dois lados discordarem sobre o
  tamanho do catálogo, que é pior que um erro explícito.
- **Duplicata no mesmo corpo também reprova com 400.** O Postgres estouraria com
  *"cannot affect row a second time"* sem dizer qual nome repetiu.

---

## 4. As três decisões do dono (seu §6)

### 4.1 Tamanho da imagem: **64×64** — não mude nada

O pacote que você já tem serve. `ICON_SIZE` fica como está.

### 4.2 Skins: **fora desta fase**

Só os itens base. Os campos `isSkin` e `skinOf` estão **declarados e reservados**
no contrato — o site os aceita e ignora. Quando o dono quiser vender skin, ligar
é implementação dos dois lados, **não é mudança de rota**. Não mande skin agora.

### 4.3 Escopo: **por jogo, uma vez só**

`game='rust'`, `server_id NULL`. O `X-Server-Id` do bearer só diz **quem**
mandou; o conteúdo é global. A disponibilidade por servidor fica no campo
`servers`, que é do site.

Isso custou uma migration deste lado, e vale você saber por quê: a chave única
`(game, server_id, class_name)` **não protege linha com `server_id NULL`** —
Postgres trata cada NULL como distinto. O efeito não seria só "a chave não
protege": o upsert deixaria de ser upsert e **cada push inseriria 1259 linhas
novas**. Em um dia, 30 mil linhas. Resolvido com um índice parcial escopado em
Rust.

---

## 5. O que falta do SEU lado

### 5.1 Os 6 ícones de carro modular estão inalcançáveis — e é daí

Achei isto olhando seu pacote, e ele já quebra o **seu** painel hoje.

`panel/scripts/build-item-icons.mjs:227` nomeia cada arquivo pelo basename do
PNG do cliente:

```js
const shortname = name.slice(0, -'.png'.length);
```

A variável se chama `shortname`, mas o valor é o nome do arquivo. Na esmagadora
maioria dos casos os dois coincidem — inclusive nos que têm espaço. **Menos em
seis:**

| O cliente salva o PNG como | Seu catálogo guarda o shortname como | Resultado |
|---|---|---|
| `2module car.png` | `2module.car` | 404 → placeholder |
| `2module car chassis.png` | `2module.car.chassis` | 404 |
| `3module car.png` / `3module car chassis.png` | `3module.car` / `3module.car.chassis` | 404 |
| `4module car.png` / `4module car chassis.png` | `4module.car` / `4module.car.chassis` | 404 |

O dump do jogo tem **os dois shortnames para o mesmo `itemid`**
(`-866121090` aparece em `2module car.json` e em `2module.car.json`), e o seu
`rustagent.db` só conhece a forma com ponto — conferi: `2module car` aparece 0
vezes, `2module.car` aparece 4.

`panel/src/components/item-icon.tsx:108` pede
`/item-icons/${encodeURIComponent(shortname)}.webp`, então hoje esses 6 caem no
placeholder `Package` no seu próprio painel.

**Duas correções, em ordem de custo:**

1. **Alias no build (3 linhas).** Em `build-item-icons.mjs`, depois da linha
   229, quando o basename contiver espaço, gravar **também** a variante com `.`
   no lugar do espaço. Custo: 6 arquivos de ~1,7 KB. Resolve sem tocar no painel.
2. **Mapa gerado (resiste ao próximo caso).** O build lê também
   `Bundles/items/*.json`, agrupa por `itemid` e emite um
   `public/item-icons/index.json` com `shortname → arquivo`. O `ItemIcon`
   consulta o mapa e cai no `${shortname}.webp` quando não houver entrada.

**O que não funciona** é renomear os 6 para a forma com ponto: o dump tem as
duas formas para o mesmo item, e se um wipe futuro fizer o `ItemManager`
devolver a forma com espaço, quebra de novo. Alias nos dois sentidos é o único
jeito estável.

Do lado do site isso não é tratado de propósito — adivinhar ponto↔espaço aqui
criaria colisão entre dois shortnames que o jogo considera distintos. O site vai
simplesmente listar `2module.car` em `missingImages` até você resolver o alias.

### 5.2 O resto do seu pacote, para constar

Dos 1690 arquivos, **1648 casam** com o alfabeto e 42 não:

- **26 são skin** (terminam em `.skin`) — fora desta fase.
- **6 são arte extra** (`.sitem`, `spraycandecal…`) — não são itens do catálogo,
  nunca serão pedidos.
- **6 são os carros modulares** da §5.1.
- **4 são shortnames legítimos com espaço** — e esses **funcionam**, graças à
  correção da §3.1.

Você também tem 457 ícones que não correspondem a nenhum item do catálogo
(339 skins, 10 `.sitem`, 108 variantes de arte). Podar é opcional e não afeta
nada — o site só pede o que está em `missingImages`.

### 5.3 Fixtures

`contracts/oz-rust-fixtures.json` já foi atualizado nos **dois** repositórios,
byte a byte, com as rotas 19/20/21 e `contract: "oz-rust/7"`. Os casos novos não
têm bloco `agent`, então o teste daí os ignora até você implementar.

### 5.4 A etiqueta

`Docs/20-INTEGRACAO-OZCOIN-AGENT.md` §23 ainda diz `oz-rust/6`. Precisa subir
para `oz-rust/7` no mesmo commit em que você implementar as três rotas.

---

## 6. Como vai ser a primeira rodada

1. Você chama a **rota 20**. Vem `{version: null, missingImageCount: 0}`.
2. Você manda o catálogo inteiro na **rota 19** — 1259 itens, ~200 KB.
3. A resposta traz `missingImages` com os primeiros 200 e
   `missingImageCount: 1259`.
4. Você manda os ícones na **rota 21**, em lotes de 50 — **26 requisições**.
   Os 6 do carro modular voltam em `rejected[]` como `UNKNOWN_ITEM` ou não são
   enviados, dependendo de você ter feito o alias da §5.1.
5. Na rodada seguinte: **rota 20** devolve a version igual e
   `missingImageCount: 0`. Nada sai.

Da segunda hora em diante, é uma requisição `GET` por hora e mais nada — que é
exatamente o que o seu pedido queria.

---

## 7. O que mudou no site (para você não precisar perguntar)

| Peça | O quê |
|---|---|
| `services/rustItemCatalogMirror.ts` | a régua: validação, upsert em chunks, `missingImages` |
| `agent-item-mirror.controller.ts` | rotas 19 e 20 |
| `agent-item-images.controller.ts` | rota 21 |
| `models/RustItemMirror.ts` | tabela `rust_item_mirrors`, **PK `game`** — o catálogo é por jogo |
| `item_catalog.removed_at` | coluna nova. `NULL` = existe no jogo. **A linha nunca é apagada** |
| `item_catalog_rust_class_uniq` | índice parcial que faz o upsert ser upsert |
| `getItemClasses` | passa a achar item com `server_id NULL` quando o jogo é Rust |
| `PROTECTED_FOLDERS` | `rust-items` entra — a Galeria não apaga o pacote |

**Seu §5 foi respeitado:** `is_managed` continua sendo do admin. O espelho nunca
sobrescreve `display_name`, `value`, `sell_percent`, `delivery_type`,
`translations` nem `servers` de linha curada. O `removed_at`, ao contrário,
atualiza sempre — é fato do jogo, não curadoria.

**DayZ e SCUM não mudaram.** O botão "Sincronizar agente" deles continua
chamando `callAgent` como sempre. Foi provado rodando os dois controllers lado a
lado: DayZ 200 e 2719 itens, SCUM 120 e 2719, Conan 0 — idênticos antes e
depois.

---

## 8. As duas perguntas que sobram para você

1. **Vai fazer o alias dos 6 (§5.1), ou prefere que eles fiquem sem ícone?** O
   site funciona nos dois casos — só quero saber se paro de esperar aquelas 6
   imagens.
2. **Confirma que `INVALID_SHORTNAME` é tratado como permanente?** Sem isso o
   laço não fecha, e o critério de sucesso do seu §7 não é alcançável.
