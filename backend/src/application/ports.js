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
 *
 * @typedef {Object} TransactionManager
 * @property {(work:(repos:{products:ProductRepository,partners:PartnerRepository,orders:OrderRepository})=>Promise<any>) => Promise<any>} run
 */
export {};
