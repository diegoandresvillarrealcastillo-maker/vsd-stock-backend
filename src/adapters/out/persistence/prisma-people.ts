import { isRole } from '../../../domain/model/role.js';
import type { PersonChange } from '../../../domain/model/user-administration.js';
import type {
  NewInvitation,
  PeopleRepository,
  PersonRecord,
} from '../../../domain/ports/out/people.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

interface PersonRow {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly role: string;
  readonly active: boolean;
  readonly authUserId: string | null;
  readonly invitationExpiresAt: Date | null;
  readonly createdAt: Date;
}

const SELECT = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  active: true,
  authUserId: true,
  invitationExpiresAt: true,
  createdAt: true,
} as const;

function recordOf(row: PersonRow): PersonRecord {
  if (!isRole(row.role)) {
    // La base lo impide con una restriccion; si llegara aqui, mejor caer que dar un rol que no existe.
    throw new Error(`The person ${row.id} has a role that does not exist`);
  }
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    role: row.role,
    active: row.active,
    bound: row.authUserId !== null,
    invitationExpiresAt: row.invitationExpiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Las personas del negocio de la transaccion, sobre Prisma. La seguridad por fila de la base deja ver y escribir solo las
 * de ese negocio: aqui ninguna consulta nombra el negocio para filtrar.
 */
export class PrismaPeopleRepository implements PeopleRepository {
  constructor(
    private readonly tx: PrismaTransaction,
    private readonly businessId: string,
  ) {}

  async list(request: {
    limit: number;
    after?: readonly [string, string];
  }): Promise<PersonRecord[]> {
    const after = request.after;
    const rows = await this.tx.appUser.findMany({
      where:
        after === undefined
          ? {}
          : {
              // Por nombre y luego por id: la misma posicion que el cursor, que no cambia si alguien se suma.
              OR: [{ fullName: { gt: after[0] } }, { fullName: after[0], id: { gt: after[1] } }],
            },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: request.limit,
      select: SELECT,
    });
    return rows.map(recordOf);
  }

  async find(id: string): Promise<PersonRecord | null> {
    const row = await this.tx.appUser.findFirst({ where: { id }, select: SELECT });
    return row === null ? null : recordOf(row);
  }

  async lockActiveOwners(): Promise<string[]> {
    // Prisma no sabe pedir el candado; en orden de id para que dos transacciones lo tomen en el mismo orden.
    const rows = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM app_user WHERE role = 'owner' AND active ORDER BY id FOR UPDATE`;
    return rows.map((row) => row.id);
  }

  async invite(invitation: NewInvitation): Promise<PersonRecord> {
    const row = await this.tx.appUser.create({
      data: {
        idNegocio: this.businessId,
        fullName: invitation.fullName,
        email: invitation.email,
        role: invitation.role,
        invitationHash: invitation.invitationHash,
        invitationExpiresAt: invitation.invitationExpiresAt,
      },
      select: SELECT,
    });
    return recordOf(row);
  }

  async rotateInvitation(
    id: string,
    invitationHash: string,
    invitationExpiresAt: Date,
  ): Promise<PersonRecord | null> {
    const result = await this.tx.appUser.updateManyAndReturn({
      where: { id, authUserId: null, active: true },
      data: { invitationHash, invitationExpiresAt },
      select: SELECT,
    });
    const row = result[0];
    return row === undefined ? null : recordOf(row);
  }

  async update(id: string, change: PersonChange): Promise<PersonRecord> {
    const row = await this.tx.appUser.update({
      where: { id },
      data: {
        ...(change.fullName !== undefined ? { fullName: change.fullName } : {}),
        ...(change.role !== undefined ? { role: change.role } : {}),
        ...(change.active !== undefined
          ? { active: change.active, deactivatedAt: change.active ? null : new Date() }
          : {}),
      },
      select: SELECT,
    });
    return recordOf(row);
  }
}
