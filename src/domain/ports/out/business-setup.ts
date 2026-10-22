/** Lo que hace falta para abrir un negocio. */
export interface NewBusiness {
  readonly businessName: string;
  readonly owner: {
    /** El `sub` del token verificado: con el la persona vuelve a entrar. */
    readonly authUserId: string;
    readonly email: string | null;
    readonly fullName: string;
  };
}

export interface CreatedBusiness {
  readonly businessId: string;
  readonly userId: string;
}

/**
 * Puerto de salida: abrir un negocio nuevo. No cabe en una unidad de trabajo porque el negocio todavia no existe: el
 * adaptador le da identificador, y en una sola transaccion crea el negocio, su primera sucursal («Principal»), su
 * primera bodega y a la persona que lo abre, como duena. Si algo falla no queda nada.
 *
 * Lanza `AlreadyMemberError` si la persona ya pertenece a un negocio.
 */
export interface BusinessSetup {
  createBusiness(business: NewBusiness): Promise<CreatedBusiness>;
}
