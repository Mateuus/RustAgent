# OrigemZWorkshop — plano e frentes

Como dividir a reformulação ([02](02-SKINS-DO-JOGADOR.md), [03](03-MENU-DE-SKINS.md),
[04](04-ENTREGA-PELO-SITE.md)) entre agentes que trabalham ao mesmo tempo sem pisar um no
outro.

Cada frente abaixo é **um agente, uma worktree e uma branch**. O prompt de cada agente deve
mandá-lo ler o 02 inteiro, a seção do 03 ou do 04 que lhe cabe, e **esta seção dele**.

---

## 1. A ordem

```text
  fase 0 — medições no jogo (com o dono) ─────────────────────────────┐
                                                                      │ ajusta o 03
  A — agente: banco, posse e cargas ──┬──→ C — entrega do site        │
                                      ├──→ E — painel                 │
  D — plugin e menu ──────────────────┴──(usa o contrato do 02 §5)────┘
                                      └──→ F — aba no menu + a pedra
```

- **A** vai primeiro, porque é ela que cria os tipos e a migração 097. **C** e **E** partem do
  commit da A.
- **D** pode começar **junto com a A**: o contrato que ela consome está escrito no 02 §5, e o
  plugin se testa com carga feita à mão.
- **A fase 0** roda em paralelo com a D, porque os resultados dela mudam o 03 (rolagem, botão
  no inventário). A D escreve primeiro o que **não depende** dela: a paginação e o `/skins`.

### A branch de integração

```bash
git worktree add F:/Projects/RustAgent-skins -b skins-do-jogador origin/main
```

Cada frente sai da `skins-do-jogador` na **sua** worktree (receita na memória *worktree
paralela neste repo*: junctions do `node_modules`, `next dev --webpack`) e volta para ela por
merge, **na ordem A → C → E → D → F**. No fim, um PR só da `skins-do-jogador` para a `main`
(memória: *este projeto entrega por PR*).

### As regras que valem para todas as frentes

1. **Um agente só roda contra o banco de desenvolvimento, e é o da A.** A 097 entra no banco,
   e dali em diante qualquer agente com código velho recusa subir (`db/schema-version.ts`).
   Quem precisar de API nas outras frentes usa teste ou API falsa.
2. **`git add` por caminho explícito.** As worktrees de subagente moram dentro do repositório.
3. **Identificador em inglês, texto em português** (regra global do dono).
4. **Nada de migração fora da 097.** Se uma frente precisar de coluna, pede à A.
5. **O plugin só se testa ao vivo com o dono no jogo**, depois do `pluginlint`.

---

## 2. Fase 0 — medições no jogo

**Quem:** um agente com acesso ao server01, e o dono conectado.
**Entrega:** uma seção "Medido em …" acrescentada ao 03 §8 e ao 02 §6.3, com o resultado de
cada item. **Nada de código de produção.** Os plugins descartáveis ficam fora do repositório,
ou são apagados no fim (memória: *sondar a API do jogo ao vivo*).

| # | O quê | Como |
|---|---|---|
| 0.1 | ScrollView não derruba o jogador | plugin descartável, só o admin conectado, `CuiScrollViewComponent` completo (03 §8.1) |
| 0.2 | o botão na camada `Inventory` aparece só com o inventário e o clique funciona | 03 §4.1 |
| 0.3 | troca de skin no lugar: roupa vestida vista **por outro jogador**, mochila vestida, arma na mão | 02 §6.3; se `MarkDirty` não bastar, testar `player.SendNetworkUpdate()` |
| 0.4 | um `AddUI` de ~40 KB direto pelo plugin | 03 §6 |
| 0.5 | o sprite do cadeado | 03 §3.3 |
| 0.6 | a janela em 16:9 e 21:9 | 03 §8.6 |

Para o 0.3 com "outro jogador", basta um segundo cliente ou um bot que o dono consiga olhar.
**Se não houver segundo jogador, registre isso**; não deduza.

---

## 3. Frente A — agente: banco, posse e cargas

**Tipo de agente:** `general-purpose`. Na revisão, `ecc:typescript-reviewer` e
`ecc:database-reviewer`.

### O que fazer

1. **Migração 097** em `core/src/db/migrations.ts` (02 §4 inteiro, inclusive o 4.3 e o 4.4).
2. **Contrato** em `core/src/types/workshop.ts`:
   - saem coleção, acesso, grupo e permissão;
   - entram `description`/`rarity`/`sort` na skin, o tipo `OwnedSkin` e os corpos das rotas
     novas;
   - entram os payloads do 02 §5.1 e §5.2.
3. **Repositórios:**
   - `workshop-repository.ts`: sem coleção;
   - `workshop-access-repository.ts` vira `workshop-owned-repository.ts`, com
     `grantOwnership` (a tabela do 02 §4.2), `revokeOwnership`, `listOwned`,
     `liveOwnedForPlayer`, `nextExpiry` e `expiredBetween`;
   - a auditoria continua ali.
4. **Regras** em `core/src/game/workshop-catalog.ts`: `grant`/`revoke` passam a ser de posse.
   Saem as de coleção.
5. **Cargas** em `core/src/game/workshop.ts`:
   - catálogo sem acessos (02 §5.1);
   - `origemz.workshop.owned` por jogador (02 §5.2), com os quatro gatilhos. O de entrada é
     no `onJoined` de `core/src/index.ts:738`;
   - vencimento reenviando só o jogador afetado;
   - `handleLine` aceitando `give` (02 §7).
6. **Rotas** em `core/src/http/routes/workshop.ts` e `players.ts` (02 §10).
7. **Testes** em `core/test/workshop.test.ts`:
   - a tabela de renovação do 02 §4.2 inteira;
   - a migração com dados (§4.3), incluindo grupo descartado com auditoria e coleção
     expandida;
   - carga de posse vazia sendo mandada;
   - carga de posse em pedaços.

### Pronto quando

- `npm test -w core` passa, e `npx tsc --noEmit` também;
- a 097 rodou no banco de dev **e** numa cópia com acessos de grupo e de coleção fabricados, com
  as contagens conferidas;
- o comando de contagem para produção está escrito no fim do 02 §4.3 (um `sqlite3` com os três
  `SELECT COUNT(*)`);
- um `curl` com o bearer (memória: *o bearer do .env abre a API inteira*) dá e tira uma posse,
  e a linha `origemz.workshop.owned` aparece no console do server01.

---

## 4. Frente C — entrega do site

**Tipo de agente:** `general-purpose`. Parte do commit da A.

### O que fazer

É o 04 §6 inteiro: cliente, espelho, `skin`/`skin_revoke`, `SiteDeliveryKind`, a ligação no
`index.ts` e os testes. **O CHECK da tabela já veio na 097 da A.**

### Pronto quando

- os testes cobrem cada linha da tabela de recusas do 04 §3, mais o `skin_revoke` sem posse e
  a entrega repetida (mesmo `DLV`);
- 404 no espelho vira um `debug` por boot, e não um aviso a cada 10 minutos;
- `contracts/oz-rust-fixtures.json` ganhou os corpos novos **marcados como proposta**. A troca
  para `oz-rust/8` é feita junto com quem mantém o site.

**Fora desta frente:** o lado do site (04 §5). Entregue o 04 a quem o mantém.

---

## 5. Frente E — painel

**Tipo de agente:** `general-purpose`. Na revisão, `ecc:react-reviewer`. Parte do commit da A.

### O que fazer

É o 02 §9:

- `panel/src/app/workshop/page.tsx`:
  - some a aba Coleções;
  - Acessos vira Posse;
  - o formulário da skin muda;
- `panel/src/components/workshop/`:
  - apagar `collections-panel.tsx`, `collection-form.tsx` e `collection-skins-editor.tsx`;
  - reescrever `access-panel.tsx` como `owned-panel.tsx`;
- a aba **Skins** em `panel/src/app/jogador/page.tsx`;
- os blocos de `panel/src/lib/api.ts`;
- o `normalize.ts`.

### Pronto quando

- `npx tsc --noEmit` e `npm run build -w panel` passam;
- as três telas foram conferidas com captura real da API (memória: *conferir tela do painel sem
  a senha*);
- nenhuma página quebra com campo faltando na resposta: `description` e `rarity` ausentes
  precisam renderizar;
- `panel/AGENTS.md`, `panel/CLAUDE.md` e `panel/next-env.d.ts` **fora** do commit.

---

## 6. Frente D — plugin e menu

**Tipo de agente:** `general-purpose`. Na revisão, `ecc:csharp-reviewer`. É a maior frente.

### O que fazer

Em `Plugins/OrigemZWorkshop.cs`, a versão sobe para **0.3.0**.

1. **Remover:**
   - a caixa (§6 do arquivo de hoje: `OpenBox`, `CanPutInBox`, `DrawBox`, os
     `origemz.skin.pick/reset/page`, o relógio de 1 s e os ganchos de loot);
   - as coleções (`ApplyCollection`, `CollectionEntry` e os índices);
   - a permissão por skin;
   - o acesso por grupo.

   **Antes de apagar a caixa**, confira que o `Unload` e os ganchos de morte, desconexão e
   ferimento continuam devolvendo o que precisarem. Depois de remover a caixa, não há mais
   item "emprestado".
2. **Ler a carga nova** (02 §5.1) e a **posse** (02 §5.2 e §5.3), com o `owned.json` e a poda de
   30 dias.
3. **`CanUseSkin`** com as três regras do 02 §3.
4. **Aplicar** com as conferências do 02 §6.2, usando o `ApplySkinToItem` que já existe mais o
   que a fase 0.3 mandar.
5. **O menu** inteiro do 03:
   - regiões com nome fixo;
   - estado por jogador;
   - token de sessão;
   - os comandos do 03 §5;
   - os casos do 03 §7.
6. **Os comandos de chat** do 02 §7.
7. **O botão no inventário**, só se a fase 0.2 passar.

### Pronto quando

- o `pluginlint` passa. Na worktree, com o `ManagedDir` absoluto (memória: *como validar plugin
  .cs sem subir servidor*);
- existe um helper de teste, ou um comando de admin `origemz.skins.bytes`, que imprime o tamanho
  de cada região. Todas ficam abaixo de 40 KB no pior caso: lateral com a categoria mais cheia
  aberta e 12 células com nome longo;
- **ao vivo, com o dono**, os oito passos:
  1. abrir por `/skins` com a AK na mão, que chega pré-selecionada;
  2. navegar categoria → item → página;
  3. pesquisar;
  4. aplicar numa AK da barra, com a munição e a condição iguais;
  5. aplicar numa mochila vestida com itens dentro, que continuam lá;
  6. voltar para Padrão;
  7. dar uma posse pelo painel com o menu aberto, e o cadeado some;
  8. morrer com o menu aberto, e o menu fecha.

**Atenção de C# 6** (memória e 00 §9.1): sem `out var`, sem *pattern matching*, sem interpolação
`$@`. E `arg.Args` é `StringView[]`, e não `string[]` (memória: *arg.Args não é string[]*): use
`arg.GetString(i)`.

---

## 7. Frente F — aba no menu e a pedra

**Pequena.** Pode ficar com quem integrar no fim.

1. **A aba SKINS** em `core/src/game/ui-preset-main-menu.ts`, com a ação `chat` → `skins`. O
   teste de bytes da carga inicial continua abaixo de 50.000. Lembre que o preset é upgrade de
   documento: ele só roda uma vez em quem já foi migrado (memória: *upgrade de documento só roda
   uma vez*). Confira como os presets existentes recebem aba nova **antes** de assumir que basta
   editar o arquivo.
2. **O menu principal fecha o de skins, e vice-versa** (03 §7, última linha). É uma chamada entre
   plugins; combine o nome do hook com a frente D.
3. **A pedra** (02 §8): é configuração, feita pelo painel depois de a skin da pedra estar
   publicada e cadastrada como **liberada para todos**:
   - a `rock` com a skin em cada loadout de nível;
   - o loadout do nível `admin`;
   - a pergunta da tocha ao dono.

---

## 8. O que não é de nenhuma frente

- **Publicar as skins no Workshop.** É do dono (00 §4).
- **O lado do site.** É de quem mantém o OrigemZSite (04 §5).
- **Atualizar o 00 e o 01.** O cabeçalho deles já aponta para cá. Quem fechar a
  `skins-do-jogador` acrescenta ao 01 §8 ("onde está cada coisa") a tabela final de arquivos.
