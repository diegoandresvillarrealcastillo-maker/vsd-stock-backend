/** Los tres papeles de una persona en un negocio (ADR 0017), de mayor a menor responsabilidad. */
export const ROLES = ['owner', 'admin', 'cashier'] as const;

export type Role = (typeof ROLES)[number];

const EVERYONE = ['owner', 'admin', 'cashier'] as const;
const MANAGEMENT = ['owner', 'admin'] as const;
const OWNER_ONLY = ['owner'] as const;

/**
 * Lo que cada rol puede hacer y si se puede hacer sin conexion (ADR 0017). Es la UNICA fuente: la interfaz, la
 * API y el documento `docs/dominio/permisos.md` salen de aqui o se comparan con esto, y una prueba lo vigila.
 *
 * `offline` lo decidio el dueno del proyecto: el trabajo del mostrador (vender, cobrar en efectivo, el turno y
 * consultar lo que hay en la copia local) funciona sin red; la administracion, el catalogo, los precios, los
 * usuarios y los reportes necesitan conexion. Toda accion disponible sin conexion esta abierta a los tres roles,
 * para que un cambio de rol hecho mientras un dispositivo estaba sin red no pueda bloquear una venta ya hecha.
 */
export const ACTIONS = {
  // ---------- Mostrador ----------
  'sale:create': { roles: EVERYONE, offline: true },
  'payment:collect-cash': { roles: EVERYONE, offline: true },
  'shift:open': { roles: EVERYONE, offline: true },
  'shift:close': { roles: EVERYONE, offline: true },
  'sale:view-own-shift': { roles: EVERYONE, offline: true },
  'stock:view': { roles: EVERYONE, offline: true },
  'product:view': { roles: EVERYONE, offline: true },
  // ---------- Administracion del dia a dia ----------
  'shift:close-other': { roles: MANAGEMENT, offline: false },
  'sale:view-all': { roles: MANAGEMENT, offline: false },
  'sale:void': { roles: MANAGEMENT, offline: false },
  'stock:adjust': { roles: MANAGEMENT, offline: false },
  'purchase:create': { roles: MANAGEMENT, offline: false },
  'cash-movement:create': { roles: MANAGEMENT, offline: false },
  // ---------- Catalogo y precios ----------
  'product:manage': { roles: MANAGEMENT, offline: false },
  'price:update': { roles: MANAGEMENT, offline: false },
  // ---------- Reportes ----------
  'report:sales': { roles: MANAGEMENT, offline: false },
  'report:stock': { roles: MANAGEMENT, offline: false },
  'report:profit': { roles: MANAGEMENT, offline: false },
  // ---------- Personas, dispositivos y negocio ----------
  'user:manage-cashiers': { roles: MANAGEMENT, offline: false },
  'user:manage-admins': { roles: OWNER_ONLY, offline: false },
  'business:settings': { roles: OWNER_ONLY, offline: false },
  'device:enroll': { roles: EVERYONE, offline: false },
  'device:revoke': { roles: MANAGEMENT, offline: false },
} as const;

export type Action = keyof typeof ACTIONS;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isAction(value: unknown): value is Action {
  // hasOwn y no `in`: «toString» no es una accion.
  return typeof value === 'string' && Object.hasOwn(ACTIONS, value);
}

/** Si el rol puede hacer la accion. Todo lo que no se conoce se niega. */
export function can(role: Role, action: Action): boolean {
  // Un rol desconocido simplemente no esta en la lista de ninguna accion.
  if (!isAction(action)) return false;
  return (ACTIONS[action].roles as readonly string[]).includes(role);
}

/** Si la accion se puede hacer con el dispositivo sin conexion. Una accion desconocida no. */
export function isAvailableOffline(action: Action): boolean {
  return isAction(action) && ACTIONS[action].offline;
}

/** Las acciones que el rol puede hacer, en el orden de la tabla. */
export function actionsOf(role: Role): Action[] {
  return (Object.keys(ACTIONS) as Action[]).filter((action) => can(role, action));
}
