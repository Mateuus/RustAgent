// ============================================================
//  version.ts  -  a versão do agente, em um lugar só.
//
//  ####  ELA PRECISAVA SAIR DO index.ts  ####
//
//  Era `const VERSION = '1.0.0'` declarada dentro de `index.ts`,
//  sem export — e `config.ts` não a alcançava. Com a integração do
//  site, a versão passou a aparecer no `User-Agent` de toda chamada
//  e no corpo do beacon, que são montados na configuração. Um
//  literal repetido lá seria a segunda verdade sobre a versão, e
//  ela viajaria no fio enquanto o `index.ts` já tivesse subido para
//  a seguinte.
// ============================================================

export const VERSION = '1.0.0';
