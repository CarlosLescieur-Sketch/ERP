# ERP para MIPYMES (Node.js + Vite + PostgreSQL)

Sistema ERP modular con arquitectura hexagonal. Módulos: inventario, clientes y proveedores, compras, ventas y resumen financiero.

## Requisitos
- Node.js 20.6 o superior
- PostgreSQL 16 o superior (local, en Docker, o en Windows accedido desde WSL)

## Puesta en marcha

1. **Base de datos.** Con Docker: `docker compose up -d`. Sin Docker, crea el usuario y la base (ver "Configuración de la base de datos").
2. **Dependencias:** `npm run setup` (raíz, backend y frontend).
3. **Variables de entorno:** edita `backend/.env` (ver abajo).
4. **Tablas:** `npm run db:migrate`
5. **Ejecutar:** `npm run dev` levanta la API (http://localhost:3000) y el frontend (http://localhost:5173).

Solo el backend: desde `backend/`, `npm run dev` (recarga automática) o `npm start`.

## Configuración de la base de datos

`backend/.env`:

```
PORT=3000
DATABASE_URL=postgresql://usuario:password@host:puerto/base
```

Valores por defecto (coinciden con `docker-compose.yml`): `postgresql://erp:erp@localhost:5432/erp`. Si la contraseña tiene caracteres especiales, codifícalos en la URL (`@` = `%40`, `#` = `%23`). **No subas `.env` a git.**

### Crear usuario y base manualmente
Como administrador (`psql -U postgres`):

```sql
CREATE USER erp WITH PASSWORD 'erp';
CREATE DATABASE erp OWNER erp;
\c erp
GRANT ALL ON SCHEMA public TO erp;
ALTER SCHEMA public OWNER TO erp;
```

Desde PostgreSQL 15 el esquema `public` ya no es escribible por cualquier usuario, por eso se necesitan los dos últimos comandos. No des `SUPERUSER` a `erp`.

Comandos útiles en `psql`: `\du` (roles), `\dt` (tablas), `\c erp` (cambiar de base).

### PostgreSQL en Windows con el backend en WSL
1. En `postgresql.conf` (ruta con `SHOW config_file;`): `listen_addresses = '*'`.
2. En `pg_hba.conf` (¡otro archivo!), al final: `host all all 172.16.0.0/12 scram-sha-256`.
3. Firewall (PowerShell como administrador):
   `New-NetFirewallRule -DisplayName 'PostgreSQL WSL' -Direction Inbound -Protocol TCP -LocalPort 5432 -RemoteAddress 172.16.0.0/12 -Action Allow`
4. Reinicia el servicio: `Restart-Service postgresql-x64-<versión>`.
5. Desde WSL obtén la IP de Windows: `ip route show | grep default` (la que sigue a `via`) y pruébala con `nc -zv IP 5432`.
6. Usa esa IP en `DATABASE_URL`. Puede cambiar al reiniciar; con `networkingMode=mirrored` en `.wslconfig` (Windows 11) se puede usar `localhost`.

## Arquitectura hexagonal (`backend/src`)

| Carpeta | Rol |
|---|---|
| `domain/` | Reglas de negocio puras. Sin dependencias externas. |
| `application/` | Casos de uso (`useCases.js`) y contratos de los puertos (`ports.js`). |
| `adapters/in/http/` | Adaptador de entrada: Express traduce HTTP a casos de uso. |
| `adapters/out/postgres/` | Adaptador de salida: implementa los puertos con `pg`. |
| `main.js` | Raíz de composición: único lugar donde se conectan adaptadores y puertos. |

Un puerto es el contrato (p. ej. `findAll`, `save`); un adaptador es la implementación concreta. Para cambiar de base de datos solo se reescribe `adapters/out/`.

Flujo de `POST /api/products`: Express → caso de uso `createProduct` → `buildProduct` (valida) → `products.save` (puerto) → `INSERT` (adaptador Postgres).

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado de la API |
| GET | `/api/summary` | Resumen financiero |
| GET / POST | `/api/products` | Listar / crear productos |
| GET / POST | `/api/partners` | Listar (`?kind=customer\|supplier`) / crear |
| GET / POST | `/api/purchases` | Listar / registrar compras |
| GET / POST | `/api/sales` | Listar / registrar ventas |

Ejemplos de cuerpo (JSON):

```json
// POST /api/products
{ "sku": "TOR-001", "name": "Tornillo 1/4", "cost": 6, "price": 10, "stock": 0 }

// POST /api/partners
{ "kind": "supplier", "name": "Ferretería Sur", "email": "ventas@sur.com", "phone": "9611234567" }

// POST /api/purchases  (partnerId = proveedor)  |  POST /api/sales  (partnerId = cliente)
{ "partnerId": 1, "items": [ { "productId": 1, "quantity": 50, "unitPrice": 6 } ] }
```

Los ids dependen de tu base: consúltalos con `GET /api/partners?kind=...` y `GET /api/products`.

Códigos de error: `400` regla de negocio o validación, `404` recurso inexistente, `409` valor único repetido (SKU), `500` error interno.

## Reglas de negocio

### En la base de datos (`schema.sql`)
- `sku` único y obligatorio.
- `price`, `cost` y `stock` no pueden ser negativos.
- El tipo de tercero solo puede ser `customer` o `supplier`; el de orden, `purchase` o `sale`.
- Toda orden pertenece a un tercero existente; toda línea apunta a un producto existente.
- `quantity` de cada línea mayor a 0; `unit_price` no negativo.
- Al borrar una orden se borran sus líneas (`ON DELETE CASCADE`).

### En el dominio (`domain/`)
- Producto: SKU y nombre obligatorios; precio y costo numéricos no negativos; stock entero no negativo.
- Tercero: tipo válido y nombre obligatorio.
- Orden: requiere tercero y al menos una línea; cantidad entera mayor a 0; precio unitario no negativo.
- Total de la orden = suma de cantidad × precio unitario, redondeado a 2 decimales.

### En los casos de uso (`application/useCases.js`)
- Una venta solo puede hacerse a un **cliente**; una compra, solo a un **proveedor**.
- Una compra **suma** al stock; una venta lo **resta**.
- Una venta se rechaza si no hay stock suficiente.
- Orden, líneas y movimiento de inventario se guardan en **una sola transacción** (todo o nada).
- El producto se bloquea (`FOR UPDATE`) durante el registro para evitar que dos ventas simultáneas vendan el mismo stock.

### Resumen financiero
- Balance = ventas − compras.
- Valor del inventario = suma de stock × costo.
- Stock bajo = productos con 5 unidades o menos.

### Limitaciones actuales
- No hay cancelación de órdenes ni edición/borrado de productos.
- No hay autenticación ni usuarios del sistema.
- Un producto que aparece en alguna orden no puede borrarse (llave foránea).

## Solución de problemas

| Síntoma | Causa probable y solución |
|---|---|
| `password authentication failed for user "erp"` | El usuario no existe o la contraseña no coincide, o hay otro PostgreSQL ocupando el 5432. Crea el usuario o ajusta `DATABASE_URL`. |
| `permission denied for schema public` | Falta `GRANT ALL ON SCHEMA public TO erp;` (PostgreSQL 15+). |
| `node main.js` no funciona | Usa `npm run dev` o `npm start` desde `backend/`: cargan `.env` y la ruta `src/main.js`. |
| `Missing script: "setup"` | Ejecuta el comando desde la raíz, no desde `frontend/` ni `backend/`. |
| `Esta operación requiere un cliente/proveedor` | El `partnerId` no es del tipo correcto; consulta `GET /api/partners?kind=...`. |
| `409` al crear producto | SKU repetido. |
| El servicio de Postgres en Windows no arranca tras editar la config | Error de sintaxis; revísalo con `pg_ctl.exe start -D "<data>" -l "%TEMP%\pg_error.log"`. Las líneas `host all all ...` van en `pg_hba.conf`, **no** en `postgresql.conf`. |
| `nc` da `timed out` / `refused` | Firewall o servicio sin reiniciar / `listen_addresses` sin aplicar. |
