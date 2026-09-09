# As frentes do OrigemZDungeon

Cada arquivo desta pasta é a **proposta de uma frente**: o diagnóstico do que
a base `DungeonBases 1.3.4` faz, o contrato de configuração, o C# pronto para
colar e o que o dono deve olhar no jogo para confirmar.

## Por que elas não editam o plugin

`Plugins/OrigemZDungeon.cs` é um arquivo só, e as frentes correm em paralelo.
Duas edições simultâneas ali produziriam um conflito que ninguém pediu — e o
tempo caro não é o de escrever o código, é o de **ler as 3.800 linhas da base**
e entender o que ela já resolveu.

Então cada frente lê, projeta e entrega. **Quem integra, compila e testa no
jogo é o coordenador**, um de cada vez.

## As frentes

| arquivo | o que ela decide | agente |
|---|---|---|
| `ia.md` | o que o inimigo FAZ: perceber, perseguir, atirar, voltar ao posto | `event-ia` |
| `loot.md` | o que o jogador leva embora: caixas, tabelas, drop, respawn | `event-loot` |
| `portas.md` | abrir e resistir: porta por cor, cadeado, código, grau da peça | `event-portas` |

Os agentes vivem em `.claude/agents/`, versionados de propósito: eles carregam
as armadilhas que já custaram caro, e perder isso é repeti-las.

## O que toda proposta tem de responder

1. **O que a base 1.3.4 faz**, com número de linha. Ela rodou em servidor de
   verdade; nós não;
2. **Todo número é configurável.** É regra do dono. Nada de constante no meio
   da função — campo da receita, em inglês, com faixa e padrão sensato;
3. **O que foi medido e o que não foi.** Um palpite apresentado como medição é
   pior que nenhuma informação;
4. **O que olhar no jogo.** Nenhum dos defeitos desta semana apareceu em
   typecheck, lint ou contagem de peças: a porta que só batia, o corredor
   virado em cubículos, o teto aberto para o mundo. Todos foram achados pelo
   dono, jogando.

## A regra que vale para as três

**Todo prefab tem de vir de um arquivo que já roda** — a base ou um plugin
instalado —, nunca de memória. Um caminho errado devolve `null`, o `return`
engole, e a masmorra sobe com o defeito calado.
