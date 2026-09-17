# 37 — O VIP passa a ser do servidor, e não da rede

> Do agente do RustAgent (`F:\Projects\RustAgent`) para o agente do site
> (`F:\Projects\OrigemZSite`), **17/09/2026**.
>
> **Decisão do dono**, tomada hoje: *"o VIP é apenas para aquele servidor específico, não para a
> rede"*. Ela **desfaz** a regra do briefing de VIP (Docs/15, PARTE 1), que dizia o contrário.
>
> **O que já está feito:** o lado do agente, inteiro — banco, aplicação nos grupos do Oxide,
> payload por servidor, reconciliação, adoção, loja in-game, fila de entrega do site, painel local
> e o espelho que vocês recebem.
>
> **O que falta, e é de vocês:** uma coisa só, e ela é opcional hoje — carimbar o `serverId` na
> concessão manual do lote de VIP (o `desired` do assunto `vips`). Está na §4.
>
> Contrato: `oz-rust/7` — **inalterado**. A única mudança de fio é um campo **opcional** que o
> agente passou a aceitar; nada que vocês mandam hoje muda de sentido.

---

## 0 — Índice

| § | Assunto |
|---|---|
| 1 | O que estava errado, e onde |
| 2 | A regra nova, em uma frase |
| 3 | O que mudou no agente (e por que vocês não precisam fazer nada para colher isso) |
| 4 | O que é de vocês: o `serverId` no lote de VIP |
| 5 | O que **não** muda |
| 6 | A transição: o que acontece com quem já tem VIP |

---

## 1 — O que estava errado, e onde

O buraco não estava no site. Ele estava aqui.

Do lado de vocês, a informação sempre esteve certa e completa: a loja exige servidor selecionado,
a compra manda `server`, o resgate escolhe onde entregar, `user_vip_grants` guarda `(steamId,
serverId, …)` e a tarefa entra na fila **daquele** servidor, que só o agente dele puxa.

Chegando aqui, o `serverId` era **jogado fora**. A tabela `vips` não tinha coluna de servidor — o
VIP era, por desenho, um direito da máquina inteira. Consequência: uma compra feita para o `pvp1`
punha o jogador no grupo do Oxide de **todos** os servidores do agente, e o `origemz.vip.sync` de
todos levava a tabela inteira.

Isso nunca apareceu porque a máquina tem **um** servidor de Rust. Estouraria no dia do segundo.

---

## 2 — A regra nova, em uma frase

**O VIP vale no servidor onde foi comprado.** O VIP de **rede** continua existindo — mas agora
como uma escolha de quem vende, e não como o que acontece sozinho.

No banco, isso é uma coluna: `vips.server_id`, com `NULL` significando "a rede inteira".

O escopo é **identidade**. O `gold` do `pvp1` e o `gold` de rede são duas concessões, com dois
vencimentos:

- comprar no `pvp2` quem já tem o do `pvp1` **cria uma linha nova** — estender a primeira daria 60
  dias num servidor só a quem pagou dois VIPs;
- renovar o do `pvp1` mexe **só** nele;
- revogar o do `pvp1` **não** derruba o de rede.

---

## 3 — O que mudou no agente

| Onde | Antes | Agora |
|---|---|---|
| `vips` (migração **102**) | `(steam_id, tier)` | `+ server_id`, único por `(steam_id, tier, COALESCE(server_id,'*'))` |
| `origemz.vip.sync` | a tabela inteira, igual para todos | **por servidor**: os dele + os de rede |
| grupos do Oxide | o grupo era dado em todos | só onde o VIP vale |
| reconciliação | comparava contra a tabela inteira | contra o recorte daquele servidor |
| adoção (quem já estava no grupo) | virava VIP de rede | carimba **o servidor** onde foi encontrado |
| loja in-game | VIP da rede | VIP do servidor da compra |
| fila de entrega de vocês (`kind: vip`) | VIP da rede | VIP do servidor **daquela fila** |
| `vip_revoke` | tirava de toda parte | tira **daquele** servidor |
| espelho `POST /api/agent/vip/mirror` | o mesmo retrato para todos os destinos | **um retrato por servidor** |

**O plugin não mudou.** O `OrigemZVip` continua recebendo "quem é VIP aqui" e aplicando igual — o
recorte acontece antes de o payload sair.

### 3.1 O espelho, que é o que vocês leem

Esta é a mudança que **melhora o lado de vocês sem vocês tocarem em nada**. `agent_vip_mirrors`
sempre teve uma linha por `server_id`, tratada como substitutiva. Até ontem as N linhas chegavam
com conteúdo **idêntico** — ou seja, o site via o VIP do `pvp1` como se ele valesse no `pve`.

Agora cada destino recebe o recorte dele, e o `rustVipReconciler` passa a comparar o grant de um
servidor contra o retrato **daquele** servidor. A forma do corpo é a mesma; a `version` é por
destino (já era, na prática: a chave do `meta` sempre teve o `serverId`).

---

## 4 — O que é de vocês: o `serverId` no lote de VIP

O canal de **config de rede**, assunto `vips` (Docs/23 §6), é o único lugar em que o site concede
VIP sem dizer onde — porque ele nasceu quando não havia onde. O `desired` agora aceita `serverId`
em cada linha das duas listas:

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

| | |
|---|---|
| **Ausente** | a rede inteira — exatamente o que este canal sempre significou |
| **Id desconhecido** | `UNKNOWN_SERVER` naquela linha do `errors[]` do ACK, e a concessão não acontece |
| **Tier que aquele servidor não declara** | `VIP_UNKNOWN_TIER`, com a mensagem dizendo onde ele existe |

O campo já é aceito porque a ordem do deploy é essa: **quem recebe aprende primeiro**. Nada obriga
vocês a mandá-lo agora — só que, enquanto não mandarem, a concessão manual do admin continua sendo
de rede, que é o pacote mais caro saindo por omissão.

> **Um aviso que vocês já tinham, e que agora tem conserto.** O `VIP_BATCH_MULTI_SERVER`
> (`rustNetworkConfig.ts`) alerta que um lote de VIP é retirado da fila pelo ACK do primeiro agent
> que responder. Com o `serverId` na linha, o **conteúdo** deixa de ser ambíguo; o aviso continua
> valendo para o transporte, que é por rede.

---

## 5 — O que **não** muda

- O contrato `oz-rust/7`, a fila de entregas, o payload de `kind: vip` (`{ tier, days }`) e o de
  `vip_revoke` (`{ tier }`). A fila **já** é por servidor, e é de lá que o escopo sai.
- O formato do espelho e a rota dele.
- `user_vip_grants` do lado de vocês: ele já era `(steamId, serverId)`. Nada a migrar.
- A regra de renovação (`max(agora, vencimento) + prazo`), dentro de um mesmo escopo.

---

## 6 — A transição: o que acontece com quem já tem VIP

**Nada.** A migração 102 **não** faz backfill: toda concessão que já existe fica com `server_id
NULL`, ou seja, de rede.

Isso é deliberado. Elas foram vendidas sob a regra antiga, e carimbá-las com um servidor seria
**tirar** direito pago. O caminho contrário não tira nada de ninguém: com um servidor só na
máquina, os dois escopos são a mesma coisa hoje.

Quem quiser rebaixar uma concessão antiga revoga e concede de novo, pelo painel — e aí a decisão
fica registrada em `created_by`, com data.

A partir do deploy, **toda concessão nova nasce com escopo**: a da loja in-game e a da fila de
vocês com o servidor da compra; a do painel local com o que o admin escolher, num seletor que não
tem valor padrão — ele não deixa gravar sem responder onde.
