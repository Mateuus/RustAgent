'use client';

// ============================================================
//  /entrar  -  o login do operador.
//
//  Uma frase só para credencial errada, venha de onde vier: dizer
//  "esse usuário não existe" entrega metade da credencial. Quem
//  decide isso é o core; aqui a tela só mostra o que ele disse.
// ============================================================

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function EntrarPage() {
  const { user, loading, signIn } = useSession();
  const router = useRouter();

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Quem já tem sessão não vê a tela de login.
  useEffect(() => {
    if (!loading && user !== null) {
      router.replace('/');
    }
  }, [loading, user, router]);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await signIn(name, password);
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não consegui falar com o agente.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form
        onSubmit={(event) => void onSubmit(event)}
        className="w-full max-w-sm border border-border bg-surface p-6"
      >
        <p className="font-condensed text-2xl font-bold uppercase tracking-wide">
          Rust<span className="text-rust">Agent</span>
        </p>
        <p className="mb-6 text-sm text-muted">Entre para cuidar dos servidores desta máquina.</p>

        <div className="mb-4">
          <Label htmlFor="user">Usuário</Label>
          <Input
            id="user"
            value={name}
            autoComplete="username"
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="mb-6">
          <Label htmlFor="password">Senha</Label>
          <Input
            id="password"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {error !== null && (
          <p className="mb-4 border border-rust bg-surface-2 p-3 text-sm text-foreground">{error}</p>
        )}

        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </Button>

        <p className="mt-6 text-2xs leading-relaxed text-muted">
          Sem senha configurada? Gere uma com <code>npm run panel:senha -w core</code> e ponha o
          resultado em <code>PANEL_PASSWORD_HASH</code>, no <code>.env</code>.
        </p>
      </form>
    </div>
  );
}
