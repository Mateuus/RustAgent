# OrigemZTeam — levantamento

**Isto ainda não é uma especificação.** É o que o dono pediu em 15/09/2026 mais o que
foi MEDIDO no jogo no mesmo dia. O estudo completo — e as decisões que faltam — vem
depois, e vai morar nesta pasta.

Quem lê isto: quem for implementar a equipe nomeada, e o KOTH, que depende dela.

---

## 1. Por que ele existe

O KOTH pontua por **lado**, e um lado precisa de nome: o placar diz quem está ganhando,
a bandeira do território mostra de quem ele é, e a barra na tela do jogador diz por quem
ela está enchendo. "76561198…" não serve para nada disso.

A decisão do dono é aproveitar a **equipe nativa do Rust** em vez de inventar um sistema
de clã paralelo — o jogador já sabe usá-la, e ela já aparece no mapa, no HUD e na cor do
nome.

Depende disto: `Docs/KOTH/` (a família de evento que vai usar o nome da equipe).

---

## 2. O que o jogo já dá — medido, não suposto

Decompilado de `Servers/server01/RustDedicated_Data/Managed/Assembly-CSharp.dll`
(`ilspycmd -t RelationshipManager`) em 15/09/2026.

A classe `RelationshipManager.PlayerTeam` já tem:

| Campo / método | O que é |
|---|---|
| `teamID` (ulong) | A identidade. Vem de `Database.IncrementLastTeamIndex()` |
| `teamName` (string) | **O campo do nome já existe** |
| `teamLeader` (ulong) | O líder, por SteamID |
| `members` / `invites` (List<ulong>) | Quem está dentro, e quem foi chamado |
| `joinKey` | Código de entrada |
| `teamStartTime`, `teamLifetime` | Desde quando ela existe |
| `AddPlayer` / `RemovePlayer(playerID)` | Entrar e sair |
| `SetPlayerAsLeader(newTeamLeader)` | Passar a liderança |
| `Disband()` | Desfazer |
| `RelationshipManager.maxTeamSize` | ServerVar; padrão **8**. `0` desliga equipes |

E mais duas coisas que importam:

- **O nome persiste no save do servidor.** `teamName` entra e sai do protobuf
  (`Load`/`Save` do `RelationshipManager`), junto com líder, membros e convites.
- **O nome é sincronizado para o cliente** na mesma mensagem da equipe.

### O que NÃO é verdade

O jogo **não** batiza a equipe. Na criação e no reset, `teamName = string.Empty` — o
"Team Mateuus" que aparece na tela é o cliente mostrando o **nome do líder**, não um nome
guardado. Ou seja: o campo está lá, vazio, esperando alguém escrever nele.

Isso é a favor do plano — não há nome do jogo para brigar com o nosso.

### O que ainda não foi verificado

- **O cliente MOSTRA o `teamName` quando ele não está vazio?** Só dá para saber abrindo o
  jogo com o campo preenchido. Se mostrar, metade da tela de equipe é de graça; se não,
  o nome vive no nosso CUI e no painel. **Esta é a primeira coisa a medir.**
- Que hooks do Oxide existem em volta disso (`OnTeamCreated`, `OnTeamLeave`,
  `OnTeamDisbanded`, `OnTeamInvite`…) e até onde eles são chamados — o `ilspycmd` mostra.
- Se `teamName` sobrevive a um `Disband` + recriação com o mesmo id (não sobrevive: o id
  é novo), e o que isso significa para o histórico de vitórias.

---

## 3. O que o dono pediu

### No jogo, na aba **Equipe** do `/menu`

- Editar o **nome** da equipe.
- **Remover** um jogador da equipe.
- **Passar a liderança** para outro.
- **Promover** um jogador — ou seja, um **nível/cargo dentro da equipe**, acima de membro
  e abaixo de líder.

O cargo não é enfeite: a intenção declarada é usá-lo **depois** para outras coisas —
permissões dentro da base, por exemplo (quem abre o quê, quem mexe na TC).

### No painel, dentro do **servidor**

- Uma aba só de **Equipe**: as configurações do sistema.
- A **lista das equipes que existem no jogo agora**, com os SteamIDs de quem está em cada
  uma.

### Na tela de **Jogadores**

- Mostrar a equipe de que o jogador participa.

---

## 4. O que é nosso, e o que é do jogo

Separar isto cedo evita a pior classe de bug deste sistema — dois donos para o mesmo
dado, e o jogo ganhando a discussão no próximo restart.

| Dado | De quem é |
|---|---|
| Quem está na equipe, quem é líder, convites, tamanho máximo | **Do jogo.** O agente lê e manda comandos; nunca guarda uma cópia que decida |
| O nome (`teamName`) | **Do jogo**, mas quem escreve nele somos nós. Persiste no save |
| O **cargo** de cada membro | **Nosso.** Não existe no Rust. Precisa de tabela no agente, com `teamID` + SteamID |
| O que cada cargo PODE fazer | **Nosso**, e ainda indefinido |

### Equipe desfeita apaga tudo — decisão do dono, 15/09/2026

O cargo é nosso e a equipe é do jogo: desfeita e refeita, o `teamID` é outro, e os cargos
ficariam órfãos. A regra é a mais simples possível:

> **Quando a equipe é desfeita, tudo daquela equipe é apagado — inclusive os cargos.**

Vale para o `Disband()` do jogo e para o caso em que o último membro sai (o jogo desfaz a
equipe sozinho). Não há herança, não há cargo dormindo à espera de uma equipe futura com o
mesmo nome, e não há lixo em tabela nenhuma.

Na prática: a nossa tabela de cargos é apagada pelo `teamID` no hook de dissolução, e um
cargo cujo `teamID` não existe mais no jogo é lixo — a limpeza no boot pode varrer o que
sobrou de um agente que estava fora na hora.

---

## 5. Perguntas em aberto

1. O cliente mostra `teamName`? (§2 — é o primeiro teste)
2. Quem pode renomear: só o líder, ou também o cargo intermediário?
3. Nome de equipe passa pelo mesmo filtro de palavrão/tamanho das outras telas nossas?
   Ele aparece para todo mundo no KOTH — é conteúdo público.
4. Dois times com o mesmo nome: permitido? O `teamID` distingue, os olhos não.
5. O que acontece com o KOTH em curso quando a equipe vencedora se desfaz no meio? (A regra
   do §4 diz que os cargos somem com ela; o que acontece com o progresso e com o prêmio já
   conquistado é outra pergunta, e é do KOTH.)

---

## 6. O que NÃO fazer ainda

- A tabela de cargo já tem a regra de vida dela (§4): nasce com a equipe, morre com ela.
  O que ainda falta é o que cada cargo PODE fazer — e isso não se decide sozinho.
- Não duplicar a lista de membros no banco do agente: ela é do jogo, e uma cópia velha é
  pior que nenhuma.
- Não prender o KOTH ao `OrigemZTeam` antes de a equipe nomeada existir de verdade — a
  tela `/eventos/koth` já lista essa ordem de dependência.
