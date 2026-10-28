// Hash de contraseñas con scrypt (node:crypto): sin dependencias externas ni
// binarios que compilar. Formato guardado: `scrypt:<salt>:<hash en hex>`.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const KEYLEN = 64;
const PREFIX = 'scrypt';

export const passwords = {
  async hash(plain) {
    const salt = randomBytes(16).toString('hex');
    const key = await scrypt(plain, salt, KEYLEN);
    return `${PREFIX}:${salt}:${key.toString('hex')}`;
  },

  async verify(plain, stored) {
    const [algo, salt, expectedHex] = String(stored ?? '').split(':');
    if (algo !== PREFIX || !salt || !expectedHex) return false;
    const key = await scrypt(plain, salt, KEYLEN);
    const expected = Buffer.from(expectedHex, 'hex');
    return key.length === expected.length && timingSafeEqual(key, expected);
  },
};
