export class DomainError extends Error {}
export class NotFoundError extends Error {}
// 401: sin sesión o credenciales inválidas.
export class UnauthorizedError extends Error {}
// 403: sesión válida pero sin permiso para la acción.
export class ForbiddenError extends Error {}
