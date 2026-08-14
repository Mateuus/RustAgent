// ============================================================
//  url.ts  -  a URL do WebRCON e como escondê-la do log.
// ============================================================

/**
 * Monta `ws://host:porta/senha`.
 *
 * A senha vai CRUA no caminho, sem percent-encoding. Não é
 * descuido: o Rust compara o caminho recebido com a senha
 * configurada, byte a byte, sem decodificar. Mandar "%2F" faria
 * o servidor comparar a string "%2F" com "/" e recusar.
 *
 * É por isso que config.ts proíbe "/", "\", "?", "#" e espaço na
 * RCON_PASSWORD: sem encoding, não há como representá-los.
 */
export function buildRconUrl(host: string, port: number, password: string): string {
  return `ws://${host}:${port}/${password}`;
}

/**
 * Versão da URL segura para log.
 *
 * A senha do RCON dá execução de comando arbitrário no servidor.
 * Ela não pode aparecer em log, em mensagem de erro, nem em
 * stack trace — e a URL é justamente o lugar onde ela viaja
 * junto com informação que a gente QUER logar (host e porta).
 *
 * Toda mensagem que mencione a URL passa por aqui antes.
 */
export function maskRconUrl(url: string): string {
  // Regex em vez de new URL(): uma senha que torne a URL
  // inválida faria o construtor lançar, e o texto da exceção
  // levaria a senha junto para o log de erro. Mascarar não pode
  // ser a operação que vaza o segredo.
  const authority = /^(wss?:\/\/[^/]+)(\/.*)?$/i.exec(url)?.[1];

  // Formato inesperado: devolvemos um marcador genérico. Nunca a
  // string original — ela pode ser exatamente a que tem a senha.
  return authority === undefined ? '[invalid rcon url]' : `${authority}/***`;
}

/**
 * Descrição curta do destino, sem segredo nenhum. É o que vai
 * na maioria das mensagens de log.
 */
export function describeRconTarget(host: string, port: number): string {
  return `${host}:${port}`;
}
