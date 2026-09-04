# 24 — Ligar o resgate de VIP de Rust (prompt para o agente do site)

> Para o agente que trabalha em `F:\Projects\OrigemZSite\ad_oz_backend`.
> Escrito em 04/09/2026, depois de ler os dois lados. Tudo que este
> documento afirma sobre o RustAgent foi verificado no código, e vem
> com arquivo e linha.

---

## 1. O que já está pronto, e por que isso muda o tamanho do trabalho

O primeiro instinto ao ler "vender VIP no site" é procurar o que
construir. Neste caso é o contrário: quase tudo existe, dos dois
lados, e o que falta é **destravar**, não escrever.

### 1.1 O RustAgent já sabe entregar VIP

O `kind: 'vip'` está no vocabulário da fila desde sempre. Não é
esqueleto — é caminho executável, com régua e execução:

- `core/src/site/deliveries.ts:155` — o schema:
  `{ tier: string (1..32), days: int (1..3650) | null }`, `null` =
  vitalício.
- `core/src/site/deliveries.ts:236` — o payload vira `DeliveryPlan`.
- `core/src/store/service.ts:773` — a execução: chama o concessor de
  VIP local, que ESTENDE o prazo se já houver VIP (comprar duas vezes
  compra o dobro de tempo, não sobrescreve).

O mesmo caminho já roda em produção pela loja in-game. A fila do site
não estreia código: ela reusa o que o jogador já compra dentro do
jogo.

### 1.2 O site já separa o pacote misto — e faz isso na COMPRA

Esta é a parte que economiza o trabalho maior, e vale ler devagar
porque a intuição erra aqui.

Um produto "Kit VIP" com 1 VIP bronze + 1 AK **não chega ao agente
como um pacote a ser desmontado**. Ele já nasce desmontado, no
inventário, no momento da compra:

`services/kitCatalog.ts:241` (`isSpawnKitMember`) separa membros
*spawnáveis* de membros *de conta*. O `buildInventoryRowsForKit`
(mesmo arquivo, ~:276) usa essa separação para criar, no modo
`single`, **um item `kit` com as armas + um item `vip` solto**. O
comentário na linha 239 descreve exatamente o caso do pedido:

> Ex.: kit AKM+carregador+supressor + 1000 OZ + VIP → 1 item "kit"
> (as 3 armas) + 1 item OZ + 1 item VIP. O jogador resgata os 3.

Consequência direta: **não é preciso inventar um `kind: 'bundle'`**
nem no site nem no agente. Cada linha do inventário vira sua própria
tarefa, com seu próprio `kind`, e o agente já sabe executar os quatro.
Um `bundle` seria um quinto vocabulário para resolver um problema que
a separação na compra já resolveu — e que só existiria para ser
mantido em dois repositórios.

O `buildKitPayload` (`services/rustDelivery.ts:124`) já filtra os
membros de conta pelo mesmo `isSpawnKitMember`. Ele está certo como
está. Não mexer.

### 1.3 Então o que falta

Só o VIP, e por uma trava deliberada. `services/rustDelivery.ts:156`
diz, no docblock do `buildVipPayload`:

> CÓDIGO INALCANÇÁVEL NA FASE 1, e de propósito: `rust_vip` não está
> registrado em `deliveryTypes.ts` (…) Ligar a fase 2 NÃO é reabrir os
> mapas: começa pelo reconciliador de VIP de Rust e pelo
> `vipTransport` em gamePlugins.

O item VIP nasce no inventário do jogador (1.2 garante isso) e é
**recusado no resgate**, pela guarda `isDeliveryImplemented`. A
tradução `{ tier, days }` já está escrita e testada — só nunca é
chamada.

---

## 2. O trabalho, em quatro passos

### Passo 1 — Registrar `rust_vip`

Em `services/deliveryTypes.ts:49-51`, ao lado dos três de Rust:

```js
{ value: 'rust_vip', label: 'Rust — VIP', requiresVip: true }
```

E no mapa de handlers (~:573), no mesmo grupo dos outros:

```js
rust_vip: 'rust_pull',
```

`rust_pull` já está em `IMPLEMENTED_HANDLERS` (~:598) — nada a
acrescentar lá. E o `defaultDeliveryType` de Rust (~:492) precisa
ganhar `vip: 'rust_vip'`, pelo mesmo motivo que o comentário da linha
487 dá para o kit: sem entrada no mapa, o tipo fica declarado e
inalcançável.

Apague também o comentário da linha 44 ("NÃO existe `rust_vip` nesta
fase") e o da ~:126. Comentário que descreve uma trava removida é pior
que comentário nenhum: o próximo leitor confia nele.

### Passo 2 — `vipTransport` para Rust, e ele é de PULL

Em `services/gamePlugins.ts:216`, hoje `vipTransport: null`.

**Aqui está a decisão de projeto que não pode ser copiada do DayZ nem
do Conan.** Os dois transportes existentes (`dayz_agent`,
`conan_panel`) são SÍNCRONOS: o site chama o agente, o agente responde,
e só então o grant nasce. O Rust não tem essa porta — o site nunca
chama o RustAgent. O canal é de pull, e a única confirmação que existe
é o **ACK da entrega**.

Então o transporte novo — sugiro `'rust_pull'`, para o nome dizer o
que é — não deve chamar ninguém. Ele deve:

1. Enfileirar a tarefa `kind: 'vip'` (o `enqueueRustDelivery` já faz).
2. Criar o `UserVipGrant` em estado **pendente**, não ativo.
3. Ativar o grant **quando e somente quando** chegar o ACK
   `status: 'delivered'` daquela tarefa.

O passo 3 é o que impede o defeito mais caro deste trabalho: um jogador
offline gera ACK `deferred`, e a tarefa fica pendente por até 30 dias
(`AGENT_DELIVERY_TTL_DAYS`). Se o grant nascesse ativo, o site diria
"VIP ativo, vence em 30 dias" enquanto o jogador nunca recebeu grupo
nenhum no Oxide — e o relógio dele estaria correndo. O jogador paga
por trinta dias e recebe zero, com sucesso em toda tela que alguém
olhasse.

E o simétrico: ACK `failed` (ou expiração do TTL) precisa **cancelar**
o grant pendente, junto com a devolução do item ao inventário que o
`rustDeliveryExpiry` já faz.

O gancho para isso é o `Deliveries.ack`
(`src/modules/agent-private/agent-deliveries.controller.ts`). Ele já
distingue os três desfechos; o que falta é ele avisar o
`userVipGrantService` quando a tarefa for de VIP.

### Passo 3 — O reconciliador: quem é dono do relógio

Depois que o VIP entra no jogo, **o RustAgent é o dono do vencimento**.
Ele reaplica o grupo do Oxide no boot, estende o prazo quando o jogador
compra de novo (in-game ou no site — é o mesmo `grant`, ver
`core/src/store/service.ts:783`), e expira sozinho.

Isso significa que o site vai divergir do jogo, e vai divergir de
formas legítimas: o jogador comprou VIP dentro do jogo com OZ (o site
não fica sabendo), o admin deu VIP à mão, o prazo foi estendido.

Falta uma rota para o agente **relatar** o estado real. O `POST
/api/agent/vip/grant` que existe hoje não serve: ele é da migração do
`VipData.txt` do SIG_Vip e está travado em `MIGRATION_GAME = 'dayz'`
(`agent-vip.controller.ts:30`) — de propósito, e a trava está certa.

**Este lado já está escrito e testado** (`core/src/vip/site-mirror.ts`,
11 testes). Ele segue o molde do `/shop/mirror`, que é exatamente este
problema já resolvido para a loja. Faltam as duas rotas:

```
GET  /api/agent/vip/mirror/version
POST /api/agent/vip/mirror
```

O agente manda o **retrato inteiro** dos VIPs ativos, com uma `version`
sha256 que ele mesmo calcula; o `GET` deixa ele perguntar barato se o
site já tem aquele retrato antes de reenviar tudo — mesma economia do
catálogo. Retrato inteiro, e não delta: delta exige que os dois lados
concordem sobre o que já chegou, e a primeira mensagem perdida deixa a
divergência permanente e invisível.

O corpo do `POST`, exatamente como ele sai daqui:

```jsonc
{
  "version": "a3f…",                    // sha256 hex, 64 chars
  "generatedAt": "2026-09-04T13:00:00.000Z",
  "vips": [
    {
      "steamId": "76561198000000001",
      "tier": "bronze",
      "expiresAt": "2026-10-04T13:00:00.000Z", // null = vitalício
      "origin": "loja",                        // loja | painel | adotado
      "grantedAt": "2026-09-04T13:00:00.000Z"
    }
  ]
}
```

Do `GET` o agente lê um campo só: `{ "version": "a3f…" | null }`, com
`null` = "nunca me mandaram espelho". Se ele bater com a `version`
local, o `POST` não sai.

Três coisas sobre este corpo que valem contrato:

- **`vips[]` é o conjunto inteiro dos ATIVOS.** Quem sumiu do retrato
  não é VIP mais. Revogado e vencido não viajam.
- **`origin` é o que vocês não têm como saber sozinhos.** `loja` =
  comprado dentro do jogo com OZ; `painel` = um admin deu à mão;
  `adotado` = já estava no grupo do Oxide quando o agente chegou.
  Nenhum dos três nasce de venda do site — um grant de vocês sem linha
  correspondente aqui é a divergência que este campo diagnostica.
- **`generatedAt` fica FORA do hash**, de propósito. Se entrasse, a
  `version` mudaria a cada montagem e o retrato inteiro atravessaria a
  internet a cada minuto.

O agente empurra a cada 60 s e também logo depois de conceder, revogar
ou expirar (debounce de 2 s). O teto de corpo é 2 MiB, recusado antes
de sair — e ele não trunca: meio retrato faria vocês revogarem o VIP de
quem ficou de fora do corte.

**Enquanto a rota não existir**, o agente toma 404, recua 10 minutos
por servidor e marca `routeMissing` na própria tela de diagnóstico. Não
há pressa nem log poluído do lado de cá — subam quando der.

**Decidam também o que fazer com a divergência**, e escrevam a decisão
onde ela é lida: o site *corrige* o grant pelo que o agente relata (o
jogo é a verdade), ou apenas *marca* a divergência para o admin? Minha
recomendação é a primeira para o prazo (`expiresAt`) e a segunda para
a existência do grant — um VIP que sumiu do jogo pode ser um plugin que
não carregou, e apagar o grant pago por causa disso é irreversível.

### Passo 4 — A régua do `tier`, e onde ela mora

O `tier` que o site manda precisa casar com um tier que **existe no
agente**. Não é validação de formato: `vipGroupScale: null` já diz que
a escala de Rust é por nome (`vip1`, `vip_bronze`), e o
`buildVipPayload` já corta em 32 chars e faz `toLowerCase()`.

O ponto é que o site **já empurra a lista de VIPs** para o agente: o
domínio `vips` está no canal de config
(`core/src/site/domains.ts:68`, junto com `store` e `kits`). Ou seja, a
lista canônica de tiers já viaja do site para o agente.

Então o cadastro do produto deve oferecer os tiers **daquele
snapshot**, e não um campo de texto livre. Um `vipGroup` digitado à mão
que não existe no agente produz uma entrega que falha cinco vezes e cai
em `needs_admin` — o custo aparece no suporte, não no cadastro. A régua
certa é a mesma que o resto do arquivo já usa: recusar no resgate, com
o item ainda no inventário, é infinitamente melhor que recusar na fila.

---

## 3. O contrato do payload, para conferência

O que o agente aceita em `kind: 'vip'` (`core/src/site/deliveries.ts:155`):

```jsonc
{
  "tier": "vip_bronze",  // string, 1..32 chars, minúsculas
  "days": 30             // int 1..3650, ou null = vitalício
}
```

Qualquer coisa fora disso vira ACK `failed` com `PAYLOAD_INVALID`, e o
item volta para `available`. O `buildVipPayload` de vocês já produz
exatamente esta forma — conferi campo a campo. Não há tradução nova a
escrever.

Os três desfechos do ACK continuam os mesmos, e para VIP eles
significam:

| ACK | O que aconteceu | O que o site faz com o grant |
|---|---|---|
| `delivered` | o VIP entrou no Oxide | **ativa** o grant pendente |
| `deferred` | jogador offline/morto — tenta de novo | **não mexe**: continua pendente |
| `failed` | falha definitiva | **cancela** o grant, item volta ao inventário |

`VIP_GRANTER_UNAVAILABLE` (`core/src/store/service.ts:777`) é o caso de
um agente sem o concessor ligado. Ele **não** está na lista de
adiáveis do agente (`deliveries.ts:81`), então chega como `failed` — e
está certo assim: é configuração faltando, não jogador dormindo, e
nenhuma quantidade de espera resolve.

---

## 4. O que NÃO precisa mudar

Listado porque a tentação de mexer é real, e cada item aqui custou
leitura para confirmar:

- **`buildVipPayload`** — já correto, só inalcançável.
- **`buildKitPayload` e o filtro `isSpawnKitMember`** — a separação do
  pacote misto está certa e acontece na compra (§1.2).
- **`POST /api/agent/vip/grant`** — é a migração do DayZ. A trava de
  jogo dele está certa; não afrouxem para acomodar o Rust.
- **`/shop/purchase`** — é do Conan, travado em `requireConanServer`. O
  Rust não usa este caminho: a compra in-game debita direto por
  `POST /ozcoins/debit`, com `referenceId` idempotente e `productId`.
  Está certo assim.
- **Nada no RustAgent.** O `kind: 'vip'` já funcionava ponta a ponta, e
  o espelho do passo 3 foi escrito em 04/09/2026 — está no
  `core/src/vip/site-mirror.ts`, com 11 testes, e sobe junto com o
  próximo deploy do agente. Ele já está batendo na rota de vocês e
  tomando 404, como previsto.

---

## 5. O que responder para cá

O formato do retrato já está fechado (§2, passo 3) — o agente o fala
desde já, e mudá-lo agora custa uma linha aqui, não um contrato. O que
ainda depende de vocês:

1. **O nome do `vipTransport`** e se o grant nasce pendente
   (recomendado) ou ativo. Esta é a única decisão que muda código dos
   dois lados se for revista depois.
2. **A política de divergência.** Minha recomendação: o site *corrige*
   o `expiresAt` pelo que o agente relata (o jogo é a verdade), mas só
   *marca* para o admin quando o grant sumiu do retrato — um VIP que
   desapareceu do jogo pode ser um plugin que não carregou, e apagar o
   grant pago por causa disso é irreversível.
3. **Se querem um `ok`/`accepted` no corpo do `POST`.** O agente só
   olha o status HTTP; qualquer 2xx conta como aceito, e a `version`
   que ele grava é a que ele calculou — se vocês devolverem outra, ela
   é ignorada de propósito.

Nada disso bloqueia os passos 1 e 2, que já destravam o resgate.
