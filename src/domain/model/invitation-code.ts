/**
 * El alfabeto de Crockford: treinta y dos caracteres sin I, L, O ni U. La I y la L se confunden con el 1, la O con el
 * 0 y la U con la V al leer o dictar un codigo; al escribirlo se aceptan como el digito que parecen.
 */
export const INVITATION_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Dieciseis caracteres de cinco bits son ochenta bits: adivinar un codigo no es cuestion de intentar (ADR 0023). */
export const INVITATION_CODE_LENGTH = 16;

/** Los bytes que hacen falta para dieciseis caracteres de cinco bits. */
const BYTES = (INVITATION_CODE_LENGTH * 5) / 8;

/** Lo que una persona puede pegar por descuido: mas que esto no es un codigo y no se lee. */
const MAX_TYPED_LENGTH = 64;

/** Lo que se ignora al leer un codigo escrito: guiones y cualquier espacio. */
const SEPARATORS = /[\s-]/gu;

/**
 * El codigo a partir de diez bytes al azar: se leen como dieciseis grupos de cinco bits, en orden. La funcion es pura;
 * quien aporta el azar es el adaptador que genera la invitacion.
 */
export function invitationCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== BYTES) {
    throw new RangeError(`An invitation code is made of ${BYTES} bytes: ${bytes.length}`);
  }
  let bits = 0;
  let value = 0;
  let code = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += INVITATION_CODE_ALPHABET[(value >> bits) & 31];
    }
    // Solo se conservan los bits que aun no se usaron.
    value &= (1 << bits) - 1;
  }
  return code;
}

/** El codigo como lo ve una persona: de cuatro en cuatro, para leerlo en pantalla y dictarlo. */
export function formatInvitationCode(code: string): string {
  return code.match(/.{1,4}/gu)?.join('-') ?? code;
}

/**
 * El codigo canonico (mayusculas, sin separadores) de lo que una persona escribio, o `undefined` si no es un codigo.
 * Perdona lo que se tecleo mal sin ser ambiguo: mayusculas y minusculas, guiones y espacios, y las letras que se
 * parecen a un digito (O es 0; I y L son 1).
 */
export function normalizeInvitationCode(text: unknown): string | undefined {
  if (typeof text !== 'string' || text.length > MAX_TYPED_LENGTH) return undefined;
  const code = text
    .replace(SEPARATORS, '')
    .toUpperCase()
    .replaceAll('O', '0')
    .replaceAll('I', '1')
    .replaceAll('L', '1');
  if (code.length !== INVITATION_CODE_LENGTH) return undefined;
  for (const character of code) {
    if (!INVITATION_CODE_ALPHABET.includes(character)) return undefined;
  }
  return code;
}
