# 07 — O painel (Fase 1)

Next.js com **export estático**: `npm run build -w panel` gera `panel/out`, e o
core serve esses arquivos com `@fastify/static`. Um processo só, uma porta só,
e nada de servidor Node do Next em produção.

Em desenvolvimento o painel roda em `localhost:3100` e fala com o core em
`127.0.0.1:8787`.

---

## As telas

```
  /entrar             login do operador
  /                   os servidores, lado a lado, + criar
  /servidor?id=<id>   a página de um servidor  (abas)
  /config             o agente
```

Quatro. O painel antigo tem doze, e a diferença é exatamente o escopo da Fase 1.

Duas decisões tomadas na implementação, e o porquê de cada uma:

**A lista e a visão geral são a MESMA tela.** O plano previa `/` e `/servidores`
separadas; construindo, as duas mostravam o mesmo conteúdo com títulos
diferentes. Duas telas iguais é manutenção dobrada para nada — o botão *Criar
servidor* mora na de cima.

**`/servidor` usa query string, e não `/servidor/[id]`.** O painel é export
estático: uma rota dinâmica exigiria `generateStaticParams`, ou seja, saber em
tempo de **build** quais servidores existem. Eles nascem em tempo de execução,
pelo próprio painel. Query string resolve sem subir um servidor Next só para
isso.

---

## `/` — a visão geral

Um cartão por servidor, e o cartão responde de longe:

```
┌──────────────────────────────────────────────┐
│  PVP 1                              ● no ar  │
│  OrigemZ | PVP x5                            │
│                                              │
│  42/200 jogadores      mapa Procedural 4000  │
│  28015 · 28016 · 28017 · 28082               │
│  build 24253458                    em dia ✓  │
│                                              │
│  [ Abrir ]   [ Parar ]                       │
└──────────────────────────────────────────────┘
```

Os estados possíveis do ponto, e o que cada um quer dizer:

| | Estado | Significa |
|---|---|---|
| ● cinza | **não instalado** | cadastrado, sem jogo em disco. Botão: *Instalar* |
| ● cinza | **parado** | instalado, processo fora do ar. Botão: *Iniciar* |
| ● amarelo | **iniciando** | processo no ar, RCON ainda não respondeu (mapa gerando) — com o tempo decorrido |
| ● verde | **no ar** | RCON conectado |
| ● laranja | **atualização disponível** | build publicado ≠ instalado |
| ● vermelho | **sem RCON** | processo no ar e RCON não responde há mais de 2 min |

O "iniciando" com cronômetro não é enfeite: um mapa procedural de 4000 leva
minutos, e sem essa informação a tela parece travada e alguém clica em Iniciar
de novo.

---

## `/servidores` — a lista e o botão de criar

Tabela com id, nome, estado, portas, build, jogadores. E o **Criar servidor**.

### O formulário

| Campo | Detalhe |
|---|---|
| id | minúsculas, dígitos e hífen; vira o nome do `.ini` e das pastas. Não muda depois |
| nome | o rótulo no painel |
| hostname | o que o jogador lê na lista do Rust |
| mapa | `Procedural Map`, `Barren`, `HapisIsland`, … |
| worldSize / seed | seed em branco = a do modelo |
| maxPlayers | |
| senha do RCON | gerada por padrão; sem `/ \ ? #` nem espaço |
| bloco de portas | pré-preenchido com o primeiro livre, e as quatro portas aparecem ao lado |

Ao salvar, o servidor aparece na lista como **não instalado**, e a tela já
oferece *Instalar* — que é o passo seguinte de verdade.

---

## `/servidor/[id]` — a página do servidor

Cabeçalho com o estado e os botões que **aquele estado** permite (vindos de
`kinds` na resposta de `GET .../operations` — a tela não adivinha).

Abas:

### Visão

Estado, portas, build instalado × publicado, caminho da instalação, tamanho em
disco, últimas linhas do log do servidor.

### Operações

Os botões grandes, e o **log ao vivo**:

```
  [ Instalar / Atualizar ]   [ Iniciar ]   [ Parar ]   [ Reiniciar ]

  ┌── server-install ─────────────────────── 42% ──┐
  │ [SteamCMD] Baixando/validando o servidor...    │
  │ Update state (0x61) downloading, progress: 42  │
  │ …                                              │
  └────────────────────────────────────────────────┘
                              [ Cancelar operação ]
```

O log rola sozinho enquanto está no fim, e para de rolar quando a pessoa sobe —
senão não dá para ler a linha de erro que passou.

**Parar** abre confirmação; **Parar à força** é um segundo botão, vermelho,
dentro dessa confirmação, com o texto dizendo o que se perde.

### Plugins

Lista dos `.cs` daquele servidor, com envio por arrastar-e-soltar. Cada linha
tem *Recarregar* e *Remover*. Depois de enviar, a resposta do Oxide aparece na
tela — inclusive o erro de compilação, se houver.

### Configuração

Os campos do `.ini` que dá para mudar pelo painel, com aviso claro do que só
vale depois de reiniciar o servidor.

---

## `/config` — o agente

Porta e host da API, `OPS_ENABLED`, auto-update da Steam ligado/desligado,
intervalo de verificação, caminho das pastas, versão do agente, e o botão de
trocar a senha do operador.

---

## Como o painel conversa com o core

- **sessão em cookie** `HttpOnly`; o `csrfToken` vem no login e vai em todo
  POST/PATCH/DELETE;
- **polling**, não websocket: a lista de servidores a cada 5 s, o log de
  operação a cada 1 s enquanto há operação rodando. Um websocket a mais é uma
  reconexão a mais para tratar, e o volume aqui não justifica;
- **erro sempre com a frase do core**. O painel não reescreve mensagem: quem
  conhece a regra é quem a escreveu. O que a tela acrescenta é o botão que
  resolve — "o SteamCMD está ocupado com o `pve`" vem com *Ver operação*.

---

## O que a tela nunca faz

- **não esconde botão porque "não deve dar certo"** — ela mostra o que o estado
  permite e deixa o core recusar com o motivo. Botão sumido não ensina nada;
- **não afirma "em dia" quando a consulta falhou** — `lastError` vira um aviso
  em vermelho. Falhar em perguntar não é estar em dia;
- **não guarda segredo em `localStorage`** — a sessão é o cookie, e o token de
  API nunca chega ao navegador.
