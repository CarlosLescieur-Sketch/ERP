# ERP para MIPYMES (Node.js + Vite + PostgreSQL)

Sistema ERP modular con arquitectura hexagonal. Módulos: inventario, clientes y proveedores, compras, ventas (con IVA 16% y pagos parciales), cotizaciones con máquina de estados, resumen financiero y autenticación con roles.

## Requisitos
- Node.js 20.6 o superior
- PostgreSQL 16 o superior (local, en Docker, o en Windows accedido desde WSL)

## Puesta en marcha

1. **Base de datos.** Con Docker: `docker compose up -d`. Sin Docker, crea el usuario y la base (ver "Configuración de la base de datos").
2. **Dependencias:** `npm run setup` (raíz, backend y frontend).
3. **Variables de entorno:** edita `backend/.env` (ver abajo).
4. **Tablas:** `npm run db:migrate` (migraciones versionadas en `backend/migrations/`; se aplican solas las que falten).
5. **Usuario administrador:** `npm run db:seed` → crea `admin@local.dev` con contraseña `Admin123!` (cámbiala tras el primer login).
6. **Ejecutar:** `npm run dev` levanta la API (http://localhost:3000) y el frontend (http://localhost:5173).

Solo el backend: desde `backend/`, `npm run dev` (recarga automática) o `npm start`.

## Tests y CI

```bash
npm test                # raíz: suite completa (unitarios + integración)
npm --prefix backend test
npm --prefix frontend run build
```

- **Unitarios:** dominio y casos de uso con puertos falsos en memoria (sin base de datos).
- **Integración:** repositorios contra un esquema aislado `erp_test_<pid>` dentro de tu propia base (no requiere `CREATEDB`). Si PostgreSQL no está accesible, **se saltan** en lugar de fallar.
- **Concurrencia:** hay tests que lanzan pagos simultáneos reales para verificar el bloqueo `FOR UPDATE`.
- **CI:** `.github/workflows/ci.yml` levanta PostgreSQL 16, aplica migraciones, corre `npm test` y build del frontend en cada push/PR.

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

Todas las rutas salvo `/api/health` y `/api/auth/login` requieren sesión (cookie httpOnly que crea el login). Sin sesión → `401`; sin permiso para la acción → `403`.

### Sesión y usuarios
| Método | Ruta | Permiso requerido | Descripción |
|---|---|---|---|
| POST | `/api/auth/login` | — | Inicia sesión (`{ email, password }`); crea cookie httpOnly |
| POST | `/api/auth/logout` | — | Cierra la sesión |
| GET | `/api/auth/me` | cualquiera | Usuario actual + sus permisos |
| POST | `/api/auth/change-password` | cualquiera | `{ currentPassword, newPassword }` (mín. 8) |
| GET / POST | `/api/users` | `users:manage` (admin) | Listar / crear usuarios |
| GET | `/api/health` | — | Estado de la API |

### Negocio
| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/api/summary` | cualquiera | Resumen (incluye por cobrar / por pagar) |
| GET | `/api/reports/dashboard` | cualquiera | Dashboard: serie mensual (`?months=3..24`), top productos/clientes, cobros por método y cotizaciones por estado |
| GET / POST | `/api/products` | escritura: `products:write` | Listar / crear productos |
| GET / POST | `/api/partners` | escritura: `partners:write` | Listar (`?kind=customer\|supplier`) / crear |
| GET / POST | `/api/purchases` | escritura: `purchases:write` | Listar / registrar compras |
| GET / POST | `/api/sales` | escritura: `sales:write` | Listar / registrar ventas |
| GET | `/api/sales/:id`, `/api/purchases/:id` | cualquiera | Detalle: líneas, pagos y saldo |
| POST | `/api/sales/:id/payments`, `/api/purchases/:id/payments` | `payments:write` | Registrar pago parcial |
| GET / POST | `/api/quotes` | escritura: `quotes:write` | Listar / crear cotización (borrador) |
| GET | `/api/quotes/:id` | cualquiera | Detalle con estado efectivo y transiciones permitidas |
| PATCH | `/api/quotes/:id/status` | `quotes:write` | Cambiar estado (máquina de estados) |
| POST | `/api/quotes/:id/convert` | `quotes:write` | Convertir cotización aceptada en venta |

### Roles
| Permiso | `admin` | `vendedor` | `bodeguero` |
|---|:--:|:--:|:--:|
| `users:manage` | ✅ | — | — |
| `products:write`, `purchases:write` | ✅ | — | ✅ |
| `sales:write`, `quotes:write` | ✅ | ✅ | — |
| `payments:write`, `partners:write` | ✅ | ✅ | ✅ |

El frontend solo oculta botones según estos permisos; **la autoridad es el backend**, que los vuelve a comprobar en cada request.

Ejemplos de cuerpo (JSON):

```json
// POST /api/auth/login
{ "email": "admin@local.dev", "password": "Admin123!" }

// POST /api/products
{ "sku": "TOR-001", "name": "Tornillo 1/4", "cost": 6, "price": 10, "stock": 0 }

// POST /api/partners
{ "kind": "supplier", "name": "Ferretería Sur", "email": "ventas@sur.com", "phone": "9611234567" }

// POST /api/purchases (partnerId = proveedor) | POST /api/sales (partnerId = cliente)
// unitPrice es precio NETO: el IVA 16% se calcula por línea en el servidor
{ "partnerId": 1, "items": [ { "productId": 1, "quantity": 50, "unitPrice": 6 } ] }

// POST /api/sales/1/payments
{ "amount": 100, "method": "transfer", "note": "Anticipo" }

// POST /api/quotes
{ "partnerId": 1, "items": [ { "productId": 1, "quantity": 10, "unitPrice": 6 } ], "note": "Propuesta" }

// PATCH /api/quotes/1/status
{ "status": "sent" }
```

Los ids dependen de tu base: consúltalos con `GET /api/partners?kind=...` y `GET /api/products`.

Códigos de error: `400` regla de negocio o validación, `401` sin sesión, `403` sin permiso, `404` recurso inexistente, `409` valor único repetido (SKU/correo), `429` límite de intentos de login, `500` error interno.

## Reglas de negocio

### En la base de datos (`backend/migrations/*.sql`)
- `sku` único y obligatorio; correo de usuario único.
- `price`, `cost` y `stock` no pueden ser negativos; `quantity > 0` y `unit_price >= 0` en cada línea.
- El tipo de tercero solo puede ser `customer` o `supplier`; el de orden, `purchase` o `sale`.
- Toda orden pertenece a un tercero existente; toda línea apunta a un producto existente.
- Al borrar una orden se borran sus líneas y pagos (`ON DELETE CASCADE`).
- Pagos: `amount > 0`, método `cash | transfer | card`.
- Cotizaciones: estado restringido a `draft, sent, accepted, rejected, expired, converted`.

Las migraciones son versionadas (`001_…`, `002_…`, …), se aplican en orden con transacción por archivo y quedan registradas en `schema_migrations`. Repetir `npm run db:migrate` es seguro (idempotente).

### En el dominio (`domain/`)
- Producto: SKU y nombre obligatorios; precio y costo numéricos no negativos; stock entero no negativo.
- Tercero: tipo válido y nombre obligatorio.
- Orden/cotización: requiere tercero y al menos una línea; cantidad entera mayor a 0; precio unitario no negativo.
- **IVA 16% (`domain/tax.js`):** el precio unitario es **neto**; el impuesto se calcula y redondea **por línea**, de modo que `total = subtotal + tax` siempre cuadra con la suma de líneas.
- Pago (`domain/payment.js`): monto > 0 y método válido. El exceso contra el saldo se valida en el caso de uso (necesita leer la orden).
- Cotización (`domain/quote.js`): máquina de estados `draft → sent → (accepted | rejected | expired) → converted`; los estados terminales no tienen salida. La caducidad es **perezosa**: una `sent` con `expires_at` vencido se muestra y valida como `Vencida` sin necesidad de cron.

### En los casos de uso (`application/useCases.js`)
- Una venta solo puede hacerse a un **cliente**; una compra, solo a un **proveedor**; una cotización, solo a un **cliente**.
- Una compra **suma** al stock; una venta lo **resta**; cotizar **no reserva** stock.
- Una venta se rechaza si no hay stock suficiente.
- Orden, líneas y movimiento de inventario se guardan en **una sola transacción** (todo o nada).
- El producto se bloquea (`FOR UPDATE`) durante el registro para evitar que dos ventas simultáneas vendan el mismo stock.
- **Pagos:** el saldo nunca se almacena (`total − SUM(payments)`); la orden se bloquea con `FOR UPDATE` para que dos cobros simultáneos no sobrepasen el saldo, y no se admite sobrepago.
- **Conversión de cotización:** marca `convertida` y crea la venta en **una sola transacción**; si falta stock, falla entero y la cotización queda `aceptada` (reintentable).
- **Login:** contraseña con `scrypt` (sin dependencias nativas), sesión en tabla `sessions` + cookie httpOnly, rate-limit de intentos (10 cada 15 min por IP+correo).

### Resumen financiero
- Balance = ventas − compras.
- Por cobrar / por pagar = suma de los saldos abiertos de ventas / compras.
- Valor del inventario = suma de stock × costo.
- Stock bajo = productos con 5 unidades o menos.
- El dashboard (`GET /api/reports/dashboard`) sirve en una sola petición la serie
  mensual continua (meses vacíos en 0), rankings de productos/clientes y las
  distribuciones de cobros y cotizaciones; `?months` se sanea a 3–24 en el caso
  de uso. Las gráficas del frontend usan Chart.js y se destruyen al navegar.

### Limitaciones actuales
- No hay devoluciones, múltiples almacenes, lotes ni caducidades.
- No hay bitácora (audit log) ni reportes avanzados.
- No se pueden cancelar órdenes ni editar/borrar productos.
- Un producto que aparece en alguna orden no puede borrarse (llave foránea).
- Las cotizaciones no se pueden editar una vez enviadas (habría que crear un borrador nuevo).

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
| `Cannot find native binding` (rolldown/lightningcss) en `vite` | Un `npm install` en `frontend/` desde un sistema borra los binarios nativos del otro (bug de dependencias opcionales). Restáuralos sin tocar el lockfile: desde WSL `npm i --no-save @rolldown/binding-linux-x64-gnu@1.2.13 lightningcss-linux-x64-gnu@1.33.0`; desde Windows `npm i --no-save @rolldown/binding-win32-x64-msvc@1.2.13 lightningcss-win32-x64-msvc@1.33.0`. Ambos pueden convivir en `node_modules`. |
| Cambié el backend y `node --watch` no recarga | En WSL, `--watch` no detecta cambios en `/mnt/c` (inotify no alcanza el montaje de Windows). Reinicia el backend a mano (Ctrl+C y otra vez `npm run dev`); vite sí recarga el frontend sin problema. |
