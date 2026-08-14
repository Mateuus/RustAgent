'use client';

// ============================================================
//  Navegação lateral.
//
//  Duas apresentações do MESMO menu:
//
//    <Sidebar/>    coluna fixa, a partir de lg. Recolhível, com
//                  a preferência guardada no localStorage.
//    <MobileNav/>  barra no topo com botão, abaixo de lg. O menu
//                  vira gaveta sobreposta — NÃO empurra o
//                  conteúdo, que numa tela estreita jogaria a
//                  tabela para fora da janela.
//
//  ------------------------------------------------------------
//  FUNDO MAIS ESCURO QUE O CONTEÚDO, SEM TOKEN NOVO
//
//  A barra fica em --bg (#0F0F0F), o tom mais escuro da paleta,
//  enquanto TODO bloco de conteúdo é --surface ou --surface-2. A
//  diferença de superfície é o que separa a navegação do
//  conteúdo; a borda de 1px à direita fecha o desenho.
// ============================================================

import {
  ChevronsLeft,
  ChevronsRight,
  LayoutDashboard,
  LogOut,
  Menu,
  Server,
  Settings,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'rustagent.panel.sidebar-collapsed';

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly hint: string;
  readonly Icon: LucideIcon;
}

const NAV: readonly NavItem[] = [
  {
    href: '/',
    label: 'Dashboard',
    hint: 'A máquina, o agente e os servidores num relance',
    Icon: LayoutDashboard,
  },
  {
    href: '/servidores/',
    label: 'Servidores',
    hint: 'Criar, instalar, subir e cuidar de cada servidor',
    Icon: Server,
  },
  {
    href: '/config/',
    label: 'Agente',
    hint: 'Versão, caminhos e como mudar a configuração',
    Icon: Settings,
  },
];

/** `/` casaria com tudo se fosse `startsWith`. */
function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }

  return pathname.startsWith(href.replace(/\/$/, ''));
}

function SidebarBrand({ isCollapsed }: { readonly isCollapsed: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-border py-3',
        isCollapsed ? 'justify-center px-0' : 'px-3',
      )}
    >
      {/* Barra de acento do design system. Recolhida, ela é a
          própria marca — não sobra largura para o nome. */}
      <span aria-hidden="true" className="h-6 w-1 shrink-0 bg-rust" />
      {!isCollapsed && (
        <span className="truncate font-condensed text-lg font-bold uppercase tracking-wide text-foreground">
          RustAgent
        </span>
      )}
    </div>
  );
}

interface SidebarNavProps {
  readonly isCollapsed: boolean;
  /** A gaveta fecha ao navegar; a coluna fixa não faz nada. */
  readonly onNavigate?: () => void;
}

function SidebarNav({ isCollapsed, onNavigate }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <nav aria-label="Navegação principal" className="flex-1 overflow-y-auto py-2">
      <ul>
        {NAV.map((item) => {
          const active = isActivePath(pathname, item.href);
          const { Icon } = item;

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                // `aria-current="page"` é o que diz ao leitor de
                // tela qual item está ativo. A barra vermelha
                // sozinha não fala com ninguém.
                aria-current={active ? 'page' : undefined}
                title={isCollapsed ? `${item.label} — ${item.hint}` : item.hint}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-3 border-l-[3px] py-2',
                  'font-condensed text-sm font-bold uppercase tracking-wide',
                  isCollapsed ? 'justify-center px-0' : 'px-3',
                  active
                    ? 'border-l-rust bg-surface text-foreground'
                    : 'border-l-transparent text-muted hover:bg-surface hover:text-foreground',
                )}
              >
                <Icon aria-hidden="true" className={cn('h-4 w-4 shrink-0', active && 'text-rust')} />
                {/* Recolhida, o rótulo continua no DOM para o
                    leitor de tela; só sai do desenho. */}
                <span className={cn('truncate', isCollapsed && 'sr-only')}>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface SidebarFooterProps {
  readonly isCollapsed: boolean;
  /** O botão de recolher, que só a coluna fixa tem. */
  readonly children?: ReactNode;
}

/**
 * Rodapé: quem entrou e a saída.
 *
 * A conta fica AQUI, e não no cabeçalho de cada tela: ela vale
 * para o painel inteiro, e o caminho para SAIR não pode ficar
 * escondido numa tela que a pessoa precisa adivinhar que existe.
 */
function SidebarFooter({ isCollapsed, children }: SidebarFooterProps) {
  const { user, signOut } = useSession();

  return (
    <div className={cn('space-y-2 border-t border-border py-2', isCollapsed ? 'px-1' : 'px-3')}>
      <div
        className={cn(
          'flex items-center gap-2 border border-border bg-surface px-2 py-1.5',
          isCollapsed && 'justify-center px-1',
        )}
        title={`Conectado como ${user ?? '—'}`}
      >
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-olive" />
        <span className={cn('min-w-0 truncate', isCollapsed && 'sr-only')}>
          <span className="block font-condensed text-2xs font-bold uppercase tracking-wide text-foreground">
            {user ?? '—'}
          </span>
          <span className="block truncate text-2xs text-muted">operador</span>
        </span>
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => void signOut()}
        aria-label="Sair do painel"
        className={cn('w-full text-muted', isCollapsed ? 'px-0' : 'justify-start')}
      >
        <LogOut aria-hidden="true" className="h-4 w-4" />
        <span className={cn(isCollapsed && 'sr-only')}>Sair</span>
      </Button>

      {children}
    </div>
  );
}

// ------------------------------------------------------------
//  Coluna fixa (lg+)
// ------------------------------------------------------------
export function Sidebar() {
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Lido DEPOIS da montagem, nunca no estado inicial: a página é
  // pré-renderizada em tempo de build, e ler o localStorage no
  // primeiro render daria um HTML diferente do que o navegador
  // calcula — a hidratação quebraria. O preço é a barra nascer
  // aberta por um quadro para quem a deixou recolhida.
  useEffect(() => {
    try {
      setIsCollapsed(window.localStorage.getItem(STORAGE_KEY) === 'true');
    } catch {
      // localStorage bloqueado (janela anônima, política do
      // navegador). A barra abre expandida, que é o padrão.
    }
  }, []);

  const toggle = (): void => {
    const next = !isCollapsed;

    setIsCollapsed(next);

    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // A preferência não persiste, mas a sessão atual continua
      // valendo — não é motivo para esconder o botão.
    }
  };

  return (
    // `sticky top-0 h-screen` em vez de `fixed`: dentro do flex da
    // casca, a coluna acompanha a rolagem sem que o conteúdo
    // precise de uma margem esquerda calculada na mão, que
    // dessincronizaria a cada mudança de largura.
    <aside
      className={cn(
        'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-background lg:flex',
        'transition-[width] duration-150',
        isCollapsed ? 'w-14' : 'w-56',
      )}
    >
      <SidebarBrand isCollapsed={isCollapsed} />
      <SidebarNav isCollapsed={isCollapsed} />
      <SidebarFooter isCollapsed={isCollapsed}>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          aria-label={isCollapsed ? 'Expandir a barra lateral' : 'Recolher a barra lateral'}
          className={cn('w-full text-muted', isCollapsed ? 'px-0' : 'justify-start')}
        >
          {isCollapsed ? (
            <ChevronsRight aria-hidden="true" className="h-4 w-4" />
          ) : (
            <>
              <ChevronsLeft aria-hidden="true" className="h-4 w-4" />
              Recolher
            </>
          )}
        </Button>
      </SidebarFooter>
    </aside>
  );
}

// ------------------------------------------------------------
//  Barra do topo + gaveta (abaixo de lg)
// ------------------------------------------------------------
export function MobileNav() {
  const [isOpen, setIsOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // <dialog> nativo, e não uma <div> com role="dialog", porque o
  // `showModal()` traz de graça o que uma gaveta acessível exige e
  // é chato de reimplementar: Escape fecha, o foco fica preso
  // dentro dela, o resto da página vira inerte para o leitor de
  // tela, e ao fechar o foco volta sozinho para o botão que abriu.
  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (isOpen && !dialog.open) {
      dialog.showModal();
    }

    if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  const close = (): void => {
    setIsOpen(false);
  };

  return (
    // O <dialog> fica FORA do container `lg:hidden` de propósito.
    // Um dialog modal dentro de um ancestral com `display: none`
    // deixa de ser desenhado sem deixar de estar aberto — e como
    // `showModal()` torna o resto da página inerte, redimensionar
    // a janela com a gaveta aberta travaria o painel inteiro sem
    // nada visível para fechar.
    <>
      <div className="flex items-center gap-3 border-b border-border bg-surface px-3 py-2 lg:hidden">
        <Button
          variant="outline"
          size="sm"
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls="main-nav-drawer"
          onClick={() => setIsOpen(true)}
        >
          <Menu aria-hidden="true" className="h-4 w-4" />
          Menu
        </Button>

        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="h-5 w-1 shrink-0 bg-rust" />
          <span className="truncate font-condensed text-base font-bold uppercase tracking-wide text-foreground">
            RustAgent
          </span>
        </span>
      </div>

      <dialog
        id="main-nav-drawer"
        ref={dialogRef}
        aria-label="Navegação principal"
        // O `close` cobre TODOS os caminhos de fechamento —
        // inclusive o Escape, que o navegador trata sozinho e que
        // de outro modo deixaria o estado dizendo "aberta".
        onClose={close}
        onClick={(event) => {
          // Clique no ::backdrop é despachado no próprio <dialog>;
          // clique no conteúdo tem o alvo lá dentro. É assim que
          // se distingue "clicou fora" de "clicou num link".
          if (event.target === dialogRef.current) {
            close();
          }
        }}
        className={cn(
          // O UA centraliza o dialog modal com `margin: auto`;
          // `m-0` + `h-full` o encostam na borda esquerda em
          // altura cheia, virando gaveta.
          'm-0 h-full max-h-none w-60 max-w-[85vw] p-0',
          'border-r border-border bg-background text-foreground',
        )}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="h-6 w-1 shrink-0 bg-rust" />
              <span className="truncate font-condensed text-lg font-bold uppercase tracking-wide">
                RustAgent
              </span>
            </span>

            <Button variant="ghost" size="sm" aria-label="Fechar o menu" onClick={close}>
              <X aria-hidden="true" className="h-4 w-4" />
            </Button>
          </div>

          <SidebarNav isCollapsed={false} onNavigate={close} />
          <SidebarFooter isCollapsed={false} />
        </div>
      </dialog>
    </>
  );
}
