# OrigemZWorkshop — skins vendidas e sorteadas pelo site

> **Para quem é.** Para quem mexe no RustAgent (frente C do [05](05-PLANO-E-FRENTES.md)) e para
> quem mexe no **OrigemZSite**: metade deste documento é trabalho do lado de lá.
>
> **Contrato.** Hoje é `oz-rust/7` ([Docs/31](../31-ENDPOINTS-DO-SITE.md)); este documento
> propõe o **`oz-rust/8`**. O árbitro continua sendo `contracts/oz-rust-fixtures.json`: os
> corpos abaixo só valem depois de entrarem lá.
>
> **Data:** 17/09/2026. **Estado:** o lado do **agente** está implementado (frente C, §7); o do
> **site** não existe. Os corpos estão em `contracts/oz-rust-fixtures.json` com
> `origin: "proposal"`, e o contrato continua `oz-rust/7` até o site aceitar.

---

## 1. O que precisa acontecer

1. **O site precisa saber quais skins existem**, para montar a vitrine e a caixa: nome, item,
   imagem, raridade.
2. **O site vende uma skin, ou a sorteia numa caixa**, e o jogador passa a possuí-la **na rede
   inteira**.
3. **Reembolso ou estorno** tira a posse.

A regra do canal não muda (Docs/31 §1): **o site nunca chama o agente.** O item 1 é um espelho
que o agente empurra. Os itens 2 e 3 são tarefas na fila de entregas, que o agente puxa.

```text
  AGENTE                                         SITE
  ──────                                         ────
  catálogo de skins ──POST /skins/mirror──────→  vitrine / caixa
                                                    │ compra ou sorteio
  fila  ←──GET /deliveries/pending──────────────  kind: "skin"
    │ grava a posse (rede toda)
    └──POST /deliveries/ack───────────────────→  delivered
```

---

## 2. O espelho do catálogo — rotas novas no site

Mesmo molde de `items/mirror` e `vip/mirror` (Docs/31 §3, rotas 17 a 20): o agente pergunta a
versão e, se mudou, empurra o snapshot inteiro.

### `GET /api/agent/skins/mirror/version`

```json
{ "version": "b3f1…" }
```

`version: null` = não há espelho.

### `POST /api/agent/skins/mirror`

```jsonc
{
  "version": "b3f1…",                 // hash do snapshot, calculado pelo agente
  "skins": [
    {
      "shortname": "rifle.ak",        // item do Rust
      "workshopId": "3802433262",     // TEXTO: é UInt64 e não cabe em número de JS
      "label": "AK Brasa",
      "description": "…",             // pode ser null
      "rarity": "epic",               // common | uncommon | rare | epic | legendary | null
      "category": "weapon",           // weapon | attire | tool | construction | items | traps | electrical | medical | ammunition | resources | food | fun | misc
      "previewUrl": "https://steamuserimages-a.akamaihd.net/…", // a prévia do Workshop; pode ser null
      "openToAll": false,             // skin da casa: grátis no jogo, não faz sentido vender
      "enabled": true,
      "servers": ["srv-1", "srv-2"]   // ids de servidor em que a skin aparece
    }
  ]
}
```

- **A chave natural da skin é `(shortname, workshopId)`.** O `id` interno do agente **não
  viaja**: ele muda se a skin for recadastrada, e o par não muda. É o mesmo par que a Steam
  valida (01 §2) e o mesmo `UNIQUE` do banco.
- **É o snapshot da rede**, não o de um servidor. O agente empurra por um pareamento qualquer;
  o site guarda **um** espelho de skins da rede, e não um por servidor. **Decidido na frente C
  (17/09/2026), sem o site para confirmar:** o agente empurra o mesmo snapshot por **todos** os
  pareamentos com token, e cada um pergunta a `version` antes. Se o site guardar um espelho só,
  o segundo pareamento vê a `version` batendo e não manda nada (custa um GET); se guardar um por
  servidor, cada um recebe o seu. As duas formas funcionam sem mudar o agente.
- **`servers` viaja com o id NO SITE** (o `X-Server-Id` de cada pareamento), e não com o id
  local do `Configs<id>.ini`, que o site não conhece. Servidor sem pareamento sai da lista.
- **`skins: []` é legítimo** (o admin apagou todas) e é mandado: o site tira tudo da vitrine.
- **`category`** sai do espelho `items` do agente (migração 07), porque o banco de skins não
  guarda a categoria (02 §4.1). O espelho guarda o nome do enum do jogo (`Weapon`); ele viaja em
  minúsculas. Se o item não estiver no espelho, ou a categoria não estiver na lista acima
  (`Component`, por exemplo), vai `misc`.
- **`previewUrl`** é a URL que a Steam devolveu no cadastro (`workshop_skins.preview_url`). O
  site **não deve depender dela para sempre**: a Steam pode trocá-la. Se precisar de imagem
  estável, baixe e guarde do lado do site.
- **Teto:** o mesmo 1 MiB do canal. 3000 skins cabem com folga.
- **Quando empurrar:** no boot, a cada mudança no catálogo (com um atraso de alguns segundos
  para juntar edições em sequência) e a cada 10 minutos como garantia, sempre perguntando a
  `version` antes.

### O que o site faz com o espelho

- Só oferece à venda skin com `enabled: true` e `openToAll: false`.
- **Uma skin que sumiu do espelho** sai da vitrine e das caixas. As compras antigas dela ficam
  como estão: o agente continua honrando a posse se a skin voltar.

---

## 3. A entrega — dois `kind` novos na fila

### `kind: "skin"`

```jsonc
{
  "id": "DLV-5b9cf2b0731a",
  "kind": "skin",
  "steamId": "76561198000000000",
  "sourceRef": "order:1234",           // ou "box:5678" para o prêmio da caixa
  "payload": {
    "shortname": "rifle.ak",
    "workshopId": "3802433262",        // TEXTO
    "days": null                        // null = permanente; senão, inteiro de 1 a 3650
  }
}
```

**O que o agente faz** (ramo próprio no `#handle` de `core/src/site/deliveries.ts`, no molde do
`vip`):

1. valida o payload com zod (`payloadSchemas`, `deliveries.ts:163`);
2. procura a skin por `(shortname, workshopId)` no catálogo;
3. chama `grantOwnership({ steamId, skinRef, days, source: 'site', sourceRef: <id DLV>,
   createdBy: 'site:<sourceRef>' })`, a **mesma** função do painel (02 §4.2). Receber a mesma
   skin de novo **soma o prazo** ou mantém o permanente;
4. grava `site.delivered` na `workshop_audit`;
5. se o jogador estiver online em algum servidor, reenvia a posse dele (02 §5.2). **É o momento
   em que o cadeado some com o menu aberto** (03 §7);
6. ACK `delivered`.

**Não exige o jogador online.** A posse é um registro, não um item na mochila. Por isso o
`skin` fica **fora** do `DeliveredKind` e do `DeliveryPlan`, como o `vip` (`deliveries.ts:241`
e `:591`).

**As recusas:**

| Situação | ACK | `reason` |
|---|---|---|
| payload inválido | `failed` | `PAYLOAD_INVALID` |
| a skin não está no catálogo | `deferred` | `SKIN_NOT_IN_CATALOG` |
| a skin está no catálogo, mas **desligada** | `delivered` | — a posse é gravada e passa a valer quando a skin for religada. O jogador pagou; desligar é decisão de operação, e não pode apagar a compra |
| a skin está em nenhum servidor | `delivered` | — mesmo motivo |
| erro de banco | não dá ACK | a reserva fica órfã e vira `AGENT_INDETERMINATE` (o caminho que já existe, Docs/31 §6.6) |

**Grafia do `reason`:** esta tabela dizia `INVALID_PAYLOAD`. O agente manda `PAYLOAD_INVALID`,
que é a grafia que a fila já usa para `item`, `kit`, `vip` e `vehicle` — um código só para o
mesmo desfecho. O vocabulário do `reason` é do agente (`contracts/README.md`).

Além da tabela, o agente produz mais dois desfechos:

| Situação | ACK | `reason` |
|---|---|---|
| o SteamID não passa na régua da posse (`7656…`) | `failed` | `PAYLOAD_INVALID` |
| o agente está sem o catálogo de skins ligado (só em teste) | `failed` | `SKIN_GRANTER_UNAVAILABLE` |

`SKIN_NOT_IN_CATALOG` é `deferred`, e não `failed`, porque o caso típico é o admin ter apagado e
recadastrado a skin. A tarefa volta na próxima volta e passa assim que o catálogo tiver o par de
novo. **O site deve mostrar essas tarefas para alguém**, porque não se resolvem sozinhas.

### `kind: "skin_revoke"`

```jsonc
{
  "id": "DLV-…",
  "kind": "skin_revoke",
  "steamId": "7656…",
  "sourceRef": "refund:1234",
  "payload": { "shortname": "rifle.ak", "workshopId": "3802433262" }
}
```

- Remove a linha de posse daquele jogador para aquela skin, **qualquer que seja a origem dela**.
  Existe uma linha só por par (02 §4.2). Grava `owned.revoke` na auditoria com o `sourceRef`.
- **Sem posse para remover:** `delivered` mesmo assim. O estado desejado já vale. Assim o
  `skin_revoke` pode ser reexecutado, como o `vip_revoke`: uma linha órfã dele **reexecuta**, em
  vez de virar `AGENT_INDETERMINATE`.
- **A skin fora do catálogo:** `delivered` também. A posse cai em cascata quando a skin é
  apagada, então não há o que tirar.
- Grava também `site.delivered` (com `kind: "skin_revoke"` e `removed`), como o `skin`.
- **Não despinta o item** (02 §3).
- Reenvia a posse do jogador se ele estiver online.

**Limite conhecido, a decidir com o site:** o jogador comprou 30 dias, depois comprou mais 30
(total 60), e pediu reembolso da primeira compra. O `skin_revoke` remove a posse **inteira**. A
posse é uma linha só, e ela não sabe quais dias vieram de qual compra. Se o site precisar
devolver só parte, o payload ganha `days` e o agente subtrai do prazo. **Não implementar antes
de o site pedir.**

---

## 4. A idempotência

É a que já existe (Docs/31 §7): a chave é o `id` `DLV-…`, com a reserva local em
`site_deliveries` antes de executar (`core/src/db/site-deliveries-repository.ts:109`).

**O que muda na tabela `site_deliveries`:** o `CHECK (kind IN (...))`
(`core/src/db/migrations.ts:2996`) ganha `'skin'` e `'skin_revoke'`. Isso é reconstrução de
tabela, na **migração 097**, a mesma da frente A (02 §4.4). E o tipo `SiteDeliveryKind`
(`site-deliveries-repository.ts:52`) ganha os dois valores.

**Uma trava a mais do lado do site**, como a do `vip`: no máximo **uma tarefa `skin` aberta por
(jogador, skin, compra)**. Duas tarefas da mesma compra somariam o prazo duas vezes.

---

## 5. O que o site precisa fazer

| # | O quê |
|---|---|
| 1 | as rotas `GET /skins/mirror/version` e `POST /skins/mirror` (§2), com rate limit no balde de 60 dos outros espelhos |
| 2 | aceitar `skin` e `skin_revoke` como `kind` para Rust na fila (hoje: `item`, `kit`, `vip`, `vehicle`, `vip_revoke`) |
| 3 | a vitrine de skins e a caixa, lendo o espelho |
| 4 | gerar `skin` na compra e no sorteio, e `skin_revoke` no reembolso |
| 5 | mostrar as tarefas `deferred` com `SKIN_NOT_IN_CATALOG` |
| 6 | **não** usar `cosmetics/*`: são do DayZ (Docs/31 §3, balde B) |
| 7 | subir o contrato para `oz-rust/8` e gravar os corpos acima no `contracts/oz-rust-fixtures.json` |

**Fora deste contrato, e possível depois:** o site mostrar "minhas skins" ao jogador. Isso seria
um terceiro espelho (a posse por jogador) e não é pedido agora.

---

## 6. O que o agente precisa fazer

| # | O quê | Onde |
|---|---|---|
| 1 | `skinsMirrorVersion()` e `pushSkinsMirror()` | `core/src/site/client.ts`, junto de `items/mirror` (`:336-340`) |
| 2 | o empurrador do espelho, com `version` por hash | `core/src/site/skins-mirror.ts` (novo), no molde de `game/items-mirror.ts` |
| 3 | `skin` e `skin_revoke` em `payloadSchemas` e no `#handle` | `core/src/site/deliveries.ts` |
| 4 | as opções `grantSkin` e `revokeSkin` | `SiteDeliveriesOptions` (`deliveries.ts:307`), ligadas em `core/src/index.ts:1325` |
| 5 | `SiteDeliveryKind` | `core/src/db/site-deliveries-repository.ts:52` |
| 6 | testes | um fixture por `kind`, e os casos da tabela do §3 |

**Enquanto o site não tiver os itens 1 e 2 do §5,** o agente recebe 404 no espelho. Trate como
"o site ainda não sabe disso": log em nível `debug` uma vez por boot, **sem** tentar de novo a
cada 10 minutos com aviso. E nenhuma tarefa `skin` chega, o que não quebra nada.

---

## 7. Como ficou no agente (frente C, 17/09/2026)

| Peça | Onde |
|---|---|
| `skinsMirrorVersion()` / `pushSkinsMirror()` | `core/src/site/client.ts` |
| o espelho (`SkinsSiteMirror`, `buildSkinsMirror`) | `core/src/site/skins-mirror.ts` |
| a tradução da tarefa para o `WorkshopCatalog`, e o `site.delivered` | `core/src/site/skin-deliveries.ts` |
| `skin`/`skin_revoke` nos schemas, o ramo `#skin`, `SKIN_NOT_IN_CATALOG` no `DEFERRABLE` | `core/src/site/deliveries.ts` |
| a ligação (e o bloco do Workshop subiu para antes das filas) | `core/src/index.ts` |
| os corpos propostos | `contracts/oz-rust-fixtures.json` (`origin: "proposal"`) |
| os testes | `core/test/site-skins.test.ts` |

**Decisões que este documento não tomava:**

- **O que se grava na posse:** `source: 'site'`, `sourceRef: <DLV-…>`, `createdBy:
  'site:<sourceRef do site>'` (ou `site:<DLV>` quando o site não manda `sourceRef`), cortado em 120
  caracteres. No `skin_revoke`, o `sourceRef` do `owned.revoke` é o do site (`refund:1234`).
- **`days` é obrigatório.** Ausente é `PAYLOAD_INVALID`, e não "permanente": um campo esquecido
  do lado de lá daria a skin para sempre. Permanente é `days: null`, explícito.
- **`workshopId`** passa na mesma régua do cadastro: dígitos, sem zero à esquerda, até o teto de
  UInt64. **`shortname`** também, e é normalizado para minúsculas.
- **Erro de banco** (qualquer exceção que não seja uma recusa conhecida): sem ACK, a reserva fica
  em `reserved`, e a volta seguinte manda `deferred`/`AGENT_INDETERMINATE`. Na `skin_revoke`, a
  volta seguinte reexecuta.
- **O 404 do espelho:** um `debug` por pareamento por boot. O pareamento fica quieto até a volta
  seguinte do relógio (10 min), que **tenta de novo em silêncio**: assim o espelho começa a andar
  sozinho no dia em que o site publicar a rota, sem reiniciar o agente. O aviso de mudança do
  catálogo não acorda um pareamento que está quieto.
- **Quando empurra:** no boot, 5 s depois da última mudança no catálogo (criar, editar, trocar
  servidores, apagar) e a cada 10 minutos. Mudança só no espelho `items` (a categoria) espera a
  volta dos 10 minutos.
- **Teto:** acima de 3000 skins ou de 1 MiB o espelho **não é mandado** (aviso no log): o
  snapshot não se fatia, e meio snapshot tiraria da vitrine o que ficasse de fora.

**O que o site precisa saber, em uma lista:** as duas rotas do §2 (com `skins: []` aceito e
`servers` em ids do site); os dois `kind` do §3; `reason` com a grafia `PAYLOAD_INVALID`; a trava
de uma tarefa `skin` aberta por (jogador, skin, compra); e mostrar as `deferred` com
`SKIN_NOT_IN_CATALOG`. A troca para `oz-rust/8` sobe nos dois lados no mesmo commit.
