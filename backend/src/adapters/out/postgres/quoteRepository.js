// Repositorio de cotizaciones (cabecera, líneas y transiciones de estado).
const toQuote = (r) => ({
  id: r.id,
  partnerId: r.partner_id,
  status: r.status,
  subtotal: Number(r.subtotal),
  tax: Number(r.tax),
  total: Number(r.total),
  note: r.note,
  expiresAt: r.expires_at,
  convertedOrderId: r.converted_order_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const makeQuoteRepository = (db) => ({
  /** Listado para el índice: cabecera + cliente + unidades. */
  async findAll(status) {
    const { rows } = await db.query(
      `SELECT q.*, p.name AS partner,
              COALESCE((SELECT SUM(i.quantity) FROM quote_items i WHERE i.quote_id = q.id), 0)::int AS units
         FROM quotes q JOIN partners p ON p.id = q.partner_id
        WHERE ($1::text IS NULL OR q.status = $1)
        ORDER BY q.created_at DESC LIMIT 100`, [status ?? null]);
    return rows.map((r) => ({ ...toQuote(r), partner: r.partner, units: r.units }));
  },

  /** Cabecera con bloqueo opcional (para transiciones dentro de transacción). */
  async findById(id, { lock = false } = {}) {
    const { rows } = await db.query(
      `SELECT * FROM quotes WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!rows[0]) return null;
    const q = toQuote(rows[0]);
    const items = await db.query(
      `SELECT i.product_id, i.quantity, i.unit_price, i.tax_rate, pr.sku, pr.name FROM quote_items i JOIN products pr ON pr.id = i.product_id WHERE i.quote_id = $1 ORDER BY i.id`, [id]);
    const partner = await db.query('SELECT name, kind FROM partners WHERE id = $1', [q.partnerId]);
    return {
      ...q,
      partner: partner.rows[0]?.name ?? null,
      partnerKind: partner.rows[0]?.kind ?? null,
      items: items.rows.map((i) => ({
        productId: i.product_id,
        sku: i.sku,
        name: i.name,
        quantity: i.quantity,
        unitPrice: Number(i.unit_price),
        taxRate: Number(i.tax_rate),
      })),
    };
  },

  async save(quote) {
    const { rows } = await db.query(
      `INSERT INTO quotes (partner_id, status, subtotal, tax, total, note, expires_at, converted_order_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [quote.partnerId, quote.status, quote.subtotal, quote.tax, quote.total,
       quote.note, quote.expiresAt, quote.convertedOrderId, quote.createdBy]);
    const id = rows[0].id;
    for (const l of quote.items) {
      await db.query(
        `INSERT INTO quote_items (quote_id, product_id, quantity, unit_price, tax_rate)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, l.productId, l.quantity, l.unitPrice, l.taxRate]);
    }
    return toQuote(rows[0]);
  },

  /** Cambia el estado y marca updated_at. La validación la hace el dominio. */
  async transition(id, status, { convertedOrderId = null } = {}) {
    const { rows } = await db.query(
      `UPDATE quotes SET status = $2, converted_order_id = COALESCE($3, converted_order_id), updated_at = now()
        WHERE id = $1 RETURNING *`, [id, status, convertedOrderId]);
    if (!rows[0]) return null;
    return toQuote(rows[0]);
  },
});
