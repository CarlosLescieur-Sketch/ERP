-- 004_quotes: cotizaciones con máquina de estados.
--
-- Estados: borrador → enviada → (aceptada | rechazada | vencida) → convertida.
-- Al convertirse, `converted_order_id` apunta a la venta generada, enlazando
-- el ciclo completo cotización → venta.
-- Los totales usan el mismo cálculo que las órdenes (redondeo por línea).

CREATE TABLE quotes (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','accepted','rejected','expired','converted')),
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  note TEXT,
  expires_at TIMESTAMPTZ,
  converted_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quote_items (
  id SERIAL PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 16 CHECK (tax_rate >= 0 AND tax_rate <= 100)
);

CREATE INDEX quotes_status_idx ON quotes(status);
CREATE INDEX quote_items_quote_id_idx ON quote_items(quote_id);
