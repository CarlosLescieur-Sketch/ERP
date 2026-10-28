import { DomainError } from './errors.js';

export const ROLES = ['admin', 'vendedor', 'bodeguero'];

// Matriz de permisos por rol. La autorización se consulta con can(role, perm).
// Los permisos de escritura; la lectura de listados está abierta a cualquier
// usuario autenticado (todos los roles necesitan ver productos, ventas, etc.).
const PERMISSIONS = {
  admin: [
    'users:manage',      // crear/desactivar usuarios
    'products:write',    // crear productos
    'partners:write',    // crear clientes/proveedores
    'purchases:write',   // registrar compras
    'sales:write',       // registrar ventas
    'payments:write',    // registrar pagos (cobros y pagos)
    'quotes:write',      // crear/cambiar cotizaciones
  ],
  vendedor: ['partners:write', 'sales:write', 'payments:write', 'quotes:write'],
  bodeguero: ['partners:write', 'products:write', 'purchases:write', 'payments:write'],
};

export const can = (role, permission) => (PERMISSIONS[role] ?? []).includes(permission);

// La lista de permisos viaja al frontend en login/me: allí solo se usa para
// mostrar u ocultar botones; la autoridad sigue siendo el backend.
export const permissionsFor = (role) => [...(PERMISSIONS[role] ?? [])];

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mínimos de contraseña aceptables para una MIPYME.
export const PASSWORD_MIN = 8;
export function assertPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN)
    throw new DomainError(`La contraseña debe tener al menos ${PASSWORD_MIN} caracteres`);
}

export function buildUser({ email, name, role, active = true }) {
  const e = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new DomainError('El correo no tiene un formato válido');
  if (!name?.trim()) throw new DomainError('El nombre es obligatorio');
  if (!ROLES.includes(role)) throw new DomainError('Rol inválido (admin, vendedor o bodeguero)');
  return { email: e, name: name.trim(), role, active: active !== false };
}

// Lo que se expone fuera de la capa de aplicación (sin password_hash).
export const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt,
});
