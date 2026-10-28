// Cotizaciones: construcción, máquina de estados y conversión a venta.
//
// Estados:
//   borrador  → enviada
//   enviada   → aceptada | rechazada | vencida
//   aceptada  → convertida (genera la venta)
//   rechazada, vencida, convertida = terminales
//
// La caducidad se evalúa de forma perezosa: una cotización `enviada` cuya
// `expires_at` ya pasó se trata como `vencida` aunque en la BD aún diga
// `enviada` (no hay cron; la transición efectiva se calcula al leer).
import { DomainError, NotFoundError } from './errors.js';
import { orderTotals, DEFAULT_TAX_RATE } from './tax.js';

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted'];
export const QUOTE_STATUS_LABELS = {
  draft: 'Borrador', sent: 'Enviada', accepted: 'Aceptada',
  rejected: 'Rechazada', expired: 'Vencida', converted: 'Convertida',
};

// Mapa de transiciones permitidas. Toda transición no listada es inválida.
const TRANSITIONS = {
  draft: ['sent'],
  sent: ['accepted', 'rejected', 'expired'],
  accepted: ['converted'],
  rejected: [],
  expired: [],
  converted: [],
};

export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

/** Transiciones válidas desde un estado (para pintar botones en el frontend). */
export const allowedTransitions = (from) => [...(TRANSITIONS[from] ?? [])];

/**
 * Estado efectivo: `sent` + fecha de caducidad vencida → `expired`.
 * Es la única fuente de verdad para mostrar y validar transiciones.
 */
export function effectiveStatus(quote, now = Date.now()) {
  if (quote.status === 'sent' && quote.expiresAt && new Date(quote.expiresAt).getTime() <= now) {
    return 'expired';
  }
  return quote.status;
}

/** Lanza el error adecuado si la transición no está permitida. */
export function assertTransition(quote, to, now = Date.now()) {
  if (!QUOTE_STATUSES.includes(to)) throw new DomainError('Estado de cotización inválido');
  const from = effectiveStatus(quote, now);
  if (from === to) throw new DomainError(`La cotización ya está en estado "${QUOTE_STATUS_LABELS[to] ?? to}"`);
  if (!canTransition(from, to))
    throw new DomainError(
      `No se puede pasar de "${QUOTE_STATUS_LABELS[from] ?? from}" a "${QUOTE_STATUS_LABELS[to] ?? to}"`);
}

/**
 * Valida una cotización nueva y calcula sus totales con IVA.
 * Solo el estado inicial `draft` es válido al crear.
 */
export function buildQuote({ partnerId, items, note = null, expiresAt = null, taxRate = DEFAULT_TAX_RATE, createdBy = null }) {
  if (!partnerId) throw new DomainError('Selecciona un cliente');
  if (!Array.isArray(items) || items.length === 0) throw new DomainError('Agrega al menos un producto');

  const rate = Number(taxRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new DomainError('La tasa de impuesto es inválida');

  const lines = items.map((i) => {
    const line = {
      productId: Number(i.productId),
      quantity: Number(i.quantity),
      unitPrice: Number(i.unitPrice),
      taxRate: i.taxRate === undefined ? rate : Number(i.taxRate),
    };
    if (!line.productId) throw new DomainError('Producto inválido en una línea');
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new DomainError('La cantidad debe ser un entero mayor a 0');
    if (!(line.unitPrice >= 0)) throw new DomainError('El precio unitario es inválido');
    if (!Number.isFinite(line.taxRate) || line.taxRate < 0 || line.taxRate > 100)
      throw new DomainError('La tasa de impuesto es inválida');
    return line;
  });

  let expires = null;
  if (expiresAt) {
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) throw new DomainError('La fecha de caducidad no es válida');
    if (d.getTime() <= Date.now()) throw new DomainError('La fecha de caducidad debe estar en el futuro');
    expires = d.toISOString();
  }

  const { subtotal, tax, total } = orderTotals(lines);
  return {
    status: 'draft',
    partnerId: Number(partnerId),
    items: lines,
    subtotal,
    tax,
    total,
    note: note?.trim() || null,
    expiresAt: expires,
    createdBy,
    convertedOrderId: null,
  };
}

/** Convierte una cotización aceptada en el input de la venta equivalente. */
export function quoteToOrderInput(quote) {
  if (quote.items.length === 0) throw new NotFoundError('La cotización no tiene líneas');
  return {
    partnerId: quote.partnerId,
    items: quote.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice })),
  };
}
