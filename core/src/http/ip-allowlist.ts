// ============================================================
//  ####  QUEM PODE FALAR COM O AGENTE  ####
//
//  Um token vazado ainda é um token válido. A lista de IPs é a
//  segunda tranca: mesmo com a chave em mãos, a chamada precisa
//  vir da rede certa.
//
//  ------------------------------------------------------------
//  ####  O IP TEM QUE SER O DE VERDADE  ####
//
//  Atrás de um proxy, o socket vê o IP do PROXY, e o do cliente
//  chega em `X-Forwarded-For` — um cabeçalho que qualquer um
//  escreve. Confiar nele sem proxy na frente transforma esta
//  lista em teatro: o atacante manda
//
//      X-Forwarded-For: 127.0.0.1
//
//  e entra.
//
//  Por isso o Fastify só o considera com `trustProxy` LIGADO, e
//  essa decisão fica na config do agente — quem sabe se há proxy
//  é quem instalou, não este arquivo.
//
//  ------------------------------------------------------------
//  ####  LISTA VAZIA LIBERA TUDO, E ISSO É PROPOSITAL  ####
//
//  A alternativa seria "vazio = ninguém entra", que é mais
//  seguro na teoria e um tiro no pé na prática: quem sobe o
//  agente pela primeira vez ficaria trancado do lado de fora, e
//  a reação seria desligar a checagem inteira.
//
//  Vazio significa "não configurei", e o agente registra isso no
//  boot para não passar despercebido.
// ============================================================

/**
 * Uma regra: IP exato ou faixa CIDR.
 *
 * `203.0.113.7`, `203.0.113.0/24`, `::1`, `2001:db8::/32`.
 */
export interface IpRule {
  readonly raw: string;
  readonly bytes: Uint8Array;
  readonly bits: number;
}

/**
 * Lê a lista. Regra inválida é DESCARTADA, não ignorada em
 * silêncio — quem chama recebe os erros para logar.
 *
 * Uma regra malformada que virasse "libera tudo" seria a pior
 * falha possível aqui.
 */
export function parseIpRules(values: readonly string[]): {
  rules: readonly IpRule[];
  invalid: readonly string[];
} {
  const rules: IpRule[] = [];
  const invalid: string[] = [];

  for (const value of values) {
    const raw = value.trim();
    if (raw === '') {
      continue;
    }

    const rule = parseRule(raw);
    if (rule === null) {
      invalid.push(raw);
    } else {
      rules.push(rule);
    }
  }

  return { rules, invalid };
}

function parseRule(raw: string): IpRule | null {
  const slash = raw.indexOf('/');
  const address = slash < 0 ? raw : raw.slice(0, slash);
  const bytes = parseAddress(address);

  if (bytes === null) {
    return null;
  }

  const maxBits = bytes.length * 8;

  if (slash < 0) {
    return { raw, bytes, bits: maxBits };
  }

  const bits = Number.parseInt(raw.slice(slash + 1), 10);

  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) {
    return null;
  }

  return { raw, bytes, bits };
}

/**
 * Endereço -> bytes. `null` se não for um IP.
 *
 * IPv4 mapeado em IPv6 (`::ffff:1.2.3.4`) vira IPv4: é assim que
 * um cliente IPv4 aparece num socket IPv6, e tratá-lo como outro
 * endereço faria a regra `1.2.3.4` nunca casar.
 */
export function parseAddress(value: string): Uint8Array | null {
  const address = value.trim().toLowerCase();

  if (address.startsWith('::ffff:') && address.includes('.')) {
    return parseAddress(address.slice('::ffff:'.length));
  }

  if (address.includes('.')) {
    const parts = address.split('.');
    if (parts.length !== 4) {
      return null;
    }

    const bytes = new Uint8Array(4);

    for (const [index, part] of parts.entries()) {
      // `Number.parseInt` aceitaria "12abc" e "1e2". Aqui só
      // dígitos servem — um octeto tolerante deixaria passar
      // lixo que casaria com regra nenhuma, mas confundiria quem
      // depurasse depois.
      if (!/^\d{1,3}$/.test(part)) {
        return null;
      }

      const octet = Number(part);
      if (octet > 255) {
        return null;
      }

      bytes[index] = octet;
    }

    return bytes;
  }

  if (!address.includes(':')) {
    return null;
  }

  return parseIpv6(address);
}

function parseIpv6(address: string): Uint8Array | null {
  const halves = address.split('::');
  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] === '' ? [] : (halves[0]?.split(':') ?? []);
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1]?.split(':') ?? [])) : [];

  const groups = head.length + tail.length;
  if (groups > 8 || (halves.length === 1 && groups !== 8)) {
    return null;
  }

  const bytes = new Uint8Array(16);
  let at = 0;

  const write = (group: string): boolean => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return false;
    }

    const value = Number.parseInt(group, 16);
    bytes[at] = (value >> 8) & 0xff;
    bytes[at + 1] = value & 0xff;
    at += 2;
    return true;
  };

  for (const group of head) {
    if (!write(group)) return null;
  }

  // O `::` vira zeros: eles já estão lá, basta pular.
  at = 16 - tail.length * 2;

  for (const group of tail) {
    if (!write(group)) return null;
  }

  return bytes;
}

/** O endereço casa com alguma regra? Lista vazia = sim. */
export function isIpAllowed(ip: string, rules: readonly IpRule[]): boolean {
  if (rules.length === 0) {
    return true;
  }

  const bytes = parseAddress(ip);
  if (bytes === null) {
    // IP que não sabemos ler NÃO passa. Este é o único caso em
    // que o desconhecido é tratado como hostil, e é o certo:
    // liberar por não entender é como não ter lista.
    return false;
  }

  return rules.some((rule) => matches(bytes, rule));
}

function matches(bytes: Uint8Array, rule: IpRule): boolean {
  // Famílias diferentes nunca casam: 1.2.3.4 não está em ::/0.
  if (bytes.length !== rule.bytes.length) {
    return false;
  }

  const fullBytes = Math.floor(rule.bits / 8);
  const restBits = rule.bits % 8;

  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== rule.bytes[index]) {
      return false;
    }
  }

  if (restBits === 0) {
    return true;
  }

  // Os bits que sobram do último byte, da esquerda para a
  // direita: /20 compara o terceiro byte só nos 4 primeiros bits.
  const mask = 0xff << (8 - restBits);
  return ((bytes[fullBytes] ?? 0) & mask) === ((rule.bytes[fullBytes] ?? 0) & mask);
}
