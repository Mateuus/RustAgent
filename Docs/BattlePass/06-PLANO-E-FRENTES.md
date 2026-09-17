# Passe de Batalha — plano e frentes

Como dividir a construção entre agentes que trabalham ao mesmo tempo sem pisar
um no outro.

Cada frente abaixo é **um agente, uma worktree e uma branch**. O prompt de cada
agente deve mandá-lo ler o [01](01-A-TEMPORADA-E-AS-REGRAS.md) inteiro, o
documento da camada dele, e **esta seção dele**.

---

## 1. A ordem

```text
  A — agente: contrato, banco e regras ──┬──→ B — o XP
                                         ├──→ C — a compra ──→ G — venda pelo site
                                         └──→ E — o painel
  D — o plugin e a tela ──(usa o contrato do 02 §5)───┘
  F — skin como recompensa ──── independente, entra quando quiser
```

A **D é a maior**: virou um plugin novo depois de o dono escolher o caminho do
menu de skins. Ela começa cedo justamente por isso.

- **A vai primeiro**, porque é ela que cria os tipos e a migração 101. **B, C e
  E** partem do commit da A.
- **D pode começar junto com a A**: o contrato que ela consome está escrito, e a
  tela se testa com carga feita à mão.
- **F é independente** de tudo — mexe no contrato compartilhado de recompensas,
  não no passe.
- **G depende de terceiro** (o agente do site) e por isso **não está no caminho
  crítico**. O passe funciona sem ela, vendendo só in-game.

### A branch de integração

```bash
git worktree add F:/Projects/RustAgent-passe -b battle-pass origin/main
```

Cada frente sai da `battle-pass` na **sua** worktree e volta para ela por merge,
na ordem **A → F → B → C → E → D → G**. No fim, **um PR só** da `battle-pass`
para a `main`.

---

## 2. As regras que valem para todas as frentes

1. **Nada de migração fora da 101, e ela é da frente A.** Se uma frente precisar
   de coluna, pede à A. Id repetido entre branches vira migração **pulada em
   silêncio** no merge.
2. **Um agente só roda contra o banco de desenvolvimento, e é o da A.** Depois da
   101, um agente com código velho quebra nas rotas do passe. As outras frentes
   usam teste ou API falsa.
3. **`git add` por caminho explícito** — as worktrees de subagente moram dentro
   do repositório.
4. **Identificador em inglês, texto em português** (regra global do dono).
5. **O que já existe não se reescreve.** Quatro coisas, especificamente:
   `RewardList` (`panel/src/components/rewards/reward-list.tsx:70`),
   `inventory-room.ts` (da branch `resgate-com-inventario-cheio`),
   `periods.ts` (a aritmética de mês) e `ui-widgets.ts` (o kit da tela).
6. **Toda afirmação sobre o jogo carrega data e procedência.** O que não foi
   medido fica marcado PENDENTE, e ninguém deduz.

### 2.1 As branches vizinhas, e onde elas encostam

Havia **nove worktrees ativas** em 17/09/2026. Duas encostam neste trabalho:

| Branch | Onde colide | O que fazer |
|---|---|---|
| `resgate-com-inventario-cheio` | criou `core/src/quests/inventory-room.ts`, que a frente B precisa | **esperar o merge dela** ou partir do commit dela; não reescrever |
| `missoes-diarias-e-rankings` | mexe em quests e rankings — que é **exatamente** onde o XP entra (`collector.ts`, `rewards.ts`) | a frente B fala com ela antes de tocar nesses dois arquivos |

A segunda é a séria: a frente B precisa costurar o XP **dentro** da transação de
`applyBatch`, e é o mesmo arquivo que a outra árvore está editando.

---

## 3. Frente A — contrato, banco e regras

**Depende de:** nada. É a primeira.

### O que fazer

- `core/src/types/battlepass.ts`: os schemas Zod e os tipos de transporte.
  Vocabulário do [01](01-A-TEMPORADA-E-AS-REGRAS.md) §9 — `season`, `track`,
  `level`, `lane`, `xp`, `xpRule`, `entitlement`, `claim`, `progress`.
- **Migração 101** com as dez tabelas do [02](02-O-PASSE-DO-JOGADOR.md) §5,
  incluindo o índice único parcial dos entitlements.
- `core/src/db/battlepass-repository.ts`.
- `core/src/battlepass/service.ts` — a **porta única**: painel, jogo e site
  entram por ela, cada método escreve **e** avisa.
- As rotas em `core/src/http/routes/battlepass.ts`, registradas dentro do escopo
  autenticado.

### Pronto quando

- `npm test -w core` verde, com teste de: temporada só fica `active` uma por vez;
  o índice parcial recusa dois direitos vivos no mesmo mês; a trilha congelada no
  resgate não muda quando o catálogo muda.
- `npx tsc --noEmit` limpo.
- O índice único parcial de `battlepass_entitlements` é
  `(server_id, steam_id, period)` — **por servidor**, como o dono decidiu. É
  índice, não coluna solta: mudar depois é reconstruir a tabela.

---

## 4. Frente B — o XP

**Depende de:** A. **Fala antes com:** `missoes-diarias-e-rankings`.

### O que fazer

- O **cardápio** de fontes: a lista do que o agente sabe medir, servida ao
  painel. Não é uma constante no painel — vem do agente.
- O **XP de ação**: derivado do delta, **dentro da transação** de `applyBatch`,
  ao lado de onde o `time.played` já é costurado. Ler `player_stats` por fora é
  o caminho que duplica.
- O **XP de missão**: novo `kind: 'xp'` em `QuestReward`, no molde de `points`
  (`quests/rewards.ts:504`), com `eventId` estável.
- O **teto diário por fonte**, com a régua de virada de dia das missões
  (`reset_at_minute`) — não invente uma segunda.
- A subida de nível: XP acumulado → nível, pela curva da temporada.

### As regras que não se negociam

- **`sleeper.kills` não vem ligado por padrão.** Ele paga quem anda de machado
  por base vazia.
- **Não apoiar XP de farm em `gather.*`** na primeira versão: ele depende de um
  ranking habilitado e morre em silêncio quando o admin desliga o ranking.
- **"Sem dados" não é "zero".** Rodada pulada por plugin descarregado precisa
  aparecer.

### Pronto quando

- Teste provando que **o mesmo lote aplicado duas vezes não dobra o XP**.
- Teste do teto: a 101ª unidade de XP de uma fonte com teto 100 não entra, e não
  fica guardada para amanhã.
- Teste da virada do dia no fuso certo.

---

## 5. Frente C — a compra

**Depende de:** A.

### O que fazer

Os nove passos do [04](04-A-COMPRA.md) §5, em ordem: `kind: 'pass'` no catálogo,
migração das colunas (**pedir à A**), o `superRefine` da oferta, o formato no
diálogo do painel, o `DeliveryPlan` **com o zod**, o `PassGranter` ao lado do
`VipGranter`, e o ramo em `deliverPlan`.

### As regras que não se negociam

- **Comprar o mesmo mês duas vezes é recusado antes do débito**, nunca dentro da
  entrega.
- **O mês vem do plano congelado**, não do relógio da entrega. Um débito
  `unknown` pode ser reconciliado horas depois, atravessando a virada.
- **Todo campo novo do plano entra no zod com `.default()`**, ou as compras em
  voo no momento do deploy viram conferência humana.

### Pronto quando

- Teste: compra com passe já ativo é recusada **sem tocar em dinheiro**.
- Teste: plano congelado com `period` de setembro, entregue em outubro, ativa
  **setembro**.
- Teste: `planFromJson` aceita um plano gravado antes desta frente.

---

## 6. Frente D — o plugin e a tela

**Depende de:** nada para começar — o contrato está escrito e a tela se testa com
carga feita à mão. Integra depois da A.

**É a maior frente.** O dono decidiu que a tela nasce no plugin, como o menu de
skins, e isso significa um `.cs` novo — não um arquivo de tela no agente.

### O que fazer

- **`Plugins/OrigemZBattlePass.cs`**, com o `OrigemZWorkshop.cs` como molde linha
  a linha. A lista de peças a copiar, com número de linha, está no
  [03](03-MENU-DO-PASSE.md) §5: regiões, `MenuSession` com token, o porteiro de
  comando, `Redraw`/`Compute*`/`Build*`/`Pack`, `ScrollArea`, `CollectChunk`,
  `Push` por `timer.Once`, `MeasureWorstCase`.
- Classe base **`RustPlugin`**, com `[ConsoleCommand]` e `[ChatCommand]`. Em
  `CovalencePlugin` o `[ConsoleCommand]` não registra nada, o plugin carrega
  limpo e o comando some — com o sintoma chegando como `RCON_TIMEOUT`.
- **O canal de carga**: agente → plugin em base64 e pedaços, com segredo por
  processo, no molde de `origemz.workshop.sync`.
- **A caixa de pendências** com tooltip e ponto de notificação
  ([03](03-MENU-DO-PASSE.md) §6). É o que só o plugin sabe fazer, e é metade do
  motivo de esta frente existir.
- **O card na home** — este pedaço é do **agente**
  (`core/src/game/ui-home-screen.ts`), com **upgrade idempotente** no boot, nunca
  o reset do preset, que descarta a edição do admin.

### As regras que não se negociam

- **Nenhum `Puts` no frame do comando** — ele entra na resposta casada do RCON e
  a quebra. O Workshop adia o push em 0,1 s por isso.
- **`arg.Args` é `Facepunch.StringView[]`**, não `string[]`: tratar como string
  compila, roda e devolve lixo em silêncio.
- **`SkinId = 0` em item sem skins derruba o jogador.** Omita o campo.
- **Lote de carga fora de ordem é descartado inteiro**, e a cópia anterior
  sobrevive.

### Pronto quando

- `origemz.passe.bytes` (o `MeasureWorstCase` copiado) com o número **real**
  substituindo a estimativa do [03](03-MENU-DO-PASSE.md) §4.2.
- `core/scripts/pluginlint/` limpo.
- Teste de que o quinto card não quebra a home.
- **Validado ao vivo com o dono** — plugin só se testa assim.

---

## 7. Frente E — o painel

**Depende de:** A.

### O que fazer

As sete abas do [05](05-O-PAINEL.md) §3, o item na sidebar, os tipos em
`api.ts`, e **`normalize.ts` com um `safeX` por tipo** — este passo não é
opcional: `api.ts:143` é um cast, e campo omitido derruba a página inteira.

A aba **Trilha** usa o `RewardList` que já existe. A aba **XP** oferece o
cardápio que a frente B serve, e avisa sobre as fontes com pegadinha.

### Pronto quando

- `panel/test/battlepass-normalize.test.ts` cobrindo: campo omitido vira padrão,
  enum desconhecido vira `null`, booleano ausente cai no lado seguro, id grande
  continua texto.
- `lint`, `typecheck`, `test` e `build` do painel limpos.

---

## 8. Frente F — skin como recompensa

**Depende de:** nada. Independente.

Novo `kind: 'skin'` em `QuestReward`, no contrato compartilhado — missões e KOTH
ganham junto. Entrega pelo caminho que já existe (`workshop-owned-repository`,
com prazo e renovação resolvidos).

E mais duas coisas, que vêm da decisão sobre DLC:

- **uma marca no cadastro da skin dizendo se ela é DLC.** Sem ela, ninguém sabe
  o que verificar. Não é opcional.
- **a verificação de posse na entrega**, com `deadButton` na tela para quem não
  tem a DLC — o botão que **diz por quê**, em vez de esconder o prêmio.

**Pronto quando** o `RewardList` oferece skin, o agente entrega, quem não tem a
DLC vê o motivo, e o nível dele conta como resgatado — para não ficar preso numa
trilha que nunca fecha.

**Depende da sonda** do §10: se `CheckSkinOwnership` não for consultável no
servidor, esta frente encolhe para "só skin nossa do Workshop".

---

## 9. Frente G — venda pelo site

**Depende de:** C, e do agente do site.

Um `Docs/37` no molde do 24 e do 26, pedindo: o `kind` novo na fila de entregas,
um tipo de produto do lado de lá, e a régua do mês. Deste lado:
`payloadSchemas.pass`, o `DeliveredKind`, o `planOfPayload`, e **pular o portão
de presença** como o VIP — o direito é uma linha de tabela, não precisa do
jogador online.

**Fora do caminho crítico.** O passe vende in-game sem esta frente.

---

## 10. O que não é de nenhuma frente

As decisões que bloqueavam frentes foram todas tomadas pelo dono em 17/09/2026:
**XP por servidor**, **direito comprado por servidor**, **tela no plugin**, **não
resgatado é entregue** (com a caixa) e **skin de DLC só para quem tem a DLC**.

Nenhuma frente está bloqueada. O que sobra é pequeno e não impede começar:

1. **O estorno de um passe já usado revoga o direito?** Toca a frente C, e só na
   parte do estorno.
2. **Vender o passe do mês seguinte antecipadamente?** Fora da primeira versão.

E uma tarefa que não é de nenhuma frente porque vem **antes** de todas elas: a
**sonda de posse de DLC** — um plugin descartável que responde se
`CheckSkinOwnership` é consultável do lado do servidor. Se for, a skin de DLC
entra na trilha como o dono decidiu. Se não for, a regra volta a ser só skin
nossa do Workshop, e a frente F muda de tamanho. Dez linhas de C#, e ela
desbloqueia uma decisão de produto.
