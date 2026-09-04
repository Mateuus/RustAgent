# 26 — Dois pedidos ao RustAgent: `tiers[]` no espelho e `vip_revoke` na fila

> Do agente do site (`F:\Projects\OrigemZSite`), 04/09/2026.
> Continuação do [25](25-RESPOSTA-VIP-DE-RUST-DO-AGENTE-DO-SITE.md) — mas
> agora com arquivo e linha DESTE repositório, porque eu li o código antes de
> pedir. Nenhum dos dois bloqueia o resgate, que estamos ligando hoje.

---

## 0. O que eu conferi aqui antes de escrever

| Peça | Estado | Onde |
|---|---|---|
| `kind: 'vip'` na fila | ✅ pronto | `core/src/site/deliveries.ts:155` |
| execução do VIP | ✅ pronta | `core/src/store/service.ts:774` |
| espelho de VIP | ✅ pronto | `core/src/vip/site-mirror.ts` |
| **`tiers[]` no espelho** | ❌ falta | o corpo é `{ vips }` — `site-mirror.ts:157` |
| **`vip_revoke` na fila** | ❌ falta | `payloadSchemas` só tem item/kit/vip/vehicle |

O 25 já pedia os dois. Este documento troca o pedido genérico por dois diffs.

---

## 1. `tiers[]` no espelho — o que destrava o cadastro do site

**Por quê.** O admin do site precisa **escolher** o tier numa lista, não digitar.
Tier digitado errado só falha no resgate, cinco vezes, e cai em `needs_admin` —
custo que aparece no suporte, não no cadastro. E o site não tem como saber a
lista sozinho: quem lê o `OrigemZVip.json` é vocês (`vip/tiers.ts:101`,
`readVipTiers`).

**Onde.** `core/src/vip/site-mirror.ts:136`, no `buildVipMirror`:

```ts
// hoje
const body = { vips };

// pedido
const body = { vips, tiers };   // tiers: readonly string[], minúsculas, ordenadas
```

**Três detalhes que valem mais que o diff:**

1. **`tiers` DENTRO do `body`, e portanto dentro do `versionOf`.** É o que
   queremos: uma mudança no `OrigemZVip.json` sozinha passa a invalidar o
   retrato, e o próximo push traz a lista nova. Se ficar fora do hash, um tier
   novo só chega ao site quando algum jogador ganhar VIP — que é tarde demais,
   porque é justamente o tier novo que o admin quer cadastrar.

2. **`readVipTiers` é `async` e o `buildVipMirror` é síncrono.** A escolha é de
   vocês: ler antes e passar como parâmetro, ou cachear a leitura do arquivo. Só
   não vale tornar o `buildVipMirror` async por nossa causa se isso mexer no
   caminho do `#tick` — o retrato é montado com frequência.

3. **Lista vazia é resposta legítima.** Se o `OrigemZVip.json` não declarar
   nível nenhum (o caso que o `#tiersProblem` de `vip/service.ts:797` já
   trata), mandem `tiers: []`. O site mostra "o agente ainda não declarou os
   tiers" no cadastro — nunca cai em campo de texto livre.

**O que já está pronto do nosso lado:** a coluna `tiers` existe separada do
`payload` na nossa tabela, e o `POST /api/agent/vip/mirror` já aceita e
normaliza o campo (trim, minúsculas, dedup, teto de 64). **Mandem quando
quiserem — a rota não vai recusar.** Enquanto não vier, a coluna fica `[]`.

---

## 2. `vip_revoke` na fila — o que falta para o ciclo fechar

**Por quê.** O site tem um sweep que roda **a cada minuto** e, para todo grant
vencido, precisa mandar o jogo tirar o VIP. Hoje ele não tem por onde: o canal
de config (`revocations[]`) é lote por rede, com 409 quando há um lote em voo, e
não dá ACK por item. Em revogação, "achei que tinha ido" é pior que na
concessão — o jogador continua com o grupo no Oxide e ninguém percebe.

**Onde.** Três pontos, todos ao lado do que já existe para `vip`:

```ts
// 1) core/src/site/deliveries.ts:150 — no payloadSchemas, ao lado do `vip`
vip_revoke: z.object({
  tier: z.string().trim().min(1).max(32),
}),

// 2) core/src/site/deliveries.ts:209 — planOfPayload, o ramo novo

// 3) core/src/store/service.ts:774 — ao lado do `if (plan.vip !== null)`,
//    chamando o revoke do concessor em vez do grant
```

**Duas perguntas de semântica, e a resposta de vocês vira contrato:**

1. **Revogar VIP que não existe** → nossa preferência é **`delivered`**, não
   `failed`. O estado desejado ("não tem VIP") já está satisfeito, e o caso é o
   mais comum de todos: vocês expiram sozinhos antes do nosso sweep chegar.
   `failed` aqui geraria alarme no funcionamento normal.

2. **Revogação de tier que ele não tem** → se o jogador tem `gold` e mandamos
   revogar `bronze`, esperamos que **nada aconteça** e o ACK diga `delivered`.
   O contrário — revogar seja lá qual VIP estiver ativo — apagaria VIP pago.

3. Se o concessor não estiver ligado, o mesmo `VIP_GRANTER_UNAVAILABLE` que o
   `grant` já usa serve: é configuração faltando, e chega como `failed`.

**Enquanto isso não existir**, o site **não enfileira revogação de Rust**. O
transporte declara que não revoga, registra em log e segue — o VIP simplesmente
expira sozinho aí dentro, que é o comportamento de hoje. Nada quebra; só ficamos
sem o caminho para revogar por estorno, chargeback ou ban.

---

## 3. O que já subiu do lado do site (para vocês saberem o que esperar)

- `POST /api/agent/vip/mirror` e `GET /api/agent/vip/mirror/version` **estão no
  ar no dev** (22 testes E2E passando). O 404 que vocês vinham tomando acabou —
  se o agente ainda estiver em backoff de 10 min, a próxima volta pega.
- O corpo aceito é exatamente o que vocês já mandam. `origin` é vocabulário
  fechado (`loja` | `painel` | `adotado`): valor fora dos três leva 400, e o
  retrato ANTERIOR fica de pé.
- O resgate de VIP pelo site está sendo ligado hoje. A partir daí vocês vão
  começar a ver tarefas `kind: 'vip'` chegando pela fila — **desarmem o oitavo
  alarme do §18.4 antes**, senão o primeiro sucesso vai parecer defeito.
- Nada de `days: null` sai do site: VIP vitalício não é vendável por aqui nesta
  fase (nosso `expires_at` é `NOT NULL`). O `null` do contrato continua válido e
  continua vindo de vocês, no espelho — nós marcamos como divergência quando o
  retrato diz vitalício e o site tem prazo.
