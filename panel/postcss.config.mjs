// ============================================================
//  Um plugin só, e é assim mesmo desde o Tailwind 4.
//
//  O `tailwindcss` deixou de ser plugin de PostCSS e virou o
//  pacote `@tailwindcss/postcss`. O `autoprefixer` saiu junto:
//  os prefixos passaram a ser trabalho do próprio Tailwind, e
//  mantê-lo aqui faria a mesma passada duas vezes.
// ============================================================

/** @type {import('postcss-load-config').Config} */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
