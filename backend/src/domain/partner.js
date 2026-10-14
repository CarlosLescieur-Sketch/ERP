import { DomainError } from './errors.js';

export const PARTNER_KINDS = ['customer', 'supplier'];

export function buildPartner({ kind, name, email = null, phone = null }) {
  if (!PARTNER_KINDS.includes(kind)) throw new DomainError('El tipo debe ser customer o supplier');
  if (!name?.trim()) throw new DomainError('El nombre es obligatorio');
  return { kind, name: name.trim(), email: email?.trim() || null, phone: phone?.trim() || null };
}
