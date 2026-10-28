-- 003_billing: IVA por línea y pagos parciales (cuentas por cobrar/pagar).
--
-- Diseño:
--   * El precio unitario es NETO (sin impuesto) y el IVA se calcula y redondea
--     POR LÍNEA para que la suma de líneas siempre cuadre con la orden.
--   * El saldo NO se almacena: siempre es total − SUM(payments).
--
-- Órdenes históricas: se conservan EXACTAMENTE como se emitieron (total
-- intacto) y se marcan con tasa 0: se registraron sin desglose de impuestos.
-- No se reescribe el histórico financiero (+16% retroactivo falsearía las
-- ventas/compras ya reportadas).

ALTER TABLE orders
  ADD COLUMN subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN tax NUMERIC(14,2) NOT NULL DEFAULT 0;

ALTER TABLE order_items
  ADD COLUMN tax_rate NUMERIC(5,2) NOT NULL DEFAULT 16
  CHECK (tax_rate >= 0 AND tax_rate <= 100);

-- Histórico: sin desglose de IVA, subtotal = total ya emitido.
UPDATE order_items SET tax_rate = 0;
UPDATE orders SET subtotal = total, tax = 0;

CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','transfer','card')),
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payments_order_id_idx ON payments(order_id);
