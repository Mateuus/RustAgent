# 09 — Roadmap

A ordem abaixo é de **dependência**, não de vontade. Cada fase precisa da
anterior de pé.

---

## Fase 1 — Núcleo multi-servidor  ← estamos aqui

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

## Fase 6 — Wipe

**Planejada em detalhe:** [16-PLANO-WIPE-CALENDARIO-MENSAGENS.md](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md),
com as frentes paralelas em [17-FRENTES-WIPE-E-MENSAGENS.md](17-FRENTES-WIPE-E-MENSAGENS.md).

- calendário (primeira quinta às 19:00 UTC, e o wipe semanal);
- fila de mapas com seed/tamanho por rodada;
- prévia do que será apagado, e o backup antes;
- integração com o `server-auto-update` — a atualização mensal normalmente zera
  o mapa, e "normalmente" é a palavra certa: prometer wipe onde não há faz
  gente jogar fora a base à toa.

---

## Fase 7 — O resto do produto

Em ordem de valor, não de dependência:

- avisos automáticos de chat → virou o **agendador de mensagens** do
  [16-PLANO-WIPE-CALENDARIO-MENSAGENS.md](16-PLANO-WIPE-CALENDARIO-MENSAGENS.md) §10,
  e sobe junto com o wipe (é ele quem avisa)
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
