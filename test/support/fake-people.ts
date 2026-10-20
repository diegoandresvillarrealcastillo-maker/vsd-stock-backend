import type { PersonChange } from '../../src/domain/model/user-administration.js';
import type {
  NewInvitation,
  PeopleRepository,
  PersonRecord,
} from '../../src/domain/ports/out/people.js';
import type { CatalogRepository } from '../../src/domain/ports/out/catalog.js';
import type { BusinessScope, UnitOfWork } from '../../src/domain/ports/out/unit-of-work.js';
import { FakeCatalog } from './fake-catalog.js';
import { FakeDevices } from './fake-devices.js';
import { FakePurchasing } from './fake-purchasing.js';

/** El orden en que la base lista a las personas: por nombre y luego por id. */
const byNameThenId = (a: PersonRecord, b: PersonRecord): number =>
  a.fullName < b.fullName
    ? -1
    : a.fullName > b.fullName
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

/** Las personas de un negocio, en memoria. Hace lo mismo que el adaptador de Prisma, sin base. */
export class FakePeople implements PeopleRepository {
  readonly records: PersonRecord[];
  /** Lo unico que se guarda de cada invitacion pendiente: el hash, por id. */
  readonly hashes = new Map<string, string>();
  /** Cuantas veces se pidio el candado de los duenos. */
  ownerLocks = 0;
  private counter = 0;

  constructor(records: readonly PersonRecord[] = []) {
    this.records = [...records];
  }

  list(request: { limit: number; after?: readonly [string, string] }): Promise<PersonRecord[]> {
    const sorted = [...this.records].sort(byNameThenId);
    const rest = request.after
      ? sorted.filter(
          (person) =>
            person.fullName > request.after![0] ||
            (person.fullName === request.after![0] && person.id > request.after![1]),
        )
      : sorted;
    return Promise.resolve(rest.slice(0, request.limit));
  }

  find(id: string): Promise<PersonRecord | null> {
    return Promise.resolve(this.records.find((person) => person.id === id) ?? null);
  }

  lockActiveOwners(): Promise<string[]> {
    this.ownerLocks += 1;
    return Promise.resolve(
      this.records
        .filter((person) => person.role === 'owner' && person.active)
        .map((person) => person.id)
        .sort(),
    );
  }

  invite(invitation: NewInvitation): Promise<PersonRecord> {
    this.counter += 1;
    const person: PersonRecord = {
      id: `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`,
      fullName: invitation.fullName,
      email: invitation.email,
      role: invitation.role,
      active: true,
      bound: false,
      invitationExpiresAt: invitation.invitationExpiresAt,
      createdAt: new Date('2026-10-17T12:00:00.000Z'),
    };
    this.records.push(person);
    this.hashes.set(person.id, invitation.invitationHash);
    return Promise.resolve(person);
  }

  rotateInvitation(
    id: string,
    invitationHash: string,
    invitationExpiresAt: Date,
  ): Promise<PersonRecord | null> {
    const index = this.records.findIndex((person) => person.id === id);
    const current = this.records[index];
    if (current === undefined || current.bound || !current.active) return Promise.resolve(null);
    const rotated = { ...current, invitationExpiresAt };
    this.records[index] = rotated;
    this.hashes.set(id, invitationHash);
    return Promise.resolve(rotated);
  }

  update(id: string, change: PersonChange): Promise<PersonRecord> {
    const index = this.records.findIndex((person) => person.id === id);
    const current = this.records[index];
    if (current === undefined) return Promise.reject(new Error(`No person ${id}`));
    const updated: PersonRecord = {
      ...current,
      fullName: change.fullName ?? current.fullName,
      role: change.role ?? current.role,
      active: change.active ?? current.active,
    };
    this.records[index] = updated;
    return Promise.resolve(updated);
  }
}

/** Una unidad de trabajo de mentira: anota para que negocio se abrio y entrega las personas de mentira. */
export function fakeUnitOfWork(
  people: PeopleRepository,
  businessName: string | null = 'Tienda La Esquina',
  catalog: CatalogRepository = new FakeCatalog(),
  purchasing: FakePurchasing = new FakePurchasing(),
  devices: FakeDevices = new FakeDevices(),
): UnitOfWork & { openedFor: string[] } {
  const openedFor: string[] = [];
  // El libro de existencias lista los productos del catalogo de mentira, si lo hay.
  if (purchasing.stock.catalog === undefined && catalog instanceof FakeCatalog) {
    purchasing.stock.catalog = catalog;
  }
  return {
    openedFor,
    inBusiness: (businessId, work) => {
      openedFor.push(businessId);
      const scope: BusinessScope = {
        businessId,
        business: {
          current: () =>
            Promise.resolve(businessName === null ? null : { id: businessId, name: businessName }),
        },
        people,
        catalog,
        suppliers: purchasing.suppliers,
        purchases: purchasing.purchases,
        stock: purchasing.stock,
        operations: purchasing.operations,
        devices,
      };
      return work(scope);
    },
  };
}

/** Una persona de mentira, con todo lo que no importa ya resuelto. */
export function person(overrides: Partial<PersonRecord> & Pick<PersonRecord, 'id'>): PersonRecord {
  return {
    fullName: 'Ana Gómez',
    email: null,
    role: 'cashier',
    active: true,
    bound: true,
    invitationExpiresAt: null,
    createdAt: new Date('2026-10-01T12:00:00.000Z'),
    ...overrides,
  };
}
