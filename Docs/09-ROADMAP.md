# 09 — Roadmap

A ordem abaixo é de **dependência**, não de vontade. Cada fase precisa da
anterior de pé.

---

## Fase 1 — Núcleo multi-servidor

Criar, instalar, subir, parar, atualizar e instalar plugin, por vários
servidores independentes, pela tela. Detalhe em
[01-VISAO-E-ESCOPO.md](01-VISAO-E-ESCOPO.md).

**Termina quando** o critério de aceite roda inteiro numa máquina limpa.

---

## Fase 2 — Os plugins, reformulados

O agente já instala qualquer `.cs`. Esta fase é sobre **os nossos**.

- repositório de plugins (fora ou dentro deste repo — decidir na hora)
- compilação: `Directory.Build.props` + MSBuild, disparada pelo painel
- o contrato agente↔plugin, reescrito: hoje são dois comandos de console que
  respondem JSON de uma linha (`origemz.players`, `origemz.give`). O que vem
  precisa nascer versionado — um campo `contract` na resposta, e o agente
  recusando o que não entende;
- instalar **conjunto** de plugins num servidor novo, não um a um.

**Depende da Fase 1** porque instalar plugin exige servidor instalado e RCON.

---

## Fase 3 — Jogadores e acesso

- base de jogadores (`players`), alimentada pelas avistagens do RCON —
  sobrevive ao wipe, que é o que permite ranking de três meses num servidor que
  zera o mundo toda semana;
- admins por servidor, com nível;
- login por **Steam OpenID + PIN** no painel, substituindo o login de operador
  (D5) sem removê-lo: o operador continua sendo o caminho de emergência.

**Depende da Fase 2** para os dados que só o plugin fornece (posição, vida,
tempo conectado). O básico (`playerlist`) já dá para começar.

---

## Fase 4 — Loja e entregas

- `POST /api/players/:steamId/give`, com **idempotência** por
  `Idempotency-Key` — a trava que impede entrega dupla quando o site dá retry;
- log de entregas persistido (a idempotência antiga vivia em memória e morria
  no restart);
- carteira / saldo, se o modelo pedir;
- catálogo de itens.

**Depende da Fase 3** (jogador) e da Fase 2 (o plugin que entrega).

---

## Fase 5 — VIP

Níveis, prazos, expiração automática, escopo por servidor ou de rede, e a
sincronia com o jogo. É a parte com mais regra de negócio do projeto antigo, e
a que mais merece ser reescrita com calma.

---

## Fase 6 — Wipe, calendário e mensagens  ← entregue

**Planejada em** [16-PLANO-WIPE-CALENDARIO-MENSAGENS.md](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md),
**construída** por dez frentes paralelas
([17-FRENTES-WIPE-E-MENSAGENS.md](17-FRENTES-WIPE-E-MENSAGENS.md) e
[18-PROMPTS-DAS-FRENTES.md](18-PROMPTS-DAS-FRENTES.md)). As rotas estão em
[06-API.md](06-API.md).

O que está na árvore:

- **a agenda**: cadência por servidor, o forçado da Facepunch (primeira quinta às
  19:00 UTC) derivado do cálculo, e as três saídas para quando os dois colidem
  (`reanchor`, `absorb`, `ignore`);
- **a fila de mapas**: seed e tamanho por rodada, mapa custom com a URL conferida
  na borda, e a prévia do RustMaps — que nunca segura um wipe;
- **a execução**, em oito passos retomáveis (`avisar`, `esvaziar`, `parar`,
  `backup`, `apagar`, `configurar`, `subir`, `pos-wipe`), com prévia do que será
  apagado e o backup antes;
- **os blueprints por VIP**: snapshot lógico antes de apagar, devolução no login
  de quem tem direito, com régua por nível e atraso em horas;
- **o agendador de mensagens** (que era a Fase 7): a lista de rede na barra
  lateral, os quatro ritmos, a janela de horário e as variáveis — é ele quem
  manda os avisos do wipe;
- **o calendário para o jogador**: a tela CALENDÁRIO no `/menu` do jogo e a rota
  `/wipe/upcoming/me`, recortadas pelo nível de VIP com o mesmo código.

Migrações **23** (`wipe-schedule`), **24** (`wipe-map-pool`), **25**
(`wipe-runs`), **26** (`messages`), **27** (`events`), **28** (`bp-snapshots`) e
**29** (`wipe-run-map-decision`, a escolha de mundo que a retomada relê em vez de
refazer).
No painel, a aba **WIPE** com seis sub-abas (Geral, Agenda, Mapas, Execução,
Blueprints, Configuração) e o item **MENSAGENS** na barra lateral. No plugin,
`origemz.bp.export` e `origemz.bp.restore`.

### O que NÃO foi validado

Escrito aqui porque é verdade, e porque quem pegar isto depois precisa saber
antes de prometer a alguém que funciona:

- **nenhum wipe foi executado contra um servidor de Rust de verdade.** O que
  existe são os testes do `core` e a leitura de disco do `preview`;
- **o plugin nunca foi compilado** — não há Oxide.Compiler nesta máquina. As
  APIs do jogo foram conferidas uma a uma com o Mono.Cecil contra o
  `Assembly-CSharp.dll` da instalação (é o que derrubou o `blueprints.Learn` do
  plano), mas conferir nome não é compilar;
- **os fixtures do RustMaps não são capturas reais.** Os códigos HTTP são
  confiáveis; os nomes dos campos, não. E o limite de requisições nunca foi
  medido com uma chave — o que a API responde em `announcedRateLimit` é o que
  ela *anuncia*;
- **a tabela `events` (migração 27) existe e nenhuma linha de código a lê.** Foi
  o combinado do [16 §12](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md): a tela do jogo
  e a grade do calendário vão ler wipes e eventos juntos, e descobrir o formato
  depois custaria refazer os dois.

Falta ainda, e não bloqueia nada do que está acima: a integração com o
`server-auto-update` — a atualização mensal **normalmente** zera o mapa, e
"normalmente" é a palavra certa: prometer wipe onde não há faz gente jogar fora
a base à toa.

---

## Fase 7 — O resto do produto

Em ordem de valor, não de dependência:

- ~~avisos automáticos de chat~~ → virou o **agendador de mensagens** do
  [16-PLANO-WIPE-CALENDARIO-MENSAGENS.md](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md) §10
  e **entregou junto com a Fase 6**, porque é ele quem avisa do wipe
- propagandas (overlay CUI) e o editor de UI
- webhooks e clientes de API com escopo
- OpenAPI de volta, com o teste que reprova rota sem documentação
- backup automático do banco e das saves

---

## O que provavelmente **não** volta

- **auto-update do agente pela API do GitHub** (launcher, releases, probation,
  rollback). Enquanto o dedicado for nosso e tiver git, isso é complexidade sem
  dono;
- **instalador `.exe` e serviço WinSW** — o PM2 cobre;
- **`.bat` e a pasta `Tools\`** — a lógica virou TypeScript, e voltar seria
  recriar a divergência que o projeto antigo tinha;
- **modo de compatibilidade `devserver`** — não existe instalação anterior numa
  árvore nova.
