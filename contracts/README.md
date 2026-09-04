# `contracts/` — as fixtures do canal agent ↔ site

> **O que é.** Um arquivo só, `oz-rust-fixtures.json`, com os corpos de requisição e
> resposta das 16 rotas do canal. Ele existe para que os testes dos **dois** repositórios
> — o RustAgent e o OrigemZSite — falem com o **mesmo** contrato, em vez de cada um falar
> com o dublê que o seu próprio autor imaginou.

---

## Por que ele existe

O `Docs/21` §7 nomeia o risco número um deste projeto:

> *"Todo teste deste repositório fala com um dublê que devolve o que o manual diz que o
> site responde. Se as rotas nascerem com outro contrato, meus testes passam e a
> integração falha."*

E propõe o conserto: um arquivo de fixtures versionado num lugar só. Este é ele.

Na primeira rodada contra o dev (04/09/2026) o buraco já apareceu **três vezes** —
`version: 0`, `results[]` no lugar de `unknown[]`, e o 304 que nunca acontece. Nenhuma das
três teria sido pega por teste nenhum dos dois lados.

## Como ler

Cada resposta traz um `origin`, e ele é a coisa mais importante do arquivo:

| `origin` | Significa |
|---|---|
| `observed` | **copiado de uma resposta real** do dev, na data do bloco `probe` |
| `manual` | o que o manual descreve, **ainda não verificado** contra o site |

Um `manual` que ninguém confirmou é exatamente o tipo de linha que produziu as
divergências de `skinId` e `prefab`. Quem sondar uma rota e confirmar o corpo, **troca o
`origin`** e atualiza `probe.at`.

O bloco `agent`, quando existe, é o que o `SiteClient` deste repositório conclui daquela
resposta — e é o que `core/test/site-fixtures.test.ts` confere a cada `npm test`. Uma
fixture que mude sem o cliente acompanhar quebra o teste **aqui**, que é onde se quer que
ela quebre.

## Como regerar a parte `observed`

```
npm run site:probe -w core             # só o que LÊ
npm run site:probe -w core -- --write  # inclui o retrato, o beacon e os ACKs
```

A sonda usa o `SiteClient` de **produção** (mesmos headers, mesmo timeout, mesmo parsing),
grava os dois lados do fio em `dumps/site-probe.json` e **nunca** debita, credita, ACKa
entrega alheia nem sobrescreve o espelho da loja. O bearer não entra no relatório.

## Quem desempata quando os dois lados discordam

A regra é do `Docs/20` §23.1, e não muda:

| Assunto | Dono |
|---|---|
| formato dos **ids** (`DLV-…`, `CMD-…`), régua da `version` | **site** |
| **tipo e régua** dos campos de entrega (`skinId` string, `prefab`, `amount`) | **agente** |
| **`error_code`** | **site** |
| vocabulário de **`reason`** e de `status` do ACK | **agente** |

## A etiqueta

O cabeçalho traz `contract`. Ela é a mesma dos dois manuais, e um
`grep -Eom1 'oz-rust/[0-9]+'` nos dois tem de devolver o mesmo número. Mudou o contrato,
sobe nos dois **no mesmo commit** — e aqui também.
