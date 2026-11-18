-- 006_archive: archivo de productos y terceros.
--
-- Borrar un registro que ya aparece en el historial es imposible por llave
-- foránea (order_items, quote_items, orders...), así que se implementa el
-- patrón «borrar si está libre, archivar si está en uso»:
--   * Si nada lo referencia, se borra de verdad.
--   * Si está en el historial, se ARCHIVA: `archived = true` lo saca de los
--     listados y de los formularios, pero el historial de ventas/compras y
--     cotizaciones lo sigue mostrando (los joins no filtran archived).
-- El flag se puede deshacer (restaurar) desde la interfaz.

ALTER TABLE products ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE partners  ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
