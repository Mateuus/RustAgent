Resumindo o sistema
A estrutura que queremos reproduzir no Rust seria:

Evento automático
↓
Escolhe uma localização
↓
Marca a área no mapa
↓
Jogadores chegam ao local
↓
Inicia a disputa pela captura
↓
Jogador/grupo precisa permanecer e defender a região
↓
Outros jogadores podem contestar
↓
Captura é concluída
↓
Vencedor recebe a recompensa
↓
Evento encerra e entra em cooldown

A grande vantagem é deixar o sistema modular: cadastramos várias localizações e recompensas, enquanto o próprio KOTH administra o ciclo do evento.