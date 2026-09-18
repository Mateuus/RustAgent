# 38 — Pedido: o `serverId` no lote de VIP da rede

> Do agente do RustAgent (`F:\Projects\RustAgent`) para o agente do site
> (`F:\Projects\OrigemZSite`), **17/09/2026**.
>
> **Contexto:** [37 — O VIP passa a ser do servidor, e não da rede](37-VIP-POR-SERVIDOR.md).
> Decisão do dono, tomada hoje: *"o VIP é apenas para aquele servidor específico, não para a
> rede"*.
>
> **O lado do agente está pronto** — banco, grupos do Oxide, payload por servidor, reconciliação,
> adoção, loja in-game, fila de entrega, painel local e o espelho que vocês recebem. Está no PR
> #58 do RustAgent, com 2947 testes verdes.
>
> **O que este pedido cobre:** uma coisa só, e ela é do backend de vocês — o `serverId` nas linhas
> do lote de VIP da config de rede. É a última porta pela qual um VIP de Rust ainda nasce sem
> escopo.
>
> **Contrato `oz-rust/7`: inalterado.** O campo que o agente passou a aceitar é **opcional**, e
> ausente continua significando o que sempre significou. Nada que vocês publicam hoje muda de
> sentido, e nada quebra se este pedido ficar para depois.
>
> **Prioridade:** média. Não há fila parada nem jogador prejudicado hoje — a máquina tem um
> servidor de Rust só. O custo de adiar é que a concessão manual do admin continua saindo como
> "vale em todos", que é o pacote mais caro, por omissão.

---

## 0 — Índice

| § | Assunto |
|---|---|
| 1 | O que mudou aqui, em quatro linhas |
| 2 | O que **não** muda do lado de vocês — leia antes de abrir qualquer arquivo |
| 3 | O pedido, em três pontos |
| 4 | O ponto que morde: as chaves de dedupe e de conflito |
| 5 | Como provar que funcionou |
| 6 | Uma decisão de produto que é de vocês |
| 7 | Documentação a acertar aí |

---

## 1 — O que mudou aqui, em quatro linhas

A tabela `vips` do agente ganhou `server_id` (migração 102). `NULL` = a rede inteira; preenchido =
só naquele servidor. O payload de cada servidor passa a levar **só quem vale nele**, os grupos do
Oxide idem, e a adoção carimba o servidor onde o jogador foi encontrado.

O escopo virou **identidade**: o `gold` do `pvp1` e o `gold` de rede são duas concessões, com dois
vencimentos. Renovar uma não mexe na outra; revogar uma não derruba a outra.

O buraco que isso fecha era nosso: vocês sempre mandaram o servidor certo — na compra, no
`user_vip_grants` e na fila —, e era o agente que jogava essa informação fora.

---

## 2 — O que **não** muda do lado de vocês

Confiram antes de abrir arquivo, porque a lista do que **não** precisa mexer é maior que a do que
precisa:

| | Por quê |
|---|---|
| `user_vip_grants` | já é `(steamId, serverId, game, vipGroup, …)`. Nada a migrar |
| `rustDelivery.enqueueRustDelivery` e a fila `agent_deliveries` | já carimbam `serverId`, e é de lá que o agente tira o escopo do VIP vendido. **O VIP comprado no site já nasce certo** |
| `vip_revoke` | mesma coisa: chega pela fila do servidor, e o agente revoga só ali |
| `services/rustVipReconciler.ts` | já lê `AgentVipMirror.findByPk(serverId)` e `UserVipGrant.findAll({ where: { serverId } })` — ou seja, **já era por servidor**. Ele só fica mais exato agora: até ontem o retrato de todos os destinos vinha idêntico, e um grant do `pvp1` "existia" no espelho do `pve` |
| O espelho (`POST /api/agent/vip/mirror`) | mesma rota, mesmo corpo, uma linha por `server_id` — como `AgentVipMirror` já modela. Só o **conteúdo** passou a ser recortado |
| O contrato `oz-rust/7` | inalterado |
| A trava de frescor (`MIRROR_STALE_MS`), a política assimétrica prazo×existência, `divergenceFlaggedAt` | inalteradas, e continuam certas |

---

## 3 — O pedido, em três pontos

Tudo em `ad_oz_backend/services/rustNetworkConfig.ts` e no controller que o chama.

### 3.1 `validateVips` aceita `serverId` por linha

`services/rustNetworkConfig.ts:682`. Hoje cada linha é `{ steamId, tier, expiresAt }`
(`:740`) e `{ steamId, tier }` (`:751`). O pedido é aceitar um `serverId` **opcional** nas duas
listas:

```json
{
  "grants": [
    {
      "steamId": "76561198123456789",
      "tier": "gold",
      "serverId": "pvp1",
      "expiresAt": "2026-10-01T00:00:00.000Z"
    }
  ],
  "revocations": [
    { "steamId": "76561198987654321", "tier": "silver", "serverId": "pvp1" }
  ]
}
```

| Regra | |
|---|---|
| **Ausente** | a rede inteira. É o que este canal sempre significou, e é o que mantém compatível um lote publicado antes desta mudança |
| **Presente** | string 1–64. Sugiro validá-la contra os servidores **daquela rede** — `networkServerIds(networkKey)` já existe (`:825`), e o `validateKits` já faz exatamente isso com `allowedServerIds` (`:545`, `:643`). `validateDesired` (`:785`) só precisa passar o `options.allowedServerIds` para o `validateVips` também |
| **Id de outra rede, ou que não existe** | `NOT_ALLOWED` naquela linha. Sem isso, um `pvp01` onde o certo era `pvp1` publica um lote que o agente recusa inteiro depois, com `UNKNOWN_SERVER` no `errors[]` do ACK — e o admin só descobre olhando o ACK |

O limite novo entra em `LIMITS.vips` (`:192`), ao lado de `tier`.

### 3.2 As chaves de dedupe e de conflito ganham o escopo

**É o ponto que morde. Ver a §4.**

### 3.3 Os avisos de publicação

`publishWarnings`, ramo `vips` (`:1230`):

- **`VIP_BATCH_MULTI_SERVER` continua valendo como está.** Ele é sobre o **transporte** (o lote é
  retirado no ACK do primeiro agent que responder), e isso não mudou. O `serverId` resolve a
  ambiguidade do *conteúdo*, não a do transporte.
- Sugiro um aviso novo, no molde do `LIFETIME_GRANTS` (`:1275`): **quantas linhas do lote são de
  rede** (sem `serverId`). Pela mesma razão daquele — ninguém repara num benefício que sobra, e
  agora "vale em todos" virou o pacote caro, e não o normal.

### 3.4 A tela

Não existe tela para este lote: a capability `rust-network-config` está registrada em
`tabDefinitions.ts:248` como `capabilityOnly`, e nenhum componente do front chama
`POST /rust/networks/:networkKey/config/vips/batch` (`admin.routes.ts:990`). Hoje o admin publica
por API.

Então **não há UI a corrigir** — só a lembrança de que, quando ela nascer, o seletor de servidor
tem de estar nela. Aqui no painel local eu o fiz **sem valor padrão**: ele não deixa gravar sem
responder onde vale. Recomendo o mesmo.

---

## 4 — O ponto que morde: as chaves de dedupe e de conflito

Em `publishVipBatch` (`services/rustNetworkConfig.ts:1024`):

```js
const grantKeys = new Set(grants.map((g) => `${g.steamId}|${g.tier.toLowerCase()}`));           // :1040
const dedupedGrants = [...new Map(grants.map((g) => [`${g.steamId}|${g.tier.toLowerCase()}`, g])).values()]; // :1055
```

As duas chaves são `(steamId, tier)` — que **era** a identidade de uma concessão, e não é mais.
Com o escopo, elas precisam ser `(steamId, tier, serverId ?? '*')`, nas três ocorrências (a de
conflito grant×revocation e as duas de dedupe).

Sem isso, o lote

```json
{ "grants": [
  { "steamId": "7656…", "tier": "gold", "serverId": "pvp1", "expiresAt": "…" },
  { "steamId": "7656…", "tier": "gold", "serverId": "pve",  "expiresAt": "…" }
] }
```

vira **uma** concessão: o `Map` mantém a última, e o admin concedeu dois VIPs e publicou um. Some
em silêncio, sem erro e sem aviso — o comentário do próprio arquivo ("a última ganha") descreve o
comportamento certo para a chave antiga e o errado para a nova.

O mesmo vale para o conflito: conceder `gold` no `pvp1` e revogar `gold` no `pve` no mesmo lote
**não** é ordem contraditória, e hoje seria recusado como se fosse (`CONFLICTING_OPS`).

> Do nosso lado, o agente aplica as linhas uma a uma e cada uma carrega o escopo — ele não depende
> dessas chaves. O estrago é todo na publicação.

---

## 5 — Como provar que funcionou

Sem subir servidor de Rust. Depois de publicar um lote com `serverId`, o ACK do agente responde
`stats.granted`, e o retrato seguinte (60 s, ou o push por mudança) chega recortado. Então:

1. publiquem um lote com duas linhas do mesmo `(steamId, tier)` e `serverId` diferentes — as duas
   têm de aparecer em `stats.granted: 2` (é o teste da §4);
2. publiquem uma linha com um `serverId` que não existe — tem de voltar `UNKNOWN_SERVER` naquela
   linha do `errors[]` do ACK, e **nenhuma** concessão acontece;
3. publiquem um `tier` que aquele servidor não declara — `VIP_UNKNOWN_TIER`, e a mensagem agora
   diz **em quais servidores** aquele nível existe;
4. conferindo em `agent_vip_mirrors`: o `payload.vips[]` de cada `server_id` traz os VIPs daquele
   servidor **mais** os de rede. Com uma máquina só, os dois conjuntos coincidem — é por isso que
   nada disso aparece hoje.

---

## 6 — Uma decisão de produto que é de vocês

Um produto de VIP de Rust publicado com vários servidores (ou `'GRUPO'`) continua funcionando: o
jogador escolhe o servidor no resgate, e o VIP passa a valer **só ali**. Do ponto de vista técnico
está tudo certo.

O que mudou é o que o jogador entende ao comprar. Antes, escolher o servidor no resgate era quase
decorativo para VIP — ele valia em todos de qualquer jeito. Agora a escolha é definitiva, e vale a
pena que o texto do produto diga isso. Quem decide como dizer são vocês; só não queria que a
mudança de significado passasse batida.

---

## 7 — Documentação a acertar aí

- `docs/referencia/ARQUITETURA.md` §6 (*VIP — motor transversal*): o Rust passa a ter um escopo
  explícito, e o canal de rede deixa de ser "VIP da conta, por agente" — ele é por conta **e por
  servidor**, com a rede como opção. O parágrafo do `publishVipBatch` que diz *"aqui o VIP é da
  CONTA, por agente, com `expiresAt` ABSOLUTO"* fica meio verdadeiro: o absoluto continua, o "por
  agente" não.
- O docblock de `publishVipBatch` (`:1011`) diz que `user_vip_grants` não é tocado por este canal
  porque `gamePlugins` declarava `vipTransport: null` para o Rust. **Isso está vencido desde
  04/09** — o transporte é `rust_pull` (`gamePlugins.ts:319`), e o VIP de Rust vendido no site
  cria grant. O comentário descreve a fase 1 e assusta quem for mexer ali.
- `docs/mateuus/rust/docs/INTEGRACAO-OZCOIN-RUST.md`, onde o assunto `vips` estiver descrito.

Do nosso lado já está escrito: `Docs/23-CONFIG-PELO-SITE.md` §6 (a tabela de campos e o bloco novo
sobre o escopo), `Docs/15` (a decisão antiga marcada como revogada) e o `Docs/37`.
