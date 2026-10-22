import { DatabaseNotConfiguredError } from '../../../domain/model/database-not-configured-error.js';
import {
  BarcodeTakenError,
  CategoryInUseError,
  CategoryNameTakenError,
  CategoryNotFoundError,
  ProductNotFoundError,
  SkuTakenError,
  UnitLockedError,
} from '../../../domain/model/catalog-errors.js';
import { DeviceIdReusedError, DeviceNotFoundError } from '../../../domain/model/device-errors.js';
import {
  OperationIdReusedError,
  PurchaseNotFoundError,
  SupplierInUseError,
  SupplierNotFoundError,
} from '../../../domain/model/purchase-errors.js';
import {
  AlreadyMemberError,
  ForbiddenError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationNotPendingError,
  LastOwnerError,
  NoMembershipError,
  PersonNotFoundError,
} from '../../../domain/model/people-errors.js';
import { SaleNotFoundError, SaleVoidedError } from '../../../domain/model/sale-errors.js';
import {
  ShiftAlreadyOpenError,
  ShiftClosedError,
  ShiftIdReusedError,
  ShiftNotFoundError,
  ShiftRequiredError,
} from '../../../domain/model/shift-errors.js';
import { ValidationFailedError } from '../../../domain/model/validation.js';
import { AuthenticationError, UserInactiveError } from '../../../domain/ports/in/authenticate.js';
import { ApiProblem } from './api-problem.js';

/** El mismo texto para todo token rechazado: decir por que ensenaria a falsificar uno. */
const INVALID_TOKEN = 'El token no es válido. Inicia sesión de nuevo.';

/** Segundos que se le sugiere esperar al cliente cuando el servicio de identidad no responde. */
const IDENTITY_RETRY_SECONDS = 5;

/**
 * Traduce un error del DOMINIO a un error de la API. Se hace aqui, una sola vez, para que ningun endpoint tenga que
 * acordarse de hacerlo (ni de hacerlo igual). Devuelve `undefined` si el error no es uno de los conocidos.
 */
export function problemOfDomainError(error: unknown): ApiProblem | undefined {
  if (error instanceof AuthenticationError) {
    switch (error.reason) {
      case 'missing':
      case 'scheme':
        return new ApiProblem(401, 'unauthenticated', 'Hace falta iniciar sesión.', {
          headers: { 'WWW-Authenticate': 'Bearer' },
        });
      case 'expired':
        return new ApiProblem(
          401,
          'token-expired',
          'La sesión venció. Renuévala o inicia sesión.',
          {
            headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
          },
        );
      case 'unavailable':
        return new ApiProblem(
          503,
          'identity-unavailable',
          'No se pudo comprobar la sesión. Intenta de nuevo en unos segundos.',
          {
            retryAfterSeconds: IDENTITY_RETRY_SECONDS,
          },
        );
      case 'not-configured':
        return new ApiProblem(
          503,
          'identity-not-configured',
          'El servicio de identidad no está configurado.',
        );
      default:
        return new ApiProblem(401, 'invalid-token', INVALID_TOKEN, {
          headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
        });
    }
  }
  if (error instanceof UserInactiveError) {
    return new ApiProblem(
      403,
      'user-inactive',
      'La persona fue dada de baja y ya no tiene acceso.',
    );
  }
  if (error instanceof DatabaseNotConfiguredError) {
    return new ApiProblem(503, 'database-not-configured', 'La base de datos no está configurada.');
  }
  return (
    problemOfPeopleError(error) ??
    problemOfCatalogError(error) ??
    problemOfPurchasingError(error) ??
    problemOfDeviceError(error) ??
    problemOfShiftError(error) ??
    problemOfSaleError(error)
  );
}

/** Los errores de negocio y personas (ADR 0023). */
function problemOfPeopleError(error: unknown): ApiProblem | undefined {
  if (error instanceof ValidationFailedError) {
    return new ApiProblem(
      400,
      'validation-failed',
      'La petición trae datos que no sirven. Revisa los campos indicados.',
      { errors: error.errors.map((item) => ({ ...item })) },
    );
  }
  if (error instanceof AlreadyMemberError) {
    return new ApiProblem(409, 'already-member', 'La persona ya trabaja en un negocio.');
  }
  if (error instanceof NoMembershipError) {
    return new ApiProblem(403, 'no-membership', 'Primero crea un negocio o canjea una invitación.');
  }
  // El motivo (rol, baja...) es para el registro: al cliente se le dice una sola cosa.
  if (error instanceof ForbiddenError) {
    return new ApiProblem(403, 'forbidden', 'Tu rol no permite hacer esto.');
  }
  if (error instanceof PersonNotFoundError) {
    return new ApiProblem(404, 'person-not-found', 'No existe esa persona en este negocio.');
  }
  if (error instanceof LastOwnerError) {
    return new ApiProblem(409, 'last-owner', 'El negocio no puede quedarse sin un dueño activo.');
  }
  if (error instanceof InvitationNotFoundError) {
    return new ApiProblem(
      404,
      'invitation-not-found',
      'No hay una invitación pendiente con ese código.',
    );
  }
  if (error instanceof InvitationExpiredError) {
    return new ApiProblem(
      410,
      'invitation-expired',
      'La invitación venció. Pide un código nuevo a quien te invitó.',
    );
  }
  if (error instanceof InvitationNotPendingError) {
    return new ApiProblem(
      409,
      'invitation-not-pending',
      'Esa persona no tiene una invitación pendiente que renovar.',
    );
  }
  return undefined;
}

/** Los errores del catalogo (ADR 0015). */
function problemOfCatalogError(error: unknown): ApiProblem | undefined {
  if (error instanceof CategoryNotFoundError) {
    return new ApiProblem(404, 'category-not-found', 'No existe esa categoría en este negocio.');
  }
  if (error instanceof ProductNotFoundError) {
    return new ApiProblem(404, 'product-not-found', 'No existe ese producto en este negocio.');
  }
  if (error instanceof CategoryNameTakenError) {
    return new ApiProblem(409, 'category-name-taken', 'Ya hay una categoría con ese nombre.');
  }
  if (error instanceof CategoryInUseError) {
    return new ApiProblem(
      409,
      'category-in-use',
      'La categoría todavía tiene productos. Muévelos o archívalos antes de borrarla.',
    );
  }
  if (error instanceof SkuTakenError) {
    return new ApiProblem(409, 'sku-taken', 'Ya hay un producto con ese SKU.');
  }
  if (error instanceof BarcodeTakenError) {
    return new ApiProblem(409, 'barcode-taken', 'Ya hay un producto con ese código de barras.');
  }
  if (error instanceof UnitLockedError) {
    return new ApiProblem(
      409,
      'unit-locked',
      'La unidad no cambia cuando el producto ya tiene movimientos de existencias.',
    );
  }
  return undefined;
}

/** Los errores de proveedores y compras (C2-06, ADR 0019). */
function problemOfPurchasingError(error: unknown): ApiProblem | undefined {
  if (error instanceof SupplierNotFoundError) {
    return new ApiProblem(404, 'supplier-not-found', 'No existe ese proveedor en este negocio.');
  }
  if (error instanceof PurchaseNotFoundError) {
    return new ApiProblem(404, 'purchase-not-found', 'No existe esa compra en este negocio.');
  }
  if (error instanceof SupplierInUseError) {
    return new ApiProblem(
      409,
      'supplier-in-use',
      'El proveedor ya tiene compras y no se puede borrar. Cámbiale el nombre si hace falta.',
    );
  }
  if (error instanceof OperationIdReusedError) {
    return new ApiProblem(
      409,
      'operation-id-reused',
      'Ese identificador de operación ya se usó con otros datos. Genera uno nuevo para una compra distinta.',
    );
  }
  return undefined;
}

/** Los errores de los dispositivos (C3-01, ADR 0016). */
function problemOfDeviceError(error: unknown): ApiProblem | undefined {
  if (error instanceof DeviceNotFoundError) {
    return new ApiProblem(404, 'device-not-found', 'No existe ese dispositivo en este negocio.');
  }
  if (error instanceof DeviceIdReusedError) {
    return new ApiProblem(
      409,
      'device-id-reused',
      'Ese identificador de dispositivo ya se registró con otros datos. Genera uno nuevo para un dispositivo distinto.',
    );
  }
  return undefined;
}

/** Los errores de las ventas (C3-04, ADR 0027). */
function problemOfSaleError(error: unknown): ApiProblem | undefined {
  if (error instanceof SaleNotFoundError) {
    return new ApiProblem(404, 'sale-not-found', 'No existe esa venta en este negocio.');
  }
  if (error instanceof SaleVoidedError) {
    return new ApiProblem(409, 'sale-voided', 'Esa venta ya está anulada.');
  }
  return undefined;
}

/** Los errores de los turnos de caja (C3-02, ADR 0026). */
function problemOfShiftError(error: unknown): ApiProblem | undefined {
  if (error instanceof ShiftNotFoundError) {
    return new ApiProblem(404, 'shift-not-found', 'No existe ese turno en este negocio.');
  }
  if (error instanceof ShiftAlreadyOpenError) {
    return new ApiProblem(
      409,
      'shift-already-open',
      'Ya tienes un turno abierto en este dispositivo. Ciérralo antes de abrir otro.',
    );
  }
  if (error instanceof ShiftIdReusedError) {
    return new ApiProblem(
      409,
      'shift-id-reused',
      'Ese identificador de turno ya es de otro turno. Genera uno nuevo para un turno distinto.',
    );
  }
  if (error instanceof ShiftRequiredError) {
    return new ApiProblem(
      409,
      'shift-required',
      'Para devolver el efectivo hace falta un turno tuyo que esté abierto.',
    );
  }
  if (error instanceof ShiftClosedError) {
    return new ApiProblem(
      409,
      'shift-closed',
      'El turno ya está cerrado: su arqueo ya se hizo y no se cambia.',
    );
  }
  return undefined;
}
