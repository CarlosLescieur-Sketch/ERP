/**
 * PUERTOS DE SALIDA (lo que la aplicación necesita del mundo exterior).
 * El dominio y los casos de uso solo conocen estos contratos; las implementaciones
 * viven en adapters/out (hoy PostgreSQL, mañana podría ser otra cosa).
 *
 * @typedef {Object} ProductRepository
 * @property {(opts?:{archived?:boolean}) => Promise<Object[]>} findAll  activos por defecto
 * @property {(id:number, opts?:{lock?:boolean}) => Promise<Object|null>} findById
 * @property {(product:Object) => Promise<Object>} save
 * @property {(product:Object) => Promise<Object|null>} update  null si el id no existe
 * @property {(id:number) => Promise<void>} remove
 * @property {(id:number, archived:boolean) => Promise<Object|null>} setArchived
 * @property {(id:number) => Promise<boolean>} inUse  ¿está en órdenes o cotizaciones?
 * @property {(id:number, delta:number) => Promise<void>} adjustStock
 *
 * @typedef {Object} PartnerRepository
 * @property {(kind?:string, opts?:{archived?:boolean}) => Promise<Object[]>} findAll  activos por defecto
 * @property {(id:number) => Promise<Object|null>} findById
 * @property {(partner:Object) => Promise<Object>} save
 * @property {(partner:Object) => Promise<Object|null>} update  null si el id no existe
 * @property {(id:number) => Promise<void>} remove
 * @property {(id:number, archived:boolean) => Promise<Object|null>} setArchived
 * @property {(id:number) => Promise<boolean>} inUse  ¿está en órdenes o cotizaciones?
 *
 * @typedef {Object} OrderRepository
 * @property {(kind?:string) => Promise<Object[]>} findAll
 * @property {(id:number, opts?:{lock?:boolean}) => Promise<Object|null>} findById
 * @property {(order:Object) => Promise<Object>} save
 * @property {(id:number) => Promise<Object[]>} findItems  líneas para revertir stock
 * @property {(order:Object) => Promise<Object|null>} update  cabecera (partner/totales)
 * @property {(orderId:number, items:Object[]) => Promise<void>} replaceItems  borra e inserta
 * @property {(id:number) => Promise<void>} remove  cascada: líneas y pagos
 * @property {(id:number) => Promise<Object|null>} findPayment
 * @property {(id:number, payment:Object) => Promise<Object|null>} updatePayment
 * @property {(id:number) => Promise<void>} removePayment
 *
 * @typedef {Object} QuoteRepository
 * @property {(status?:string) => Promise<Object[]>} findAll
 * @property {(id:number, opts?:{lock?:boolean}) => Promise<Object|null>} findById
 * @property {(quote:Object) => Promise<Object>} save
 * @property {(quote:Object) => Promise<Object|null>} update  cabecera + líneas (borrador)
 * @property {(id:number) => Promise<void>} remove  cascada: quote_items
 *
 * @typedef {Object} ReportReader
 * @property {() => Promise<Object>} summary
 * @property {(months:number) => Promise<Object>} dashboard  → serie mensual + rankings + distribuciones
 *
 * @typedef {Object} TransactionManager
 * @property {(work:(repos:{products:ProductRepository,partners:PartnerRepository,orders:OrderRepository,quotes:QuoteRepository})=>Promise<any>) => Promise<any>} run
 *
 * @typedef {Object} UserRepository
 * @property {() => Promise<Object[]>} findAll
 * @property {(email:string) => Promise<Object|null>} findByEmail
 * @property {(id:number) => Promise<Object|null>} findById
 * @property {(user:Object) => Promise<Object>} save
 * @property {(user:Object) => Promise<Object>} update
 * @property {(id:number) => Promise<void>} remove  cascada: sesiones
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
