import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MAX_PAGE_SIZE, type Page } from '../../../domain/model/pagination.js';
import type { Session } from '../../../domain/ports/in/authenticate.js';
import type {
  PurchaseSummaryView,
  PurchaseView,
  Purchases,
  SupplierView,
  Suppliers,
  WarehouseView,
  Warehouses,
} from '../../../domain/ports/in/purchasing.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import {
  CreatePurchaseRequestDto,
  PurchaseDto,
  PurchasePageDto,
  SupplierDto,
  SupplierPageDto,
  SupplierRequestDto,
  WarehouseDto,
} from './purchasing.dto.js';
import { PURCHASES, SUPPLIERS, WAREHOUSE } from './tokens.js';

const LIMIT = {
  name: 'limit',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 50 },
} as const;

const CURSOR = {
  name: 'cursor',
  required: false,
  schema: { type: 'string' },
  description: 'El `nextCursor` de la página anterior, tal cual.',
} as const;

/** El encabezado con que se avisa que la respuesta es de una operacion que ya se habia aplicado (ADR 0019). */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** Lo poco que se usa de la respuesta de Express: el estado y los encabezados, para que `Res` no ate el adaptador a su tipo. */
interface ResponseWithStatus {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/** Adaptador de entrada HTTP: los proveedores (C2-06). */
@ApiTags('purchasing')
@ApiBearerAuth()
@Controller('v1/suppliers')
@UseGuards(BearerAuthGuard)
export class SuppliersController {
  constructor(@Inject(SUPPLIERS) private readonly suppliers: Suppliers) {}

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Los proveedores del negocio',
    description:
      'Ordenados por nombre. Es de la gerencia (`purchase:create`). Pagina por cursor (ADR 0019).',
  })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiOkResponse({ type: SupplierPageDto })
  list(@CurrentSession() session: Session, @Query() query: unknown): Promise<Page<SupplierView>> {
    return this.suppliers.list(session, query);
  }

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Crear un proveedor',
    description: 'Es de la gerencia (`purchase:create`). Solo lleva nombre y un contacto opcional.',
  })
  @ApiBody({ type: SupplierRequestDto })
  @ApiCreatedResponse({ type: SupplierDto })
  create(@CurrentSession() session: Session, @Body() body: unknown): Promise<SupplierView> {
    return this.suppliers.create(session, body);
  }

  @Patch(':supplierId')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Cambiar un proveedor',
    description:
      'Es de la gerencia (`purchase:create`). Al menos un campo; `contact: null` lo borra.',
  })
  @ApiParam({ name: 'supplierId', type: String, format: 'uuid' })
  @ApiBody({ type: SupplierRequestDto })
  @ApiOkResponse({ type: SupplierDto })
  update(
    @CurrentSession() session: Session,
    @Param('supplierId') supplierId: string,
    @Body() body: unknown,
  ): Promise<SupplierView> {
    return this.suppliers.update(session, supplierId, body);
  }

  @Delete(':supplierId')
  @HttpCode(204)
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Borrar un proveedor',
    description:
      'Es de la gerencia (`purchase:create`). Responde 409 `supplier-in-use` si ya tiene compras: son historia y no se tocan.',
  })
  @ApiParam({ name: 'supplierId', type: String, format: 'uuid' })
  @ApiNoContentResponse({ description: 'El proveedor se borró.' })
  async remove(
    @CurrentSession() session: Session,
    @Param('supplierId') supplierId: string,
  ): Promise<void> {
    await this.suppliers.remove(session, supplierId);
  }
}

/** Adaptador de entrada HTTP: las compras (C2-06, ADR 0013 y 0019). */
@ApiTags('purchasing')
@ApiBearerAuth()
@Controller('v1/purchases')
@UseGuards(BearerAuthGuard)
export class PurchasesController {
  constructor(@Inject(PURCHASES) private readonly purchases: Purchases) {}

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Registrar una compra',
    description:
      'Es de la gerencia (`purchase:create`). La compra, sus líneas y la entrada de existencias se guardan juntas o no se guarda nada. Es idempotente por `operationId` (ADR 0019): la primera vez responde 201; repetirla con los mismos datos responde 200 con la misma compra y `Idempotent-Replayed: true`, sin sumar otra vez; con otros datos, 409 `operation-id-reused`. Los problemas de los campos salen juntos en 400 `validation-failed`, con el puntero de cada línea (`/lines/1/productId`).',
  })
  @ApiBody({ type: CreatePurchaseRequestDto })
  @ApiCreatedResponse({ type: PurchaseDto })
  @ApiResponse({
    status: 200,
    description: 'La compra ya se había registrado con este `operationId`: es la misma de antes.',
    type: PurchaseDto,
    headers: {
      [IDEMPOTENT_REPLAYED_HEADER]: {
        description: 'Siempre `true` en esta respuesta.',
        schema: { type: 'string', enum: ['true'] },
      },
    },
  })
  async create(
    @CurrentSession() session: Session,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseWithStatus,
  ): Promise<PurchaseView> {
    const { purchase, replayed } = await this.purchases.create(session, body);
    if (replayed) {
      response.status(200);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return purchase;
  }

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Las compras del negocio',
    description:
      'De la más nueva a la más vieja, sin las líneas pero con cuántas tiene cada una (`lineCount`). Es de la gerencia (`purchase:create`). Pagina por cursor (ADR 0019).',
  })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiOkResponse({ type: PurchasePageDto })
  list(
    @CurrentSession() session: Session,
    @Query() query: unknown,
  ): Promise<Page<PurchaseSummaryView>> {
    return this.purchases.list(session, query);
  }

  @Get(':purchaseId')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Una compra con sus líneas',
    description: 'Es de la gerencia (`purchase:create`).',
  })
  @ApiParam({ name: 'purchaseId', type: String, format: 'uuid' })
  @ApiOkResponse({ type: PurchaseDto })
  get(
    @CurrentSession() session: Session,
    @Param('purchaseId') purchaseId: string,
  ): Promise<PurchaseView> {
    return this.purchases.get(session, purchaseId);
  }
}

/** Adaptador de entrada HTTP: la bodega del negocio (C2-06). */
@ApiTags('purchasing')
@ApiBearerAuth()
@Controller('v1/warehouse')
@UseGuards(BearerAuthGuard)
export class WarehouseController {
  constructor(@Inject(WAREHOUSE) private readonly warehouse: Warehouses) {}

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'La bodega del negocio',
    description: 'En v2 hay una sola, creada junto con el negocio. La ven los tres roles.',
  })
  @ApiOkResponse({ type: WarehouseDto })
  get(@CurrentSession() session: Session): Promise<WarehouseView> {
    return this.warehouse.get(session);
  }
}
