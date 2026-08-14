# 01 — Visão e escopo

## O que o agente faz

Uma máquina dedicada hospeda **vários servidores de Rust**. Cada um tem a sua
instalação, as suas portas, o seu mundo, os seus plugins e o seu ciclo de vida.
Hoje isso é feito por linha de comando, `.bat` e paciência.

O RustAgent é o processo que fica ligado nessa máquina e faz tudo isso pela
tela:

```
   navegador                RustAgent (este projeto)               a máquina
  ┌────────────┐  HTTP     ┌────────────────────────┐  spawn      ┌──────────────┐
  │  painel    │ ────────► │  Fastify + SQLite      │ ──────────► │ steamcmd.exe │
  │  (Next.js) │ ◄──────── │  supervisor de servers │ ◄────────── │ RustDedicated│
  └────────────┘   JSON    └────────────────────────┘  WebRCON    └──────────────┘
```

O botão que define o produto é este:

> **Criar servidor → Instalar → Iniciar.** Sem abrir terminal, sem baixar
> SteamCMD à mão, sem editar `.bat`, sem saber que porta usar.

---

## Os cinco verbos

Tudo na Fase 1 existe para servir a estes cinco:

| Verbo | O que acontece de verdade |
|---|---|
| **Criar** | grava `Configs\<id>.ini` + a linha em `servers`, escolhe um bloco de portas livre, e não instala nada |
| **Instalar** | garante o SteamCMD (baixa e prepara se não houver), roda `+app_update 258550 validate` no `Servers\<id>\`, instala o Oxide por cima |
| **Iniciar** | sobe o `RustDedicated.exe` daquele servidor, destacado do agente, e conecta o WebRCON |
| **Parar** | `quit` pelo RCON (salvando o mundo), com `force` para o caso feio |
| **Atualizar** | avisa no chat, conta o tempo, salva, encerra, roda o SteamCMD, reinstala o Oxide, sobe de novo |

Cada servidor passa por eles **de forma independente**: instalar o `pvp2` não
toca no `pve`, e derrubar um não derruba o outro. A única coisa compartilhada
na máquina é o próprio SteamCMD — um cliente só, com um lock só (ver
[05-OPERACOES.md](05-OPERACOES.md)).

---

## Fase 1 — o que entra agora

**Núcleo multi-servidor.** É o recorte escolhido: o que faz um servidor existir,
instalar, subir, atualizar e aparecer numa tela.

### Core

- **configuração** — `.env` do agente + um `.ini` por servidor
- **banco** — SQLite (`better-sqlite3`) com migrações versionadas
- **registry + supervisor** — quem são os servidores, ligar e desligar sem
  reiniciar o agente
- **WebRCON** — cliente persistente por servidor, com reconexão e correlação
  de frames
- **operações** — SteamCMD, Oxide, start, stop, restart, update; trava global,
  log incremental, `202` com acompanhamento
- **vigia da Steam** — compara o build instalado com o publicado e avisa (ou
  atualiza sozinho, se ligado)
- **plugins** — instalar/remover/listar `.cs` em `Servers\<id>\oxide\plugins`
  pelo painel, e recarregar por RCON
- **HTTP** — Fastify, bearer token para integrações, sessão de operador para o
  painel, `/health`

### Painel

- login do operador
- lista de servidores (estado, portas, build instalado, jogadores online)
- criar servidor (formulário com prévia das portas)
- página do servidor: instalar / iniciar / parar / atualizar, com **log ao vivo**
- gerenciador de plugins do servidor
- tela de configuração básica do agente

---

## Fase 1 — o que **não** entra

Nada disto é descartado; está em [09-ROADMAP.md](09-ROADMAP.md) com a ordem de
volta. O que muda é que **não bloqueia** a Fase 1.

| Fora agora | Por quê |
|---|---|
| loja, entregas, idempotência (`give`) | depende do plugin, e o plugin vai ser reformulado |
| VIP, admins, jogadores, ranking | mesma razão; e é a metade maior do banco antigo |
| propagandas (ads) e editor de UI/CUI | produto à parte, em cima do mesmo agente |
| wipe programado e fila de mapas | precisa do servidor no ar primeiro |
| avisos automáticos de chat | depende do plugin de chat |
| login por Steam OpenID + PIN por servidor | a Fase 1 tem um operador só; ver [03-DECISOES.md](03-DECISOES.md) |
| webhooks, clientes de API, integrações | ninguém consome ainda |
| auto-update do próprio agente, installer, serviço Windows | substituídos por `git pull` + PM2 |

### Os plugins OrigemZ*

**Não vêm para este repositório agora.** Eles serão reformulados, e trazer o
código atual só garantiria migrar duas vezes.

O que a Fase 1 **entrega** é o outro lado: a tela que **instala plugin** num
servidor. Ela funciona com qualquer `.cs` — os OrigemZ* de hoje, os
reformulados de amanhã, ou um plugin de terceiro baixado do uMod. O agente não
precisa conhecer o plugin para instalá-lo; só precisa saber onde ele mora e
como pedir `oxide.reload`.

---

## O que "pronto" significa na Fase 1

O critério de aceite é uma sequência, feita numa máquina limpa, sem terminal:

1. `git clone`, `npm install`, `npm run build`, `pm2 start` — o agente sobe;
2. abrir o painel, entrar;
3. **Criar servidor** `pvp1` — portas sugeridas, `.ini` escrito, servidor
   aparece na lista como *não instalado*;
4. **Instalar** — o SteamCMD é baixado sozinho, os ~6 GB descem, o Oxide entra,
   e o log aparece na tela enquanto acontece;
5. **Iniciar** — o servidor sobe, o RCON conecta, a lista mostra *no ar* e os
   jogadores online;
6. **Instalar um plugin** `.cs` pela tela, e vê-lo carregado;
7. **Criar `pvp2`** e repetir — sem que nada do `pvp1` seja afetado;
8. **Atualizar** um deles com contagem regressiva, e o outro seguir no ar.

Enquanto essa sequência não rodar inteira, a Fase 1 não acabou.
