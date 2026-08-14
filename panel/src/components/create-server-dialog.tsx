'use client';

// ============================================================
//  create-server-dialog.tsx  -  criar servidor.
//
//  ####  A SENHA DE RCON NASCE ALEATÓRIA  ####
//
//  Quem tem essa senha executa QUALQUER comando naquele servidor.
//  Deixar o campo em branco para a pessoa preencher produz
//  "123456" na metade das instalações — então ele nasce
//  preenchido com 24 caracteres aleatórios, e quem quiser troca.
//
//  Os caracteres proibidos (`/ \ ? #` e espaço) ficam de fora do
//  alfabeto: o WebRCON transporta a senha no CAMINHO da URL, e o
//  Rust compara o caminho cru — com eles, a autenticação falharia
//  para sempre, em laço de reconexão, sem dizer por quê.
// ============================================================

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { agent, type PortBlock } from '@/lib/api';
import { toast } from '@/lib/toast';

const MAPS = ['Procedural Map', 'Barren', 'HapisIsland', 'Craggy Island'];

/** Sem `/ \ ? #` nem espaço — ver o cabeçalho. */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_';

function randomPassword(length = 24): string {
  const bytes = new Uint32Array(length);

  crypto.getRandomValues(bytes);

  return Array.from(bytes, (value) => ALPHABET[value % ALPHABET.length] ?? '-').join('');
}

export interface CreateServerDialogProps {
  readonly suggested: PortBlock | null;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}

export function CreateServerDialog({ suggested, onClose, onCreated }: CreateServerDialogProps) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [map, setMap] = useState(MAPS[0] ?? 'Procedural Map');
  const [worldSize, setWorldSize] = useState(4000);
  const [maxPlayers, setMaxPlayers] = useState(200);
  const [rconPassword, setRconPassword] = useState(() => randomPassword());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await agent.createServer({
        id: id.trim(),
        name: name.trim() === '' ? id.trim() : name.trim(),
        hostname: hostname.trim() === '' ? name.trim() || id.trim() : hostname.trim(),
        map,
        worldSize,
        maxPlayers,
        rconPassword,
      });

      toast.success(`Servidor "${id.trim()}" criado.`, {
        description: 'Ele nasce desligado — o próximo passo é Instalar.',
      });

      onCreated();
    } catch (cause) {
      // A frase vem do core — ela conhece a regra (id em uso,
      // porta ocupada, senha com caractere proibido). Fica no
      // formulário, e não num toast: ela aponta um campo que a
      // pessoa precisa corrigir sem perder o que digitou.
      setError(cause instanceof Error ? cause.message : 'Não consegui falar com o agente.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="Criar servidor" onClose={onClose} busy={busy}>
      <form onSubmit={(event) => void onSubmit(event)}>
        <p className="mb-6 text-sm text-muted">
          Isto escreve o <code>Configs\&lt;id&gt;.ini</code> e reserva as portas. O jogo é baixado
          depois, no botão Instalar.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="id">id</Label>
            <Input
              id="id"
              value={id}
              placeholder="pvp1"
              onChange={(event) => setId(event.target.value.toLowerCase())}
            />
            <p className="mt-1 text-2xs text-muted">
              minúsculas, dígitos e hífen. Vira o nome do arquivo e das pastas — e não muda depois.
            </p>
          </div>

          <div>
            <Label htmlFor="name">Nome no painel</Label>
            <Input
              id="name"
              value={name}
              placeholder="PVP 1"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="hostname">Hostname (o que o jogador vê na lista do Rust)</Label>
            <Input
              id="hostname"
              value={hostname}
              placeholder="MeuServidor | PVP | Wipe na quinta"
              onChange={(event) => setHostname(event.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="map">Mapa</Label>
            <select
              id="map"
              value={map}
              onChange={(event) => setMap(event.target.value)}
              className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
            >
              {MAPS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="worldSize">Tamanho do mundo</Label>
            <Input
              id="worldSize"
              type="number"
              min={1000}
              max={6000}
              value={worldSize}
              onChange={(event) => setWorldSize(Number(event.target.value))}
            />
          </div>

          <div>
            <Label htmlFor="maxPlayers">Máximo de jogadores</Label>
            <Input
              id="maxPlayers"
              type="number"
              min={1}
              max={1000}
              value={maxPlayers}
              onChange={(event) => setMaxPlayers(Number(event.target.value))}
            />
          </div>

          <div>
            <Label htmlFor="rcon">Senha do RCON</Label>
            <div className="flex gap-2">
              <Input
                id="rcon"
                value={rconPassword}
                onChange={(event) => setRconPassword(event.target.value)}
              />
              <Button onClick={() => setRconPassword(randomPassword())}>Nova</Button>
            </div>
          </div>
        </div>

        {suggested !== null && (
          <p className="mt-4 border border-border bg-surface-2 p-3 text-2xs text-muted">
            Portas reservadas (bloco {String(suggested.index)}): jogo {String(suggested.gamePort)} ·
            rcon {String(suggested.rconPort)} · query {String(suggested.queryPort)} · app{' '}
            {String(suggested.appPort)}
          </p>
        )}

        {error !== null && <p className="mt-4 border border-rust bg-surface-2 p-3 text-sm">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={busy || id.trim() === ''}>
            {busy ? 'Criando…' : 'Criar'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
