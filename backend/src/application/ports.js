/**
 * PUERTOS DE SALIDA (lo que la aplicación necesita del mundo exterior).
 * El dominio y los casos de uso solo conocen estos contratos; las implementaciones
 * viven en adapters/out (hoy PostgreSQL, mañana podría ser otra cosa).
 *
 * @typedef {Object} ProductRepository
 * @property {() => Promise<Object[]>} findAll
 * @property {(id:number, opts?:{lock?:boolean}) => Promise<Object|null>} findById
 * @property {(product:Object) => Promise<Object>} save
 * @property {(id:number, delta:number) => Promise<void>} adjustStock
 *
 * @typedef {Object} PartnerRepository
 * @property {(kind?:string) => Promise<Object[]>} findAll
 * @property {(id:number) => Promise<Object|null>} findById
 * @property {(partner:Object) => Promise<Object>} save
 *
 * @typedef {Object} OrderRepository
 * @property {(kind?:string) => Promise<Object[]>} findAll
 * @property {(order:Object) => Promise<Object>} save
 *
 * @typedef {Object} ReportReader
 * @property {() => Promise<Object>} summary
 * @property {(months:number) => Promise<Object>} dashboard  → serie mensual + rankings + distribuciones
 *
 * @typedef {Object} TransactionManager
 * @property {(work:(repos:{products:ProductRepository,partners:PartnerRepository,orders:OrderRepository})=>Promise<any>) => Promise<any>} run
 *
 * @typedef {Object} UserRepository
 * @property {() => Promise<Object[]>} findAll
 * @property {(email:string) => Promise<Object|null>} findByEmail
 * @property {(id:number) => Promise<Object|null>} findById
 * @property {(user:Object) => Promise<Object>} save
 * @property {(user:Object) => Promise<Object>} update
 *
 * @typedef {Object} SessionRepository
 * @property {(userId:number, ttlDays:number) => Promise<string>} create  → token
 * @property {(token:string) => Promise<Object|null>} findByToken  → usuario dueño o null
 * @property {(token:string) => Promise<void>} delete
 * @property {() => Promise<void>} deleteExpired
 *
 * @typedef {Object} PasswordHasher
 * @property {(plain:string) => Promise<string>} hash
 * @property {(plain:string, stored:string) => Promise<boolean>} verify
 */
export {};
