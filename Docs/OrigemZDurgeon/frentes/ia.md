# Frente IA — o que o inimigo faz dentro da masmorra

Escrito por `event-ia` em 09/09/2026. **Não integrado**: o
`Plugins/OrigemZDungeon.cs` está sendo editado por outras duas frentes, e quem
cola isto é o coordenador.

O C# da §3 **compila** contra o Rust do `Servers/server01` (`pluginlint`,
rebuild completo, 0 erros) já inserido dentro do plugin real — não é um bloco
solto que "deve compilar".

---

## Índice

1. [O que a base 1.3.4 faz — com número de linha](#1)
2. [O contrato de configuração](#2)
3. [O C#, pronto para colar](#3)
4. [As seis linhas que mudam no plugin](#4)
5. [O que foi medido, e o que não foi](#5)
6. [O que o dono tem de olhar no jogo](#6)

---

<a id="1"></a>
## 1 — O que a base 1.3.4 faz, e por quê

Arquivo: `Docs/OrigemZDurgeon/DungeonBases-1.3.4.cs`, 3.883 linhas.

A IA dela cabe em três pedaços: um componente de dados (`SlabNPC`), a montagem
(`InitNPC`) e dois relógios — um de percepção e um de movimento.

### 1.1 `SlabNPC` — o componente, linhas 139-155

Não tem comportamento: é uma sacola de campos pendurada no cientista.

| campo | para quê |
|---|---|
| `moveTarget` (linha 143) | para onde o corpo está indo neste instante |
| `wayPoints` (144) | a trilha de migalhas — as posições por onde o **jogador** passou |
| `mainTarget` (145) | quem ele persegue; fora de combate aponta para **ele mesmo** |
| `targetIsVisible` (146) | teve linha de visada no último tick de percepção |
| `contact` (147) | está em combate |
| `isStatic` (148) | nasceu para não sair do lugar |
| `range` (149) | a que distância do `moveTarget` ele considera "cheguei" |
| `timer` / `timerAI` (141-142) | os dois relógios |

### 1.2 `InitNPC` — a montagem, linhas 822-1055

O que ela faz, na ordem, e o que cada linha evita:

- **linha 835 — `navigator.CanUseNavMesh = false`.** É a linha que sustenta
  tudo. A -90 metros não há NavMesh, e o navigator ligado passa o tick inteiro
  pedindo um caminho que não existe;
- **linhas 840-841 — guarda a posição de nascimento** em `spawnPos` e usa como
  primeiro `moveTarget`;
- **linhas 844-851 — reancora o NPC 5 segundos depois** (`npc.transform.position
  = spawnPos`). O comentário não existe, mas o motivo é claro: alguma coisa
  move o cientista nos primeiros segundos de vida e ele não amanhece onde
  nasceu;
- **linhas 861-870 — `damageScale`** em `ScientistNPC`, `TunnelDweller` e
  `UnderwaterDweller`, porque a base aceita os três prefabs;
- **linhas 891-892 — o nome**: `_name` recebe o nome de exibição e
  `_lastSetName` recebe `"#Scientist1818"`;
- **linha 895 — `ChangeWeapon`** (805-820): limpa a barra, põe a arma no slot 0
  e chama `UpdateActiveItem`. Sem o `UpdateActiveItem`, a arma fica na cintura;
- **linhas 897-898 — `range = 0.5f` e `mainTarget = npc`**: fora de combate ele
  é o próprio alvo. É o truque que faz o resto do código nunca lidar com `null`.

### 1.3 O relógio de percepção — 1 em 1 segundo, linhas 904-954

```
        se o NPC sumiu ......................... destrói o próprio timer
        rotação = identidade ................... (ver 1.5)
        sorteia um offset de ±0,2 m ............ para dois NPCs não empilharem
        se brain.Senses.Players tem alguém:
            raycast do NPC até o jogador (linha 926, máscara layerS)
            primeiro hit é o jogador?
                sim ..... contact=true, visible=true, range=5, limpa a trilha
                não ..... visible=false, range = (dist<1 ? 1 : 0,5)
        senão:
            mainTarget = ele mesmo, contact = false
```

Três coisas para reparar:

1. **Quem enxerga é o brain do jogo.** `brain.Senses.Players` (917) é
   preenchido pelo `ScientistBrain`, com o raio de sensor do PREFAB. Não há
   como o painel mudar isso — foi o primeiro motivo para a nossa IA não usar
   esse caminho;
2. **`range` vira 5 quando enxerga** (935). Não é alcance de tiro: é a
   distância em que ele para de andar. É o "não me abrace" da base;
3. **a máscara `layerS`** (linha 54) é escrita por negação:
   `~(1<<2 | 1<<3 | 1<<4 | 1<<10 | 1<<18 | 1<<28 | 1<<29)` — tudo menos
   Ignore_Raycast, Reserved1, Water, Invisible, Trigger, Prevent_Movement e
   Prevent_Building. Sobram trinta layers, e ninguém consegue dizer de cabeça
   quais.

### 1.4 O relógio de movimento — 5 vezes por segundo, linhas 956-1054

```
        se isStatic ............................ não faz nada (963)
        se |Δy| entre NPC e jogador > 2,5 m .... perde o contato (967)
        senão .................................. grava a posição do jogador
                                                 na trilha (975)
        consome a migalha mais antiga quando chega perto dela (986-995)
        anda 0,6 m na direção da migalha (1004)
        se está a menos de 5 m COM visada ...... não anda (1001)
```

`0,6 m` a cada `0,2 s` são **3 m/s** — mais rápido que um jogador andando
(≈2,8 m/s), mais lento que correndo (≈5,5 m/s).

**A trilha de migalhas é a ideia boa da base, e ela vem inteira para cá.** Sem
NavMesh não há como calcular caminho; pisando onde o jogador pisou, o cientista
dobra o corredor, atravessa a porta e contorna a parede sem saber que elas
existem.

### 1.5 As quatro coisas da base que NÃO vêm

1. **`npc.transform.rotation = identidade` a cada segundo** (linha 914). Isso
   trava o cientista virado sempre para o mesmo lado do mundo. A base precisa
   disso porque nunca chama `SetAimDirection` — e, medido na IL,
   `SetAimDirection` termina em `ServerRotation`, ou seja, **ela já gira o
   corpo**. Nós miramos; ela travava;
2. **`timer.Every` do Oxide para os dois relógios** (904 e 956). O de
   percepção se destrói quando percebe que o NPC sumiu (908-909); **o de
   movimento nunca se destrói**. Ele continua acordando de 0,2 em 0,2 segundo
   para cada cientista já morto até o plugin descarregar. Um componente
   (`FacepunchBehaviour`) morre com o `GameObject` e não tem esse problema;
3. **`mainTarget` apontando para o próprio NPC**. Economiza um `if` e custa a
   leitura de todo o resto do arquivo;
4. **o offset aleatório de ±0,2 m** (916) somado a cada migalha. Resolve o
   empilhamento de dois NPCs perseguindo o mesmo jogador, e produz um
   caminhar trêmulo. Aqui o empilhamento é resolvido pelo `standoffDistance`.

### 1.6 O que a base faz no dano — linhas 2121-2148

```csharp
private void OnEntityTakeDamage(NPCPlayer npc, HitInfo nhitinfo)
```

- **2131-2132**: se quem atirou é um NPC da masmorra (`name == "DungBaseNPC"`),
  o dano é zerado. Sem isso a sala se dizima sozinha na primeira rajada;
- **2143-2147**: levar tiro é uma forma de perceber. `contact = true`,
  `mainTarget = initiator`, e a posição do atirador entra na trilha. Sem isso,
  um jogador de mira boa limpa a masmorra pelas costas sem ninguém virar.

As duas coisas vêm para cá.

---

<a id="2"></a>
## 2 — O contrato de configuração

### 2.1 Onde ele mora

Um bloco `ai` em três lugares, e o de baixo sobrescreve o de cima **campo a
campo**:

```
   dungeons.npc.ai        ← o padrão desta masmorra
        ↓
   dungeon_rooms[cor].ai  ← o inimigo da sala vermelha
        ↓  (ou)
   dungeons.corridor.ai   ← o inimigo do corredor
```

Campo ausente **não é zero**: é "não falei disso", e o valor de cima fica de pé.
Por isso todo campo do `AiSpec` é anulável (`float?`, `bool?`). Sem isso,
`"fireInterval": 0` e "não mandei `fireInterval`" seriam a mesma coisa, e a
herança viraria substituição.

No `sync` (§7.1 do plano) isso vira:

```jsonc
{
  "npc": {
    "health": [120, 180],
    "damageScale": 1.5,
    "weapons": ["rifle.ak"],
    "names": ["Cientista"],
    "ai": { "visionRadius": 18, "fireRange": 15, "chaseRadius": 25 }
  },
  "rooms": [
    { "color": "red",   "npc": [3,5], "ai": { "aimConeScale": 0.8, "fireInterval": 0.25, "chaseRadius": 40 } },
    { "color": "green", "npc": [0,1], "ai": { "holdPosition": true, "visionRadius": 10 } }
  ],
  "corridor": { "npcDensity": 20, "ai": { "chaseRadius": 12, "returnHome": true } }
}
```

E no esquema (§6.2), como colunas em `dungeons` (prefixo `ai_`) e em
`dungeon_rooms` (`ai_` também, **anuláveis**, porque `NULL` ali é o "herda" do
parágrafo acima).

### 2.2 Os campos

#### Percepção

| campo | tipo | faixa | padrão | o que é |
|---|---|---|---|---|
| `visionRadius` | float (m) | 0–150 | **18** | até onde ele enxerga. Com 0 ele só reage a tiro |
| `requireLineOfSight` | bool | — | **true** | falso = enxerga e atira **através da parede** |
| `loseTargetAfter` | float (s) | 0–300 | **6** | quanto tempo sem ver antes de desistir. Ele vai até o último ponto conhecido antes de contar |
| `reactionDelay` | float (s) | 0–30 | **0.4** | entre avistar e o primeiro tiro. É a chance do jogador de sair da mira |
| `maxTargetHeightDelta` | float (m) | 0.5–50 | **3** | diferença de altura que quebra o alvo. É o `2.5f` da linha 967, agora de painel |
| `alertOnSpot` | bool | — | **true** | solta o grito do cientista ao avistar (`ScientistNPC.Alert`) |

#### Movimento

| campo | tipo | faixa | padrão | o que é |
|---|---|---|---|---|
| `holdPosition` | bool | — | **false** | o `isStatic` da base: mira e atira, nunca sai do posto |
| `moveSpeed` | float (m/s) | 0–12 | **2.8** | velocidade de perseguição. A base usa 3.0; 2.8 é a velocidade de quem anda |
| `chaseRadius` | float (m) | 0–250 | **25** | distância máxima do POSTO. É a coleira, e é ela que o mantém dentro da masmorra |
| `returnHome` | bool | — | **true** | falso = fica onde parou quando perde o alvo |
| `returnSpeed` | float (m/s) | 0–12 | **2.2** | velocidade da volta. Mais lenta de propósito: dá ao jogador tempo de flanquear |
| `arriveRadius` | float (m) | 0.1–10 | **0.6** | a que distância um ponto da trilha conta como alcançado |
| `stuckTimeout` | float (s) | 0–120 | **6** | preso este tempo, volta ao posto por teleporte. **0 desliga** |

#### Combate

| campo | tipo | faixa | padrão | o que é |
|---|---|---|---|---|
| `fireRange` | float (m) | 0–250 | **15** | alcance de tiro. Maior que `visionRadius` não serve para nada: ele atira no que vê |
| `fireInterval` | float (s) | 0.05–60 | **0.35** | intervalo entre TENTATIVAS de tiro. A rajada e a cadência continuam sendo da arma — este número só pode deixar mais LENTO |
| `standoffDistance` | float (m) | 0–100 | **2.5** | distância mínima: chegou aqui, para de andar e atira |
| `aimConeScale` | float | 0–20 | **herda do prefab** | a dispersão, como multiplicador do cone da arma. Menor = mais certeiro. Ausente = não mexe |

#### Ritmo (existe para o servidor cheio, não para o jogo)

| campo | tipo | faixa | padrão | o que é |
|---|---|---|---|---|
| `senseInterval` | float (s) | 0.1–10 | **0.5** | de quanto em quanto ele procura alvo. A base usa 1.0 |
| `moveInterval` | float (s) | 0.05–2 | **0.2** | o passo. Mesmo valor da base |

### 2.3 O que NÃO está aqui, e por quê

- **`damageScale`, `health`, `weapons`, `names`** já existem em `dungeons.npc`
  e valem para a masmorra inteira. Tê-los também por cor é um pedido legítimo
  ("o vermelho bate mais forte") mas é **outro contrato** — mexe na tabela
  `dungeon_rooms` e no `SpawnNpc`, não na IA. O merge da §3 já aceita o bloco
  extra no dia em que ele existir;
- **o drop do código da porta trancada** (§4 do plano) é da frente `portas.md`.
  O gancho existe: o `OnEntityTakeDamage` desta frente já sabe achar o
  componente de IA de um cientista nosso em O(1).

---

<a id="3"></a>
## 3 — O C#, pronto para colar

Entra **inteiro**, antes de `private class SyncPayload`, no fim do
`Plugins/OrigemZDungeon.cs`. Compilado no lugar: 0 erros.

```csharp
        // ============================================================
        //  A IA DO INIMIGO
        //
        //  ####  ELA É NOSSA, E ISSO NÃO É PREFERÊNCIA  ####
        //
        //  A masmorra fica a y = -90. O mapa de navegação do Rust é
        //  assado sobre o terreno, e ali não há terreno: NÃO EXISTE
        //  NAVMESH. O `ScientistBrain` do jogo, deixado ligado, passa
        //  o tempo pedindo ao `BaseNavigator` um caminho que não
        //  existe — e o cientista escorrega pelo chão sem sair do
        //  lugar.
        //
        //  Por isso o brain PARA de pensar (`AIThinkMode.None`, medido
        //  em `BaseAIBrain.ShouldServerThink`: o modo 2 devolve false e
        //  o `DoThink` nunca roda) e quem decide tudo é este
        //  componente: um relógio de percepção e um de movimento, como
        //  no DungeonBases 1.3.4 (linhas 904 e 956).
        //
        //  O que continua sendo do jogo, porque o jogo faz melhor:
        //
        //    · a MIRA — `HumanNPC.SetAimDirection` gira o olho E o
        //      corpo (`ServerRotation`) e passa o aim pela arma, que
        //      aplica o sway dela;
        //    · o TIRO — `ScientistNPC.ShotTest(dist)` cuida da rajada,
        //      da cadência da arma, do som, do efeito e da RECARGA.
        //      Lido na IL: sem munição ele chama `ServerReload` e
        //      devolve false; antes do `NextAttackTime` devolve false.
        //      Chamar demais não faz o NPC atirar mais rápido que a
        //      arma dele;
        //    · a POSIÇÃO na rede — `ServerPosition` marca
        //      `transform.hasChanged`, e é isso que o
        //      `BasePlayer.NetworkPositionTick` do jogo procura para
        //      mandar a nova posição aos clientes. Um
        //      `SendNetworkUpdate` por tick seria trabalho repetido.
        //
        //  ####  TODO NÚMERO VEM DE CIMA  ####
        //
        //  Nada de constante de comportamento no meio da função: o
        //  painel manda um bloco `ai` no `npc` (o padrão da masmorra),
        //  e cada cor de sala — e o corredor — pode sobrescrever
        //  campo a campo. O inimigo da sala vermelha não é o da verde.
        //
        //  As poucas constantes que sobraram são FÍSICA (altura do
        //  peito, alcance da sonda de chão): mudá-las pelo painel não
        //  produziria uma masmorra diferente, produziria um NPC
        //  quebrado.
        // ============================================================

        /// <summary>
        /// O que o painel mandou sobre o comportamento. Tudo opcional:
        /// `null` quer dizer "não falei disso", e não "zero" — é o que
        /// permite a sala vermelha mudar só a cadência e herdar o resto.
        /// </summary>
        private class AiSpec
        {
            // percepção
            public float? visionRadius;
            public bool? requireLineOfSight;
            public float? loseTargetAfter;
            public float? reactionDelay;
            public float? maxTargetHeightDelta;
            public bool? alertOnSpot;

            // movimento
            public bool? holdPosition;
            public float? moveSpeed;
            public float? chaseRadius;
            public bool? returnHome;
            public float? returnSpeed;
            public float? arriveRadius;
            public float? stuckTimeout;

            // combate
            public float? fireRange;
            public float? fireInterval;
            public float? standoffDistance;
            public float? aimConeScale;

            // ritmo
            public float? senseInterval;
            public float? moveInterval;
        }

        /// <summary>
        /// A receita já resolvida: padrão da masmorra + o que a cor
        /// daquela sala sobrescreveu, com cada número dentro da faixa.
        ///
        /// Existe separada do `AiSpec` porque o componente não pode
        /// perguntar "veio ou não veio?" a cada tick — a essa altura a
        /// pergunta já foi respondida.
        /// </summary>
        private class AiProfile
        {
            public float visionRadius = 18f;
            public bool requireLineOfSight = true;
            public float loseTargetAfter = 6f;
            public float reactionDelay = 0.4f;
            public float maxTargetHeightDelta = 3f;
            public bool alertOnSpot = true;

            public bool holdPosition;
            public float moveSpeed = 2.8f;
            public float chaseRadius = 25f;
            public bool returnHome = true;
            public float returnSpeed = 2.2f;
            public float arriveRadius = 0.6f;
            public float stuckTimeout = 6f;

            public float fireRange = 15f;
            public float fireInterval = 0.35f;
            public float standoffDistance = 2.5f;

            /// <summary>
            /// A dispersão do tiro, como multiplicador do cone da arma
            /// (medido na IL: `BaseProjectile.GetAIAimcone()` devolve
            /// `npc.aimConeScale * arma.aiAimCone`). Menor = mais
            /// certeiro.
            ///
            /// `null` de propósito: sem ordem do painel, o valor do
            /// prefab do cientista fica de pé. Chutar um número aqui
            /// seria mudar a dificuldade do servidor sem ninguém pedir.
            /// </summary>
            public float? aimConeScale;

            public float senseInterval = 0.5f;
            public float moveInterval = 0.2f;

            /// <summary>
            /// Aplica por cima o que veio do painel. Campo ausente não
            /// toca em nada — é o que faz a herança funcionar.
            /// </summary>
            public void Apply(AiSpec spec)
            {
                if (spec == null) return;

                if (spec.visionRadius.HasValue) visionRadius = Mathf.Clamp(spec.visionRadius.Value, 0f, 150f);
                if (spec.requireLineOfSight.HasValue) requireLineOfSight = spec.requireLineOfSight.Value;
                if (spec.loseTargetAfter.HasValue) loseTargetAfter = Mathf.Clamp(spec.loseTargetAfter.Value, 0f, 300f);
                if (spec.reactionDelay.HasValue) reactionDelay = Mathf.Clamp(spec.reactionDelay.Value, 0f, 30f);
                if (spec.maxTargetHeightDelta.HasValue) maxTargetHeightDelta = Mathf.Clamp(spec.maxTargetHeightDelta.Value, 0.5f, 50f);
                if (spec.alertOnSpot.HasValue) alertOnSpot = spec.alertOnSpot.Value;

                if (spec.holdPosition.HasValue) holdPosition = spec.holdPosition.Value;
                if (spec.moveSpeed.HasValue) moveSpeed = Mathf.Clamp(spec.moveSpeed.Value, 0f, 12f);
                if (spec.chaseRadius.HasValue) chaseRadius = Mathf.Clamp(spec.chaseRadius.Value, 0f, 250f);
                if (spec.returnHome.HasValue) returnHome = spec.returnHome.Value;
                if (spec.returnSpeed.HasValue) returnSpeed = Mathf.Clamp(spec.returnSpeed.Value, 0f, 12f);
                if (spec.arriveRadius.HasValue) arriveRadius = Mathf.Clamp(spec.arriveRadius.Value, 0.1f, 10f);
                if (spec.stuckTimeout.HasValue) stuckTimeout = Mathf.Clamp(spec.stuckTimeout.Value, 0f, 120f);

                if (spec.fireRange.HasValue) fireRange = Mathf.Clamp(spec.fireRange.Value, 0f, 250f);
                if (spec.fireInterval.HasValue) fireInterval = Mathf.Clamp(spec.fireInterval.Value, 0.05f, 60f);
                if (spec.standoffDistance.HasValue) standoffDistance = Mathf.Clamp(spec.standoffDistance.Value, 0f, 100f);
                if (spec.aimConeScale.HasValue) aimConeScale = Mathf.Clamp(spec.aimConeScale.Value, 0f, 20f);

                if (spec.senseInterval.HasValue) senseInterval = Mathf.Clamp(spec.senseInterval.Value, 0.1f, 10f);
                if (spec.moveInterval.HasValue) moveInterval = Mathf.Clamp(spec.moveInterval.Value, 0.05f, 2f);
            }
        }

        /// <summary>
        /// A receita daquele inimigo: o padrão da masmorra com a cor da
        /// sala por cima. `color` nulo = corredor.
        /// </summary>
        private AiProfile AiProfileFor(ActiveDungeon dungeon, string color)
        {
            var profile = new AiProfile();
            if (dungeon == null || dungeon.spec == null) return profile;

            if (dungeon.spec.npc != null) profile.Apply(dungeon.spec.npc.ai);

            if (color == null)
            {
                if (dungeon.spec.corridor != null) profile.Apply(dungeon.spec.corridor.ai);
                return profile;
            }

            var room = RoomSpecOf(dungeon, color);
            if (room != null) profile.Apply(room.ai);

            return profile;
        }

        /// <summary>
        /// Liga a IA no cientista recém-nascido.
        ///
        /// ####  A ORDEM AQUI IMPORTA  ####
        ///
        /// O brain só para de pensar DEPOIS do `Spawn()` — antes dele o
        /// `ServerInit` do cientista ainda não montou os estados, e o
        /// `SetThinkMode` cairia num objeto que o próprio jogo
        /// reinicializa em seguida.
        /// </summary>
        private void AttachAi(ScientistNPC npc, AiProfile profile)
        {
            if (npc == null || profile == null) return;

            // ####  O BRAIN CALA A BOCA  ####
            //
            // `AIThinkMode.None` faz o `ShouldServerThink` devolver
            // false (lido na IL do `BaseAIBrain`), e com isso o
            // `DoThink` nunca roda: nada de RoamState procurando ponto
            // de patrulha, nada de ChaseState pedindo caminho ao
            // navigator. Sem isto, dois donos disputam o mesmo NPC e
            // ele treme no lugar.
            var brain = npc.Brain;
            if (brain != null)
            {
                brain.SetThinkMode(AIThinkMode.None);
                if (brain.Navigator != null) brain.Navigator.Stop();
            }

            // A -90 não há NavMesh nem grafo A*: qualquer um destes
            // ligado é trabalho jogado fora a cada tick.
            var navigator = npc.GetComponent<BaseNavigator>();
            if (navigator != null)
            {
                navigator.CanUseNavMesh = false;
                navigator.CanUseAStar = false;
                navigator.CanUseBaseNav = false;
                navigator.CanUseCustomNav = false;
            }

            if (profile.aimConeScale.HasValue) npc.aimConeScale = profile.aimConeScale.Value;

            // Sem isto o cientista fica com a arma na cintura: o
            // `ShotTest` procura o item ATIVO, e um NPC de mãos vazias
            // persegue em silêncio.
            npc.EquipWeapon();

            npc.gameObject.AddComponent<DungeonNpcAi>().Setup(npc, profile);
        }

        /// <summary>
        /// O inimigo: percebe, persegue, atira e volta para o posto.
        ///
        /// Vive como componente do próprio NPC porque é assim que ele
        /// morre junto: `Kill()` destrói o `GameObject`, o `OnDestroy`
        /// cancela os dois relógios e não sobra nada rodando. A base
        /// 1.3.4 usa `timer.Every` do Oxide e o de movimento (linha
        /// 956) NUNCA é destruído — ele continua acordando de 0,2 em
        /// 0,2 segundo para cada cientista já morto, até o plugin
        /// descarregar.
        /// </summary>
        private class DungeonNpcAi : FacepunchBehaviour
        {
            // ####  AS CONSTANTES QUE NÃO SÃO DE PAINEL  ####
            //
            // Física do boneco e das sondas. Um admin que mexesse
            // nelas não teria uma masmorra mais difícil, teria um
            // cientista atravessando parede ou enterrado no chão.

            /// <summary>De onde sai a sonda que procura parede.</summary>
            private const float ChestHeight = 1.1f;

            /// <summary>A largura do boneco, para ele não raspar na quina.</summary>
            private const float BodyRadius = 0.5f;

            /// <summary>Quanto a sonda de chão começa acima e termina abaixo.</summary>
            private const float GroundProbeUp = 1f;
            private const float GroundProbeDown = 2f;

            /// <summary>Para que lado ele tenta contornar o que barrou o passo.</summary>
            private const float SideStepAngle = 45f;

            /// <summary>Distância entre duas migalhas da trilha.</summary>
            private const float TrailSpacing = 1.5f;

            /// <summary>
            /// Teto da trilha. Com 1,5 m entre migalhas isso é uma
            /// perseguição de 90 metros — mais que qualquer
            /// `chaseRadius` sensato. Cheia, ela para de crescer: jogar
            /// fora a migalha mais antiga apagaria justamente o caminho
            /// de volta.
            /// </summary>
            private const int MaxTrail = 64;

            /// <summary>
            /// Quanto ele precisa se mexer para não ser considerado
            /// preso.
            /// </summary>
            private const float StuckDistance = 0.75f;

            /// <summary>
            /// O que barra o passo: construção, mundo, deployáveis e o
            /// que estiver no Default. Jogadores e outros cientistas
            /// ficam DE FORA de propósito — se entrassem, um NPC
            /// atravessando a porta travaria a fila inteira atrás dele.
            ///
            /// Os números são os do `Rust.Layer`, medidos no
            /// Assembly-CSharp de 09/09/2026: Default 0, Deployed 8,
            /// World 16, Construction 21.
            /// </summary>
            private const int ObstacleMask = (1 << 0) | (1 << 8) | (1 << 16) | (1 << 21);

            /// <summary>
            /// O que serve de chão. Sem Deployed: senão ele sobe na
            /// caixa de loot e fica lá em cima.
            /// </summary>
            private const int GroundMask = (1 << 0) | (1 << 16) | (1 << 21) | (1 << 23);

            /// <summary>
            /// O que corta a linha de visada. É o de cima mais
            /// Player_Server (17): um colega na frente segura o tiro, e
            /// é isso que evita o NPC matar o NPC pelas costas.
            /// </summary>
            private const int SightMask = ObstacleMask | (1 << 17);

            // ####  A LISTA DE CANDIDATOS É UMA SÓ  ####
            //
            // Varrer `activePlayerList` uma vez POR NPC e POR TICK é
            // trabalho multiplicado por nada: são 30 cientistas
            // olhando a mesma lista de 100 jogadores. Aqui a varredura
            // acontece uma vez por `CandidateRefresh`, e o que sobra
            // para cada NPC é uma lista do tamanho de "quem está lá
            // embaixo" — quase sempre zero ou um.
            //
            // Estático porque a masmorra é UMA por servidor (ver
            // `active`). No dia em que forem duas, isto vira um campo
            // do `ActiveDungeon`.
            private static readonly List<BasePlayer> Candidates = new List<BasePlayer>();
            private static float candidatesAt = float.MinValue;
            private static float candidatesCeiling = float.MaxValue;
            private const float CandidateRefresh = 0.4f;

            private ScientistNPC npc;
            private AiProfile profile;

            private Vector3 home;
            private Vector3 homeAim;

            private BasePlayer target;
            private bool targetVisible;
            private Vector3 lastKnownPosition;
            private float lastSeenAt;
            private float spottedAt;

            /// <summary>Onde o alvo pisou. É por aqui que ele contorna a parede.</summary>
            private readonly List<Vector3> targetTrail = new List<Vector3>();

            /// <summary>Onde ELE pisou. É por aqui que ele volta.</summary>
            private readonly List<Vector3> homeTrail = new List<Vector3>();

            private bool goingHome;
            private float lastMoveAt;
            private float nextShotAt;
            private Vector3 stuckAnchor;
            private float stuckSince;

            public void Setup(ScientistNPC owner, AiProfile settings)
            {
                npc = owner;
                profile = settings;

                home = owner.ServerPosition;
                homeAim = owner.eyes != null ? owner.eyes.BodyForward() : owner.transform.forward;
                if (homeAim.sqrMagnitude < 0.001f) homeAim = Vector3.forward;
                homeAim.y = 0f;
                if (homeAim.sqrMagnitude < 0.001f) homeAim = Vector3.forward;

                lastMoveAt = Time.time;
                stuckAnchor = home;
                stuckSince = Time.time;

                // Quem está na masmorra está abaixo disto. É o filtro
                // que mantém a lista de candidatos curta sem varrer
                // distância para cada um dos 100 jogadores do servidor.
                candidatesCeiling = home.y + 30f;

                // ####  O PRIMEIRO TICK É SORTEADO  ####
                //
                // Trinta cientistas nascidos no mesmo frame pensariam
                // todos no mesmo frame para sempre. Espalhar o começo
                // custa uma linha e tira o pico do servidor.
                InvokeRepeating(Sense, UnityEngine.Random.Range(0f, profile.senseInterval), profile.senseInterval);
                InvokeRepeating(Move, UnityEngine.Random.Range(0f, profile.moveInterval), profile.moveInterval);
            }

            private void OnDestroy()
            {
                CancelInvoke(Sense);
                CancelInvoke(Move);
            }

            /// <summary>
            /// Levou um tiro: passa a saber de quem, mesmo sem ter
            /// visto. É o que a base 1.3.4 faz na linha 2144, e sem
            /// isso um jogador mata a sala inteira pelas costas sem
            /// ninguém virar.
            /// </summary>
            public void OnHurtBy(BasePlayer attacker)
            {
                if (attacker == null || npc == null || profile == null) return;
                if (attacker.IsNpc) return;

                if (target != attacker)
                {
                    target = attacker;
                    spottedAt = Time.time;
                    targetTrail.Clear();
                }

                targetVisible = false;
                lastSeenAt = Time.time;
                lastKnownPosition = attacker.transform.position;
                goingHome = false;
            }

            // ------------------------------------------------------------
            //  PERCEPÇÃO
            // ------------------------------------------------------------

            private void Sense()
            {
                if (npc == null || npc.IsDestroyed || !npc.IsAlive())
                {
                    CancelInvoke(Sense);
                    CancelInvoke(Move);
                    return;
                }

                var eye = npc.eyes == null ? npc.ServerPosition : npc.eyes.position;

                // O alvo de agora ainda serve?
                if (target != null && !Eligible(target)) Forget();

                var best = target;
                var bestScore = float.MaxValue;
                var bestVisible = false;

                RefreshCandidates();

                for (var i = 0; i < Candidates.Count; i++)
                {
                    var candidate = Candidates[i];
                    if (!Eligible(candidate)) continue;

                    var position = candidate.transform.position;
                    var distance = Vector3.Distance(eye, position);
                    if (distance > profile.visionRadius) continue;

                    // ####  O ANDAR DE CIMA NÃO CONTA  ####
                    //
                    // Sem isto o cientista do lobby persegue quem está
                    // no alçapão da superfície, 90 metros acima, e fica
                    // girando embaixo dele. A base usa 2,5 m (linha
                    // 967); aqui o número é do painel.
                    if (Mathf.Abs(position.y - npc.ServerPosition.y) > profile.maxTargetHeightDelta) continue;

                    var visible = !profile.requireLineOfSight || HasSight(candidate, eye, distance);
                    if (!visible) continue;

                    // O mais perto ganha; empate não existe na prática.
                    if (distance >= bestScore) continue;

                    bestScore = distance;
                    best = candidate;
                    bestVisible = true;
                }

                if (bestVisible)
                {
                    if (target != best)
                    {
                        target = best;
                        spottedAt = Time.time;
                        targetTrail.Clear();

                        // O grito do cientista é a única pista sonora
                        // que o jogador tem de que foi visto.
                        if (profile.alertOnSpot) npc.Alert();
                    }

                    targetVisible = true;
                    lastSeenAt = Time.time;
                    lastKnownPosition = best.transform.position;
                    goingHome = false;

                    Breadcrumb(targetTrail, lastKnownPosition);
                    return;
                }

                targetVisible = false;

                // Perdeu de vista: ele ainda vai até onde viu por
                // último, e só depois desiste.
                if (target != null && Time.time - lastSeenAt > profile.loseTargetAfter) Forget();
            }

            /// <summary>
            /// A lista de quem pode ser alvo, refeita no máximo a cada
            /// `CandidateRefresh` para o servidor inteiro.
            /// </summary>
            private static void RefreshCandidates()
            {
                if (Time.time - candidatesAt < CandidateRefresh) return;
                candidatesAt = Time.time;

                Candidates.Clear();

                var everyone = BasePlayer.activePlayerList;
                for (var i = 0; i < everyone.Count; i++)
                {
                    var player = everyone[i];
                    if (player == null || player.IsNpc) continue;
                    if (!player.IsAlive() || player.IsSleeping()) continue;
                    if (player.IsSpectating()) continue;
                    if (player.transform.position.y > candidatesCeiling) continue;

                    Candidates.Add(player);
                }
            }

            private bool Eligible(BasePlayer player)
            {
                return player != null
                       && !player.IsDestroyed
                       && player.IsAlive()
                       && !player.IsSleeping()
                       && !player.IsSpectating();
            }

            private void Forget()
            {
                target = null;
                targetVisible = false;
                targetTrail.Clear();

                goingHome = profile.returnHome;

                // Quem não volta larga a trilha: guardada, ela levaria
                // a próxima perseguição de volta por um caminho que
                // começa onde ele não está mais.
                if (!goingHome) homeTrail.Clear();
            }

            /// <summary>
            /// Enxerga daqui até lá?
            ///
            /// ####  O PRIMEIRO QUE O RAIO ENCONTRA DECIDE  ####
            ///
            /// Se for o próprio alvo, há visada; qualquer outra coisa é
            /// parede, porta ou colega. É o teste da base (linha 926),
            /// com duas correções: o raio sai do OLHO — e não dos pés,
            /// onde a fundação da própria célula o interrompia — e a
            /// máscara é positiva, para caber num comentário.
            ///
            /// O raio que começa dentro do próprio colisor não o
            /// devolve (é como o PhysX trata volume convexo), então o
            /// cientista não enxerga a si mesmo como obstáculo.
            /// </summary>
            private bool HasSight(BasePlayer candidate, Vector3 eye, float distance)
            {
                var targetEye = candidate.eyes == null
                    ? candidate.transform.position + Vector3.up * 1.5f
                    : candidate.eyes.position;

                var direction = targetEye - eye;
                if (direction.sqrMagnitude < 0.0001f) return true;

                RaycastHit hit;
                if (!Physics.Raycast(eye, direction.normalized, out hit, distance + 0.5f, SightMask)) return true;

                var blocker = hit.GetEntity();
                return blocker == candidate || blocker == npc;
            }

            // ------------------------------------------------------------
            //  MOVIMENTO E COMBATE
            // ------------------------------------------------------------

            private void Move()
            {
                if (npc == null || npc.IsDestroyed || !npc.IsAlive())
                {
                    CancelInvoke(Sense);
                    CancelInvoke(Move);
                    return;
                }

                var now = Time.time;
                var delta = Mathf.Min(now - lastMoveAt, 1f);
                lastMoveAt = now;

                var position = npc.ServerPosition;

                if (target != null)
                {
                    // ####  ELE SÓ ENCARA O QUE ESTÁ VENDO  ####
                    //
                    // `SetAimDirection` gira o CORPO junto com o olho
                    // (medido na IL: ela termina em `ServerRotation`).
                    // Mirar no alvo sem visada faria o cientista girar
                    // para acompanhar o jogador ATRAVÉS da parede — e
                    // não há defeito que pareça mais trapaça que esse.
                    // Sem visada ele encara para onde anda.
                    if (targetVisible) AimAt(target.eyes == null
                        ? target.transform.position + Vector3.up * 1.5f
                        : target.eyes.position);

                    Shoot(position);

                    if (!profile.holdPosition)
                    {
                        Chase(position, delta);
                        CheckStuck(position, now);
                    }

                    return;
                }

                // Sem alvo: ou volta para o posto, ou fica olhando para
                // onde nasceu — o que evita o cientista de costas para
                // a porta que ele deveria guardar.
                if (goingHome && !profile.holdPosition)
                {
                    GoHome(position, delta);
                    CheckStuck(position, now);
                    return;
                }

                npc.SetAimDirection(homeAim);
                stuckSince = now;
            }

            private void AimAt(Vector3 point)
            {
                var eye = npc.eyes == null ? npc.ServerPosition : npc.eyes.position;
                var to = point - eye;

                // `SetAimDirection` ignora o vetor zero — e o corpo
                // ficaria travado na direção anterior.
                if (to.sqrMagnitude < 0.0001f) return;

                npc.SetAimDirection(to.normalized);
            }

            /// <summary>
            /// Puxa o gatilho, se for a hora.
            ///
            /// Quem cuida da rajada, do intervalo entre tiros e da
            /// recarga é o `ShotTest` do jogo. O que está aqui é o que
            /// ele NÃO decide: se enxerga, se está no alcance que o
            /// painel deu, e quanto tempo depois de avistar ele começa.
            /// </summary>
            private void Shoot(Vector3 position)
            {
                if (!targetVisible && profile.requireLineOfSight) return;
                if (Time.time < nextShotAt) return;
                if (Time.time - spottedAt < profile.reactionDelay) return;

                var distance = Vector3.Distance(position, target.transform.position);
                if (distance > profile.fireRange) return;

                npc.ShotTest(distance);
                nextShotAt = Time.time + profile.fireInterval;
            }

            private void Chase(Vector3 position, float delta)
            {
                var distance = Vector3.Distance(position, target.transform.position);

                // Chegou perto o bastante: daqui ele atira, não abraça.
                if (targetVisible && distance <= profile.standoffDistance)
                {
                    stuckSince = Time.time;
                    return;
                }

                Breadcrumb(homeTrail, position);

                Vector3 destination;

                if (targetVisible)
                {
                    // Com o alvo à vista, a trilha dele não serve para
                    // nada: o caminho é a linha reta.
                    destination = target.transform.position;
                    targetTrail.Clear();
                }
                else
                {
                    // Sem visada, ele pisa onde o jogador pisou — e é
                    // assim que ele dobra o corredor sem NavMesh. As
                    // migalhas que já ficaram para trás são jogadas
                    // fora antes, senão ele anda de volta para pegá-las.
                    while (targetTrail.Count > 0 && Flat(position, targetTrail[0]) < profile.arriveRadius)
                        targetTrail.RemoveAt(0);

                    destination = targetTrail.Count > 0 ? targetTrail[0] : lastKnownPosition;

                    // Sem ver, ele encara o caminho — nunca o jogador.
                    AimAt(new Vector3(destination.x, destination.y + 1.5f, destination.z));
                }

                Step(position, destination, profile.moveSpeed, delta);
            }

            private void GoHome(Vector3 position, float delta)
            {
                // A trilha de volta é consumida do fim para o começo: o
                // último lugar em que ele esteve é o mais perto dele
                // agora.
                while (homeTrail.Count > 0 && Flat(position, homeTrail[homeTrail.Count - 1]) < profile.arriveRadius)
                    homeTrail.RemoveAt(homeTrail.Count - 1);

                var destination = homeTrail.Count > 0 ? homeTrail[homeTrail.Count - 1] : home;

                if (homeTrail.Count == 0 && Flat(position, home) < profile.arriveRadius)
                {
                    // Chegou. Daqui ele volta a olhar para onde nasceu
                    // — parado de costas para a porta que guarda seria
                    // pior que não voltar.
                    goingHome = false;
                    npc.SetAimDirection(homeAim);
                    return;
                }

                AimAt(new Vector3(destination.x, destination.y + 1.5f, destination.z));
                Step(position, destination, profile.returnSpeed, delta);
            }

            /// <summary>
            /// Um passo na direção do destino, se houver por onde.
            ///
            /// ####  NUNCA ATRAVESSA A PAREDE, NUNCA SAI DA MASMORRA  ####
            ///
            /// Duas travas, e as duas são de segurança, não de
            /// desempenho: a sonda à frente impede o passo dentro da
            /// parede — a IA move o boneco por código, e código não tem
            /// colisão — e a coleira do posto impede que a perseguição
            /// leve o cientista para fora do que foi construído.
            /// </summary>
            private void Step(Vector3 position, Vector3 destination, float speed, float delta)
            {
                if (speed <= 0f) return;

                var flat = new Vector3(destination.x - position.x, 0f, destination.z - position.z);
                var distance = flat.magnitude;
                if (distance < 0.01f) return;

                var direction = flat / distance;
                var step = Mathf.Min(speed * delta, distance);

                if (!Free(position, direction, step))
                {
                    var left = Quaternion.Euler(0f, SideStepAngle, 0f) * direction;
                    var right = Quaternion.Euler(0f, -SideStepAngle, 0f) * direction;

                    if (Free(position, left, step)) direction = left;
                    else if (Free(position, right, step)) direction = right;
                    else return;
                }

                var next = position + direction * step;

                // A coleira. Ela vale para os dois modos: perseguindo
                // ele não passa do raio, voltando ele já está dentro.
                if (!goingHome && Flat(next, home) > profile.chaseRadius) return;

                next.y = GroundAt(next, position.y);
                npc.ServerPosition = next;
            }

            private static bool Free(Vector3 position, Vector3 direction, float step)
            {
                return !Physics.Raycast(
                    position + Vector3.up * ChestHeight, direction, step + BodyRadius, ObstacleMask);
            }

            /// <summary>
            /// A altura do piso naquele ponto.
            ///
            /// Sem isto o cientista mantém a altura em que nasceu e vai
            /// afundando ou flutuando pela masmorra — a IA move o
            /// boneco por código, e código não tem gravidade. Sem
            /// acertar nada, ele fica na altura que estava: é melhor
            /// que cair para sempre.
            /// </summary>
            private static float GroundAt(Vector3 point, float fallback)
            {
                RaycastHit hit;
                if (Physics.Raycast(point + Vector3.up * GroundProbeUp, Vector3.down, out hit,
                        GroundProbeUp + GroundProbeDown, GroundMask))
                    return hit.point.y;

                return fallback;
            }

            /// <summary>
            /// Preso? Volta para o posto.
            ///
            /// Uma quina em que a sonda barra os três lados travaria o
            /// cientista para sempre — e o jogador encontraria um
            /// inimigo dançando contra a parede. O teleporte é feio, e
            /// é melhor que isso.
            /// </summary>
            private void CheckStuck(Vector3 position, float now)
            {
                if (profile.stuckTimeout <= 0f) return;

                if (Vector3.Distance(position, stuckAnchor) > StuckDistance)
                {
                    stuckAnchor = position;
                    stuckSince = now;
                    return;
                }

                if (now - stuckSince < profile.stuckTimeout) return;

                npc.ServerPosition = home;
                stuckAnchor = home;
                stuckSince = now;
                homeTrail.Clear();
                targetTrail.Clear();
                goingHome = false;
            }

            private static void Breadcrumb(List<Vector3> trail, Vector3 point)
            {
                if (trail.Count >= MaxTrail) return;
                if (trail.Count > 0 && Vector3.Distance(trail[trail.Count - 1], point) < TrailSpacing) return;

                trail.Add(point);
            }

            /// <summary>Distância no plano. A altura aqui só atrapalha.</summary>
            private static float Flat(Vector3 a, Vector3 b)
            {
                var dx = a.x - b.x;
                var dz = a.z - b.z;
                return Mathf.Sqrt(dx * dx + dz * dz);
            }
        }

        /// <summary>
        /// O tiro que acerta o cientista.
        ///
        /// ####  DUAS COISAS, E AS DUAS FORAM MEDIDAS NA BASE  ####
        ///
        /// A primeira: cientista não mata cientista. Uma rajada que
        /// atravessa o colega faria a sala se dizimar sozinha enquanto
        /// o jogador assiste — e o `damageScale` que o painel deu para
        /// o jogador vale contra ele também.
        ///
        /// A segunda: levar tiro é uma forma de perceber. Sem isto, um
        /// jogador de mira boa limpa a masmorra pelas costas sem
        /// ninguém virar (base 1.3.4, linha 2121).
        /// </summary>
        private object OnEntityTakeDamage(ScientistNPC npc, HitInfo info)
        {
            if (npc == null || info == null) return null;

            var ai = npc.GetComponent<DungeonNpcAi>();
            if (ai == null) return null;

            var initiator = info.Initiator;

            if (initiator is ScientistNPC && initiator.GetComponent<DungeonNpcAi>() != null)
            {
                info.damageTypes.ScaleAll(0f);
                return null;
            }

            ai.OnHurtBy(info.InitiatorPlayer);
            return null;
        }
```

<a id="4"></a>
## 4 — As seis linhas que mudam no plugin

O bloco da §3 entra inteiro **antes de `private class SyncPayload`**, no fim do
arquivo. Fora dele, só isto muda:

**1) O campo `ai` nas três classes de receita** (perto da linha 3050):

```csharp
        private class CorridorSpec
        {
            public AiSpec ai;            // ← novo
            public int npcDensity;
            ...
        }

        private class NpcSpec
        {
            public AiSpec ai;            // ← novo
            public Range health;
            ...
        }

        private class RoomSpec
        {
            public AiSpec ai;            // ← novo
            public string key;
            ...
        }
```

**2) `SpawnNpc` passa a saber a cor da sala** (linha ~1806):

```csharp
        private bool SpawnNpc(
            ActiveDungeon dungeon,
            Dictionary<(int, int), BuildingBlock> floors,
            (int, int) cell,
            string color,                // ← novo; null = corredor
            System.Random rng)
```

**3) e liga a IA no fim dele**, logo antes do `return true`:

```csharp
            AttachAi(npc, AiProfileFor(dungeon, color));

            return true;
```

**4) As duas chamadas em `Populate`** (linhas ~1667 e ~1693):

```csharp
                    if (SpawnNpc(dungeon, floors, forNpcs[i], color, rng)) npcs++;
...
                if (rng.Next(100) < npcDensity && SpawnNpc(dungeon, floors, cell, null, rng)) npcs++;
```

O `color` da primeira já existe três linhas acima (`var color = RoomColor(...)`);
não é preciso calcular nada.

**Nada mais muda.** O `Demolish` já mata os NPCs, e com eles morrem os
componentes: `Kill()` destrói o `GameObject`, o `OnDestroy` cancela os dois
relógios. O `SpawnNpc` de hoje já faz `CanUseNavMesh = false` — o `AttachAi`
repete e desliga os outros três modos de navegação; a linha antiga pode ficar
onde está sem prejuízo.

### 4.1 Uma coisa que não é desta frente, mas que eu vi

`Adopt` (linha 2882) escreve `entity._name = "#ozdung#"` em **tudo**, inclusive
no cientista — e em `BasePlayer` o `_name` **é** o nome de exibição. Hoje o
`SpawnNpc` sobrescreve logo depois com `npc.displayName = spec.names[...]`,
então o defeito está escondido: **se a receita não trouxer `names`, o inimigo
aparece na tela e no kill feed chamado `#ozdung#`**.

O `OnEntityTakeDamage` do plugin já se protege disso na linha seguinte
(`if (entity is BasePlayer) return null;`), então não há bug de dano. É só o
nome. Quem decide isso não sou eu.

---

<a id="5"></a>
## 5 — O que foi medido, e o que não foi

### 5.1 Medido, lendo a IL do Rust do `Servers/server01` (09/09/2026)

A leitura foi feita com `Mono.Cecil` sobre o `Assembly-CSharp.dll` do próprio
servidor — não de memória, não de documentação de terceiro.

| o que | onde | o que ficou provado |
|---|---|---|
| `ScientistNPC.ShotTest(float)` | `NPCPlayer::ShotTest` | **não depende do brain.** Ele pega o `GetHeldEntity`, e: sem munição chama `ServerReload()` e devolve false; antes do `NextAttackTime` devolve false; senão dispara a rajada (`InvokeRepeating(TriggerDown, 0, 0.01)`) até `triggerEndTime`, e no fim marca `nextTriggerTime = agora + attackSpacing`. **Chamar mais vezes não faz atirar mais rápido** |
| `HumanNPC.SetAimDirection(Vector3)` | IL completa | passa o aim pela arma (`ModifyAIAim`, que aplica o sway dela), faz `eyes.rotation = Lerp(..., Δt*25)`, e termina em **`ServerRotation = eyes.rotation`** — ela gira o corpo. Como `Lerp` satura em Δt ≥ 0,04 s, chamada a cada 0,2 s a mira é **instantânea** |
| a precisão do NPC | `BaseProjectile::GetAIAimcone` | `= npc.aimConeScale * arma.aiAimCone`. É este o campo de precisão, e não outro |
| `AIThinkMode` | enum + `BaseAIBrain::ShouldServerThink` | `None = 2`, e o modo 2 faz `ShouldServerThink` devolver **false** — o `DoThink` nunca roda. É o desligamento limpo do brain |
| mover o NPC | `NPCPlayer::UpdatePositionAndRotation` | o jogo move assim: `ServerPosition = pos`. E `set_ServerPosition` marca `transform.hasChanged`, que é **o que o `BasePlayer.NetworkPositionTick` procura** para mandar a posição aos clientes. Não é preciso `SendNetworkUpdate` por tick |
| os números de layer | enum `Rust.Layer` | Default 0, Deployed 8, World 16, **Player_Server 17**, Construction 21, Terrain 23, Tree 30. São estes os das máscaras da §3 |
| `AIBrainSenses.Init` | assinatura | 15 parâmetros, `(BaseEntity, BaseAIBrain, float memoryDuration, float range, float targetLostRange, float visionCone, bool checkVision, bool checkLOS, bool ignoreNonVisionSneakers, float listenRange, bool hostileTargetsOnly, bool senseFriendlies, bool ignoreSafeZonePlayers, EntityType, bool refreshKnownLOS)`. **Não usamos** — está aqui porque é o caminho que qualquer um tentaria primeiro |
| o combate nativo | `HumanNPC::TickAttack` | ele exige três coisas: linha de visada, mira alinhada (`dot > 0,2`) por ≥ 0,2 s, e alvo dentro de `effectiveRange` da arma (× 2 se `aiOnlyInRange` for falso). Foi de onde saiu o desenho de "mirar antes de atirar" |
| `ValidBounds` | `NPCPlayer::ValidateNextPosition` | posição fora dos limites **mata** o NPC ("Invalid NavAgent Position"). Em mapa procedural o piso do teste é `TerrainMeta.Position.y`. A -90 a masmorra inteira já existe, então passa — mas é o primeiro lugar a olhar se um cientista sumir |

### 5.2 Medido compilando

`dotnet build core/scripts/pluginlint/pluginlint.csproj -t:Rebuild` com o bloco
da §3 **já inserido no `OrigemZDungeon.cs` real**: `0 Erro(s)`. Um teste
negativo (trocar `ShotTest` por `ShotTestXX`) devolveu `CS1061` — ou seja, o
"0 erros" não é um build incremental preguiçoso.

Existem, e foram usados: `ScientistNPC.Alert()`, `npc.EquipWeapon()`,
`npc.Brain`, `npc.aimConeScale`, `brain.SetThinkMode`, `navigator.CanUseAStar` /
`CanUseBaseNav` / `CanUseCustomNav`, `BasePlayer.IsSpectating()`,
`hit.GetEntity()`, `FacepunchBehaviour.InvokeRepeating(Action, float, float)`.

### 5.3 NÃO medido — e nenhuma destas linhas deve ser lida como fato

1. **Nada disto rodou no jogo.** Não subi servidor: a IA não foi vista
   perseguindo ninguém. Tudo o que a §3 afirma vem de leitura de IL e de
   compilação;
2. **o `aimConeScale` padrão do `scientistnpc_heavy`** mora no prefab, dentro
   do bundle — não consegui ler. É por isso que o campo é **ausente por
   padrão**: sem ordem do painel, o valor do prefab fica de pé. Qualquer número
   que eu escrevesse aqui mudaria a dificuldade do servidor sem ninguém pedir;
3. **o `aiAimCone` de cada arma** (o outro fator da precisão) também é do
   prefab. Então `aimConeScale = 0.8` não quer dizer o mesmo grau de dispersão
   na AK e na spas12;
4. **se `Physics.Raycast` a -90 enxerga as paredes da masmorra** eu deduzi, não
   medi: as paredes são `BuildingBlock`, que ficam no layer Construction (21), e
   é o que a máscara pede. A base faz o mesmo raycast e funciona em servidor de
   verdade — mas com máscara escrita por negação;
5. **o custo em CPU** com 30 NPCs. As contas: um raycast de visada por
   candidato por 0,5 s, e até três raycasts de passo por NPC por 0,2 s — ~450
   raycasts/s numa masmorra cheia com um jogador dentro. É pouco para o Rust,
   mas é estimativa, não medição;
6. **a animação de correr.** Movemos o boneco por `ServerPosition`; quem decide
   a animação é o cliente, pela velocidade que ele observa. Se o cientista
   deslizar em pose de parado, é aqui que se olha (`modelState`);
7. **`GroundAt` do plugin** (linha ~2920) diz no comentário "Layer 8
   (terreno)". Medido: **8 é `Deployed`; terreno é 23**. Como há o fallback
   para `TerrainMeta.HeightMap`, na prática funciona — mas o raycast não está
   pegando o terreno. Não é desta frente e não toquei.

---

<a id="6"></a>
## 6 — O que o dono tem de olhar no jogo

Nenhum defeito desta semana apareceu em compilação. A ordem abaixo é a que
encontra mais rápido:

1. **Entre e fique parado na porta da primeira sala.** O cientista tem de
   virar o corpo para você e atirar depois de ~0,4 s. Se ele **não virar**, o
   `SetAimDirection` não está pegando; se virar e **não atirar**, é a arma (o
   `ShotTest` devolve false sem munição ou sem item ativo);
2. **Esconda-se atrás da parede.** Ele tem de **parar de atirar** e vir andando
   pela porta — não atravessar. E, enquanto não te vê, ele tem de encarar o
   caminho, **nunca você**. Um cientista que gira o corpo acompanhando o
   jogador através da parede é o defeito mais feio que esta frente pode ter;
3. **Corra para longe.** Aos 25 m do posto dele (o `chaseRadius`) ele tem de
   parar. Espere 6 s: ele tem de **voltar andando**, refazendo o caminho, e
   parar onde nasceu olhando para a mesma direção de antes;
4. **Suba o alçapão com ele te perseguindo.** Ele tem de desistir na hora — são
   90 metros de diferença, e o `maxTargetHeightDelta` é 3;
5. **Atire nele de trás, de longe, sem ser visto.** Ele tem de virar. Se não
   virar, o `OnEntityTakeDamage(ScientistNPC, …)` não está sendo chamado — o
   Oxide escolhe o hook pelo tipo do primeiro argumento e o plugin já tem outro
   `OnEntityTakeDamage`;
6. **Deixe dois cientistas numa sala e fique atrás de um.** O da frente não
   pode morrer com a rajada do de trás;
7. **Olhe os pés.** Ele tem de pisar no chão, não flutuar nem afundar, e tem de
   contornar a caixa de loot em vez de subir nela;
8. **Deixe a masmorra rodar 10 minutos e mate um.** Nenhum cientista pode
   sumir sozinho — se sumir, é o `ValidBounds` da §5.1, e a mensagem
   "Invalid NavAgent Position" estará no console;
9. **Encoste no canto e faça ele te seguir até a quina.** Depois de 6 s preso,
   ele tem de reaparecer no posto. É feio de propósito: é a saída de emergência.

**Os três números para mexer primeiro**, se ficar fácil demais:
`fireInterval` (0.35 → 0.2), `aimConeScale` (ausente → 0.7) e `visionRadius`
(18 → 25). Nesta ordem — os dois primeiros mudam o combate, o terceiro muda
quantos inimigos chegam de uma vez.
