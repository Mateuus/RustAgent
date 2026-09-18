# Passe de Batalha — o painel

A seção **Battle Pass** na barra lateral, as seis abas dentro dela, e as regras
do painel que já estão escritas em outro lugar e valem aqui.

Medido em 17/09/2026 contra `panel/` na `main`.

---

## 1. O que o painel deste projeto é

Três fatos que mandam em tudo que vem depois:

1. **É export estático.** `output: 'export'` (`panel/next.config.mjs:18`); o
   `next build` gera `panel/out`, e o agente o serve com `@fastify/static`
   (`core/src/http/server.ts:829`). Não existe servidor Next: **nada de API
   Route, Server Action, `cookies()`, `headers()` ou middleware**. Toda
   `page.tsx` começa com `'use client'`.
2. **`trailingSlash: true`** (`next.config.mjs:42`). A rota é `/battlepass/`,
   com a barra. Sem ela o link cai no fallback.
3. **Tema só escuro**, Tailwind 4 com os tokens dentro de `@theme` em
   `panel/src/app/globals.css:18`. Não existe `tailwind.config.ts`. Não é
   shadcn/ui — é a *convenção* (`cva` + `cn`) sem o Radix.

E o estilo, que não é gosto e sim regra escrita no CSS:

- **Cantos retos.** `--radius: 2px`, e a escala inteira foi achatada de
  propósito (`globals.css:41`) para impedir que um `rounded-full` copiado de
  algum exemplo vire pílula no meio da tela.
- **Vermelho não é texto.** `--rust-red` dá 3,74:1 e não passa em contraste
  (`globals.css:98`). Ele serve para ícone, borda e barra de acento. Aviso é
  texto em `--text` com a borda colorida.
- **Títulos são `font-condensed ... font-bold uppercase tracking-wide`**, com a
  barrinha rust antes — é o que faz as telas parecerem a mesma tela.
- **Ausente é `—`, nunca `0`** (`panel/src/lib/format.ts:4`).

---

## 2. A entrada na barra lateral

Um objeto novo no array `NAV` (`panel/src/components/sidebar.tsx:68`), com os
quatro campos obrigatórios `{ href, label, hint, Icon }`. Ícone do **lucide-react**,
importado no bloco de `:24`.

O lugar: entre `/quests/` e `/regras/`. A lógica do arquivo agrupa por *o que a
coisa é*, e o passe é conteúdo de rede que o jogador consome — vizinho de
missões, não de servidores. Cada bloco do array vem precedido de um comentário
dizendo por que mora ali; o do passe também vem.

Ícones livres hoje, e plausíveis: `Ticket`, `Medal`, `CalendarDays`, `Gift`.

> **O `hint` envelhece.** A dica de `/workshop/` ainda fala em *"caixa /skin,
> coleções e acessos"* — features que saíram na migração 097
> (`sidebar.tsx:107`). Copiar o molde é copiar também o hábito de revisar o
> texto auxiliar quando a feature muda.

---

## 3. As seis abas

Abas são **estado local** (`useState`), não rota aninhada e não query string —
é o padrão de todas as 25 telas. O molde a copiar é o `wipe-panel`
(`panel/src/components/wipe/wipe-panel.tsx:72` e `:306`), que já tem sete abas,
cada uma no seu arquivo `tab-*.tsx`.

| Aba | O que responde | Componentes que já existem |
|---|---|---|
| **Visão geral** | a temporada de hoje está no ar? quantos compraram? quantos dias restam? o mês que vem tem passe? | `Section`, `StateBlock`, `formatWhen` |
| **Temporadas** | criar o passe de outubro, novembro, dezembro; publicar; ver o estado de cada um | tabela + `Dialog`, `ConfirmDialog` |
| **Trilha** | os níveis da temporada escolhida, faixa grátis e faixa paga lado a lado | **`RewardList`** (§4) |
| **XP** | o que dá XP, quanto vale cada fonte e o teto diário de cada uma | tabela editável, `Toggle`, `Field` |
| **Configuração** | as três chaves de liga/desliga, a curva de XP, o retroativo, o preço | `Toggle`, `Field`, `INPUT` |
| **Jogadores** | quem tem o passe, o XP e o nível de cada um, o que já resgatou | `useCursorPages` + `Pagination` |
| **Registro** | o histórico de quem mexeu em quê, e as entregas | molde de `audit-panel.tsx` |

A aba **XP** é a que o dono descreveu como *"o que vai dar XP o administrador vai
administrar isso"*. Cada linha é uma fonte do cardápio (§4.1 do
[02](02-O-PASSE-DO-JOGADOR.md)), com quatro campos: ligada, valor por
ocorrência, teto diário, e o rótulo que o jogador lê. Duas exigências dessa
tela:

- **ela não oferece o que o agente não sabe medir.** O cardápio vem do agente,
  não de uma lista escrita no painel — senão o admin configura XP por "saquear
  caixa" e nada acontece, em silêncio;
- **ela avisa quando a fonte tem pegadinha.** `sleeper.kills` paga quem anda de
  machado por base vazia, e `gather.*` morre se o ranking correspondente for
  desligado. São `HelpTip`, não notas de rodapé.

O carregamento segue a regra de `panel/src/app/loja/page.tsx:148`: **o que é
essencial falha para `error` e mostra `StateBlock variant="error"`; o que é
secundário tem `try/catch` próprio e degrada em vazio.** A contagem de compras
não pode derrubar a tela de configuração.

E há dois desenhos de aba no projeto, que não se misturam
(`wipe-panel.tsx:308` explica: *"dois níveis com o mesmo desenho fazem a pessoa
perder de vista onde está"*). O do passe é o de **pílula**, por ser aba interna.

---

## 4. A aba Trilha, que é a que importa

É a tela onde o admin monta o mês. O desenho que combina com o card do jogo:

```text
┌──────────────────────────────────────────────────────────────┐
│  TEMPORADA  [ outubro de 2026 ▾ ]     30 níveis    RASCUNHO  │
├───────┬──────────────────────────┬───────────────────────────┤
│ NÍVEL │ GRÁTIS                   │ PAGO                      │
├───────┼──────────────────────────┼───────────────────────────┤
│   1   │ + Adicionar recompensa   │ + Adicionar recompensa    │
│   2   │ 500 OZCoin               │ Kit "inicial"             │
│   3   │ —                        │ skin AK "Tempestade"      │
│  ...  │                          │                           │
│   7   │ Pedra ×1000      MARCO   │ Kit "semana"      MARCO   │
└───────┴──────────────────────────┴───────────────────────────┘
```

Quatro decisões dessa tela:

1. **O editor de recompensa não é novo.** `RewardList`
   (`panel/src/components/rewards/reward-list.tsx:70`) já edita item, OZCoin,
   kit, pontos e VIP, e já é compartilhado entre missões e KOTH. O cabeçalho
   dele explica por que foi extraído: duas telas para a mesma pergunta
   divergiriam no primeiro tipo novo, e *"a que ficasse para trás ofereceria
   menos, sem avisar ninguém"*. A trilha do passe usa **este**.
2. **A skin entra no contrato compartilhado, não num tipo só do passe.** É o
   quinto tipo de recompensa, e pelo mesmo argumento do item 1 ele nasce em
   `QuestReward` — onde missões e KOTH ganham de graça.
3. **Nível vazio é legítimo.** Nem todo nível precisa dar alguma coisa nas duas
   faixas; `—` é uma resposta, e a tela não pede que o admin preencha 60 células
   antes de publicar.
4. **A tela precisa dizer quanto tempo leva.** Com a curva de XP e as regras da
   aba XP, o painel consegue estimar quanto um jogador médio demora para
   terminar a trilha — e essa é a falha nº 1 dos passes: a pesquisa nos sete
   jogos de referência aponta a **temporada que não dá para terminar** como o
   erro mais comum, com o alvo de ser completável cerca de uma semana antes do
   fim. Uma linha de "no ritmo configurado, a trilha leva ~N dias" vale mais que
   qualquer aviso depois da reclamação.

---

## 5. `normalize.ts` — o passo que não é opcional

`panel/src/lib/api.ts:143` é literalmente `return payload as T`. Um cast. **Não
há Zod no painel** e não há validação na fronteira: um campo que o agente omitir
vira `TypeError` no render e derruba a página inteira com *"This page couldn't
load"*.

A resposta do projeto é `normalize.ts`, e o molde é
`panel/src/components/workshop/normalize.ts` — helpers `text`/`nullableText`/
`nullableNumber` (`:29`) e uma função `safeX` por tipo, **campo a campo, com
padrão em cada um**. As quatro regras que ele já descobriu:

- enum desconhecido vira `null`, não erro;
- booleano ausente cai no **lado seguro** — o comentário de `:86` diz que a tela
  nunca promete que uma skin sai no wipe por causa de um campo que não veio. No
  passe o lado seguro é: recompensa ausente **não** é "disponível";
- id maior que 2^53 é **texto**;
- campo derivável se recalcula quando falta (`expired` a partir de `expiresAt`).

Vale dizer que essa disciplina **não é universal** no projeto — só o `/workshop`
tem `normalize.ts`; a `/loja` lê `categoryResponse.categories` cru
(`loja/page.tsx:155`) e está exposta. O passe copia o workshop, não a loja.

---

## 6. Os tipos são escritos duas vezes, e isso é consciente

Não existe pacote de tipos compartilhado. O contrato mora em
`core/src/types/battlepass.ts` (com Zod, validando a entrada) e é **copiado à
mão** como `interface` em `panel/src/lib/api.ts` — que tem 8.229 linhas e um
objeto `agent` com ~600 métodos, dividido por comentários `// ---- assunto ----`.

E `contracts/` na raiz **não é isso**: são fixtures do canal com o site
OrigemZ, com a etiqueta `origin` dizendo se cada resposta foi `observed`,
`manual` ou `proposal`. O passe só encosta lá se for vendido pelo site — e as
fixtures `manual` nunca foram confirmadas contra o ambiente de desenvolvimento.

---

## 7. Como saber que terminou

```bash
npm run lint -w panel        # eslint flat; `next lint` não existe mais no Next 16
npm run typecheck -w panel   # tsc --noEmit
npm run test -w panel        # vitest, ambiente node, SEM jsdom
npm run build -w panel       # gera panel/out
```

O teste a escrever é `panel/test/battlepass-normalize.test.ts`, no molde de
`panel/test/workshop-normalize.test.ts`. A política está escrita em
`panel/vitest.config.mts:4`: *"o que tem teste aqui é a LÓGICA; componente React
é verificado pelo typecheck e olhando a tela"*. Os casos: campo omitido vira
padrão, enum desconhecido vira `null`, booleano ausente cai no lado seguro, id
grande continua texto.

E as armadilhas que o projeto já pagou e que valem aqui: `min-w-0` na coluna de
conteúdo (sem ele uma tabela larga empurra a sidebar para fora da tela,
`app-shell.tsx:10`); toast é desfecho de ação, estado que continua valendo vai
inline com `StateBlock` (`lib/toast.ts:4`); **não reescrever a mensagem de erro
do agente** — ela já vem em português e vai inteira para a tela
(`api.ts:52`); e não esconder botão "porque não vai dar certo" — o certo é
mostrar a recusa.
