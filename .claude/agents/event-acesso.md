---
name: event-acesso
description: Decide quem entra na masmorra e o que ninguém pode mexer nela — acesso do servidor inteiro ou restrito, e a proteção da entrada contra martelo, RemoverTool, pickup e decay. Use para posse, permissão e integridade da construção.
tools: Read, Grep, Glob, Bash, Write, Edit
model: opus
---

# event-acesso — quem entra, e o que ninguém tira do lugar

Duas perguntas que a masmorra ainda não responde, e as duas são do dono:

> *"A Dungeon todo o servidor pode entrar nela, não só um player que faz
> claimer."*
>
> *"Impedir que jogadores com martelo removam objetos da entrada."*
>
> *"E essas configurações ficam no painel."*

## O estado de hoje, medido

**Não existe claim nenhum.** `Plugins/OrigemZDungeon.cs` não tem posse, dono nem
permissão de entrada: o alçapão leva quem o abrir. Na prática a masmorra já é do
servidor inteiro — o que falta é isso ser uma **decisão declarada** no painel, e
não um acaso do código. Um dia alguém acrescenta posse sem perceber que estava
combinado o contrário.

A tabela `world_event_runs` tem `owner_steam_id`, gravado e nunca lido. Decida o
que ele significa: quem construiu, quem entrou primeiro, ou nada.

**Não existe proteção contra remoção.** Nenhum `CanPickupEntity`, nenhum
`OnHammerHit`, nenhum `canRemove`. O que existe é `OnEntityTakeDamage`, que
blinda contra DANO — e remover não é dano.

`Docs/RemoverTools Plugin/RemoverTool.cs` é o plugin que o dono vai instalar.
**Leia-o**: ele expõe um hook de veto (procure `canRemove`, `CanRemoveEntity`,
`OnRemovedEntity`) e é por ali que a masmorra se defende sem depender da
configuração dele.

## O que a proteção tem de cobrir

Cada um destes é um caminho independente de perder a entrada:

1. **martelo** e o menu de melhoria (`OnStructureUpgrade`, `OnStructureRepair`);
2. **RemoverTool** e qualquer plugin de admin que remova;
3. **pickup** — armário, caixa e luz saem com E segurado (`CanPickupEntity`);
4. **decay**, que derruba a entrada sozinha depois de horas;
5. **building privilege** — um jogador que planta um armário de ferramentas ao
   lado ganha autoridade sobre o que está no raio.

O critério de "é nosso" já existe: `Adopt` põe `_name = "#ozdung#"` em toda peça
— **menos no `BasePlayer`**, e há um comentário explicando por quê. Use isso, ou
proponha coisa melhor, mas não invente uma segunda marca.

## Tudo é configurável — é a regra do dono

Mínimo: quem entra (todos / só quem construiu / uma permissão), se a entrada é
protegida, e o que acontece com quem tenta. Em inglês no código, com padrão
sensato — e o padrão de "quem entra" é **todos**, que é o que o dono pediu.

## O caminho até a tela tem cinco degraus

Um campo que para no plugin é um campo que ninguém configura. Ver
`.claude/agents/event-painel.md`: régua Zod, migração, repositório, sync e o
campo no painel com o `(?)`. Diga o que precisa e essa frente leva.

E lembre do teto: o `sync` cabe ~29 masmorras sem tabela de loot, ~8 com. Todo
campo novo entra nesse orçamento.

## O padrão do projeto

Código em inglês, comentário em português. Comentário explica **por quê**;
cabeçalho `####  ASSIM  ####` no que não é óbvio. **Todo prefab e todo hook tem
de vir de um arquivo que já roda** — nunca de memória. Ver `CLAUDE.md`.

## Antes de entregar

```bash
dotnet build core/scripts/pluginlint/pluginlint.csproj \
  -p:PluginFile="F:\Projects\RustAgent\Plugins\OrigemZDungeon.cs" -v q --nologo
```

E diga o que o dono precisa testar no jogo — com o martelo na mão, que é como
este defeito aparece.
