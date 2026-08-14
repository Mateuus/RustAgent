// ============================================================
//  Design system do painel.
//
//  As cores NÃO estão escritas aqui: elas moram como custom
//  properties em src/app/globals.css, e este arquivo só dá nome
//  de utilitário a cada uma. Assim existe UM lugar para conferir
//  o token (o :root do CSS) em vez de dois que podem divergir.
//
//  CUIDADO: como os tokens são hex dentro de var(), o modificador
//  de opacidade do Tailwind NÃO funciona — `bg-surface/50` sai
//  como cor inválida, silenciosamente. Precisando de meio-tom,
//  crie um token novo no globals.css.
// ============================================================
import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--bg)',
        surface: {
          DEFAULT: 'var(--surface)',
          2: 'var(--surface-2)',
        },
        border: 'var(--border)',
        foreground: 'var(--text)',
        muted: 'var(--text-muted)',

        // Chrome. Ver a nota de contraste no README: rust dá
        // 3.7:1 sobre o fundo, o que serve para ícone e borda
        // (WCAG 1.4.11 pede 3:1) mas NÃO para texto corrido.
        rust: 'var(--rust-red)',
        olive: 'var(--olive)',
        amber: 'var(--amber)',

        // Paleta de GRÁFICO, nesta ordem. Não é intercambiável
        // com o chrome acima: rust e olive têm ΔE 3.4 sob
        // deuteranopia, ou seja, um daltônico não separa os dois
        // numa legenda. Nenhum gráfico existe no MVP; os tokens
        // ficam definidos para o primeiro que aparecer.
        chart: {
          1: 'var(--chart-1)',
          2: 'var(--chart-2)',
          3: 'var(--chart-3)',
          4: 'var(--chart-4)',
        },
      },

      fontFamily: {
        // Corpo.
        sans: ['Inter', 'system-ui', 'sans-serif'],
        // Títulos, rótulos e números grandes.
        condensed: ['"Roboto Condensed"', 'Inter', 'system-ui', 'sans-serif'],
      },

      // Cantos retos é regra do design system, não preferência.
      // Redefinir a ESCALA inteira (e não só o padrão) é o que
      // impede um `rounded-full` copiado de algum exemplo de
      // shadcn de virar pílula no meio da tela.
      borderRadius: {
        none: '0px',
        sm: '2px',
        DEFAULT: '2px',
        md: '4px',
        lg: '4px',
        xl: '4px',
        '2xl': '4px',
        '3xl': '4px',
        full: '4px',
      },

      fontSize: {
        // Rótulo de KPI e cabeçalho de tabela.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },

      // Entrada dos toasts. Curta e sem elástico: a pilha fica no
      // canto inferior direito e cresce para baixo, então o
      // movimento acompanha a direção em que o item chega.
      //
      // Quem usa `animate-toast-in` acrescenta
      // `motion-reduce:animate-none` — o painel fica aberto o dia
      // todo, e movimento repetido é justamente o que a
      // preferência de movimento reduzido pede para cortar.
      keyframes: {
        'toast-in': {
          from: { opacity: '0', transform: 'translate3d(0, 0.5rem, 0)' },
          to: { opacity: '1', transform: 'translate3d(0, 0, 0)' },
        },
      },
      animation: {
        'toast-in': 'toast-in 160ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
