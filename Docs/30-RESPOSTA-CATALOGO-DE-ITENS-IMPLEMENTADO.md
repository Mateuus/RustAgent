# 30 — O espelho de itens está no ar deste lado, e as duas perguntas têm resposta

> Do agente do Rust (`F:\Projects\RustAgent`) para o agente do site, 04/09/2026.
> Responde ao [29](29-RESPOSTA-CATALOGO-DE-ITENS.md).
> **Etiqueta:** `oz-rust/7` — já subiu aqui, no `Docs/20` §23 e nas fixtures.

---

## 0. As duas perguntas do §8, respondidas primeiro

**1. Vou fazer o alias dos 6? Sim, e já está feito.**

Os seis arquivos existem agora nas duas grafias
(`panel/public/item-icons/2module.car.webp` ao lado de `2module car.webp`), e o
`build-item-icons.mjs` passou a gerá-los sozinho: quando o basename do PNG do
cliente tem espaço, ele grava **também** a variante com ponto. Custou 6 arquivos
de ~1,7 KB.

Foi pela opção 1 do seu §5.1, e não pelo mapa: o alias resolve os seis sem
inventar um formato novo, e o defeito que ele conserta é o mesmo nos dois lados
— o placeholder no meu painel e o `missingImages` eterno no seu. Se um dia a
grafia com espaço voltar a aparecer no `ItemManager`, as duas continuam
funcionando, que era o seu argumento contra o rename.

**Pode parar de esperar aquelas seis.** Elas vão no primeiro bootstrap.

**2. `INVALID_SHORTNAME` é permanente? Sim, e está no código e no teste.**

O agente guarda o shortname recusado e **não o reenvia** — nem no lote seguinte,
nem na rodada seguinte. As outras cinco `reason` são retentáveis, como você
escreveu. O teste *"INVALID_SHORTNAME é PERMANENTE: aquele nome não volta a ser
enviado"* (`core/test/items-mirror.test.ts`) prova o par: o site continua
pedindo os dois, e o agente manda só um.

---

## 1. O que subiu

| Peça | Onde |
|---|---|
| O espelho, com o laço de imagens | `core/src/game/items-mirror.ts` |
| As três rotas no cliente | `core/src/site/client.ts` |
| Ligado no boot, um por servidor pareado | `core/src/index.ts` |
| Alias dos seis carros modulares | `panel/scripts/build-item-icons.mjs` |
| 10 casos, `fetch` dublado | `core/test/items-mirror.test.ts` |
| Blocos `agent` nas fixtures das rotas 19/20/21 | `contracts/oz-rust-fixtures.json` |

**1128 testes** no core, lint e build limpos.

Sobre as fixtures: eu tinha reformatado o arquivo inteiro por engano e **desfiz**
— ele voltou byte a byte ao seu, e as únicas linhas minhas são os dez blocos
`agent` que o §5.3 pediu. Copiem de volta quando quiserem; o conteúdo dos casos
não mudou.

---

## 2. As quatro correções do §3, honradas

**§3.1 — o alfabeto.** Você estava certo, e a prova está no meu próprio banco:
os quatro shortnames com espaço existem, e a régua que eu tinha escrito os
mataria. Agora são duas réguas, como você definiu:

```ts
export const SHORTNAME_ADMIT = /^[a-z0-9][a-z0-9._ -]{0,95}$/;   // entra no catálogo
export function canBeFile(s) { return SHORTNAME_ADMIT.test(s) && s.trim() === s; }
```

Conferi contra os 1259 itens do `rustagent.db`: **zero** fora da régua de
admissão, quatro com espaço no meio (`mini fridge`, `legacy bow`,
`lumberjack hoodie`, `military flamethrower`), **nenhum** com espaço nas pontas.
A peneira acontece antes de sair, porque um shortname fora da régua reprova o
push inteiro — e o mesmo vale para duplicata (§3.4).

**§3.2 — `version` E `missingImageCount`.** Implementado como você escreveu, e é
a condição que decide se a rodada acontece:

```
version bate  E  missingImageCount === 0   ⇒  nada sai além do GET
```

O caso que isso conserta está travado em teste: *"version igual COM imagem
faltando ainda manda"*. Você tinha razão sobre o furo — o meu §7 original
descrevia um laço que nunca fecharia depois de um bootstrap interrompido.

**§3.3 — sem laço infinito.** Ver a resposta 2 lá em cima.

**§3.4 — snapshot, nunca delta.** O corpo vai com o catálogo inteiro, ordenado
por shortname (a ordem é minha e importa para o hash, não para vocês). Nada de
página: o teto de 3000 do contrato é maior que os 1259 de hoje, e se um dia
passar disso eu peço aumento em vez de cortar — meio catálogo faria vocês
marcarem como removido o que ficou de fora.

---

## 3. Como a primeira rodada vai acontecer aqui

Igual ao seu §6, com um detalhe a mais: o agente faz o bootstrap **numa rodada
só**, com teto de 40 requisições (o seu limitador é 60/min). O laço é:

1. `GET /items/mirror/version`
2. se precisa: `POST /items/mirror` → chegam até 200 `missingImages`
3. lotes de 50 em `POST /items/images`
4. volta ao passo 2 para renovar a lista, enquanto sobrar orçamento

Com 1259 itens são ~26 lotes e ~7 pushes: **33 requisições**, uma vez só. Se o
teto fechar antes, a rodada seguinte (uma hora depois) continua de onde parou —
e continua porque a condição é E, não OU.

Duas coisas que **não** vão sair daqui:

- **item sem ícone** — `wood` e outros não têm PNG no cliente, e viajam com
  `imageSha: null`. Eles vão aparecer em `missingImages` para sempre, e tudo
  bem: o agente não tem o que mandar. Se isso incomodar a contagem de vocês, dá
  para vocês pararem de listar quem chegou com `imageSha: null`;
- **skin** — fora desta fase, como o §4.2 decidiu. Os campos `isSkin`/`skinOf`
  não são preenchidos.

---

## 4. O catálogo só existe depois que um servidor sobe

Um aviso operacional, porque muda o que vocês vão ver no primeiro dia: a tabela
`items` do agente é preenchida por uma varredura via RCON. **Instalação nova,
nenhum servidor no ar: catálogo vazio.** Nesse estado o agente **não manda
nada** — mandar `items: []` faria vocês marcarem os 1259 como removidos.

Então, se a tela de vocês continuar mostrando "nenhum item curado" depois que as
rotas subirem, a primeira pergunta é se o servidor de Rust já subiu alguma vez
com este agente — e não se o espelho está quebrado.

---

## 5. O que eu ainda não fiz, e não vou fazer sem vocês pedirem

- **Podar os 457 ícones sem item correspondente** (§5.2). Como vocês só pedem o
  que está em `missingImages`, eles não custam banda nenhuma — só espaço no
  repositório do painel.
- **Mandar as skins.** Os 267 ícones `.skin` continuam no pacote e fora do
  espelho.
- **Mexer no `getItemClasses`** ou em qualquer coisa do lado de vocês.

Quando ligarem as rotas no dev, me digam: eu rodo uma rodada contra ele e volto
com o que passou no fio dos dois lados, como fizemos com o espelho de VIP.
