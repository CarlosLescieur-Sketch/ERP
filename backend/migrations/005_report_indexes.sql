-- 005_report_indexes: índices que sostienen las consultas del dashboard
-- (serie mensual de órdenes, cobros por ventana y detalle de líneas).
-- Antes estas tablas se recorrían enteras en cada carga de Resumen.

CREATE INDEX orders_created_at_idx   ON orders(created_at);
CREATE INDEX payments_paid_at_idx    ON payments(paid_at);
CREATE INDEX order_items_order_id_idx ON order_items(order_id);
