'use client';

// ============================================================
//  session.tsx  -  quem está logado, e o portão.
//
//  ####  O TOKEN DE CSRF VIVE EM MEMÓRIA  ####
//
//  Nada de `localStorage`: o que se guarda ali sobrevive à aba,
//  vaza para qualquer script da página e não expira sozinho. A
//  sessão de verdade é o cookie `HttpOnly` — este provider só
//  descobre, no primeiro carregamento, se ele ainda vale.
// ============================================================

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { agent, setCsrfToken } from '@/lib/api';

interface SessionState {
  readonly user: string | null;
  /** `true` enquanto a primeira conferência não voltou. */
  readonly loading: boolean;
  readonly signIn: (user: string, password: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void agent
      .session()
      .then((response) => {
        if (cancelled) {
          return;
        }

        setCsrfToken(response.csrfToken);
        setUser(response.user);
      })
      .catch(() => {
        // 401 aqui é o caso NORMAL de quem abre o painel pela
        // primeira vez. Não é erro para mostrar na tela.
        setCsrfToken(null);
        setUser(null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (name: string, password: string) => {
    const response = await agent.login(name, password);

    setCsrfToken(response.csrfToken);
    setUser(response.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await agent.logout();
    } finally {
      // Mesmo que o logout falhe (agente fora do ar), a tela sai:
      // manter o painel aberto depois de alguém pedir para sair é
      // pior que uma sessão órfã no servidor, que expira sozinha.
      setCsrfToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, signIn, signOut }),
    [user, loading, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);

  if (context === null) {
    throw new Error('useSession precisa estar dentro de <SessionProvider>');
  }

  return context;
}

/**
 * O portão: manda para `/entrar` quem não tem sessão.
 *
 * Enquanto `loading`, não mostra NADA — nem a tela, nem o
 * redirecionamento. Um piscar de painel para quem não está logado
 * é vazamento de layout, e um piscar de login para quem está é a
 * pior primeira impressão possível.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user === null) {
      router.replace('/entrar');
    }
  }, [loading, user, router]);

  if (loading || user === null) {
    return null;
  }

  return <>{children}</>;
}
