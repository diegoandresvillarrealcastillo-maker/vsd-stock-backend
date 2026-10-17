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
  ApiTags,
} from '@nestjs/swagger';
import { MAX_PAGE_SIZE, type Page } from '../../../domain/model/pagination.js';
import type { Session } from '../../../domain/ports/in/authenticate.js';
import type {
  Categories,
  CategoryView,
  ProductView,
  Products,
} from '../../../domain/ports/in/catalog.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import {
  CategoryDto,
  CategoryPageDto,
  CategoryRequestDto,
  CreateProductRequestDto,
  ProductDto,
  ProductPageDto,
  UpdateProductRequestDto,
} from './catalog.dto.js';
import { CATEGORIES, PRODUCTS } from './tokens.js';

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

/** Adaptador de entrada HTTP: las categorias del catalogo (ADR 0015). */
@ApiTags('catalog')
@ApiBearerAuth()
@Controller('v1/categories')
@UseGuards(BearerAuthGuard)
export class CategoriesController {
  constructor(@Inject(CATEGORIES) private readonly categories: Categories) {}

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Las categorías del negocio',
    description: 'Ordenadas por nombre. Las ven los tres roles. Pagina por cursor (ADR 0019).',
  })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiOkResponse({ type: CategoryPageDto })
  list(@CurrentSession() session: Session, @Query() query: unknown): Promise<Page<CategoryView>> {
    return this.categories.list(session, query);
  }

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Crear una categoría',
    description:
      'Es de la gerencia (`product:manage`). El nombre es único en el negocio sin importar mayúsculas (409 `category-name-taken`).',
  })
  @ApiBody({ type: CategoryRequestDto })
  @ApiCreatedResponse({ type: CategoryDto })
  create(@CurrentSession() session: Session, @Body() body: unknown): Promise<CategoryView> {
    return this.categories.create(session, body);
  }

  @Patch(':categoryId')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Renombrar una categoría',
    description: 'Es de la gerencia (`product:manage`).',
  })
  @ApiParam({ name: 'categoryId', type: String, format: 'uuid' })
  @ApiBody({ type: CategoryRequestDto })
  @ApiOkResponse({ type: CategoryDto })
  rename(
    @CurrentSession() session: Session,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryView> {
    return this.categories.rename(session, categoryId, body);
  }

  @Delete(':categoryId')
  @HttpCode(204)
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Borrar una categoría',
    description:
      'Es de la gerencia (`product:manage`). Responde 409 `category-in-use` si todavía tiene productos: se mueven o se archivan antes.',
  })
  @ApiParam({ name: 'categoryId', type: String, format: 'uuid' })
  @ApiNoContentResponse({ description: 'La categoría se borró.' })
  async remove(
    @CurrentSession() session: Session,
    @Param('categoryId') categoryId: string,
  ): Promise<void> {
    await this.categories.remove(session, categoryId);
  }
}

/** Adaptador de entrada HTTP: los productos del catalogo (ADR 0015). */
@ApiTags('catalog')
@ApiBearerAuth()
@Controller('v1/products')
@UseGuards(BearerAuthGuard)
export class ProductsController {
  constructor(@Inject(PRODUCTS) private readonly products: Products) {}

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Los productos del negocio',
    description:
      'Ordenados por nombre. Los ven los tres roles. `search` busca una parte del nombre o del SKU sin importar mayúsculas, o un código de barras completo. Pagina por cursor (ADR 0019).',
  })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiQuery({ name: 'search', required: false, schema: { type: 'string', maxLength: 80 } })
  @ApiQuery({ name: 'categoryId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'active',
    required: false,
    schema: { type: 'string', enum: ['true', 'false'] },
    description: 'Sin este filtro se devuelven activos y archivados.',
  })
  @ApiOkResponse({ type: ProductPageDto })
  list(@CurrentSession() session: Session, @Query() query: unknown): Promise<Page<ProductView>> {
    return this.products.list(session, query);
  }

  @Get(':productId')
  @ApiProblemResponse()
  @ApiOperation({ summary: 'Un producto', description: 'Lo ven los tres roles.' })
  @ApiParam({ name: 'productId', type: String, format: 'uuid' })
  @ApiOkResponse({ type: ProductDto })
  get(
    @CurrentSession() session: Session,
    @Param('productId') productId: string,
  ): Promise<ProductView> {
    return this.products.get(session, productId);
  }

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Crear un producto',
    description:
      'Es de la gerencia (`product:manage`). Nace activo. Responde 409 `sku-taken` o `barcode-taken` si ya hay otro con ese código, y 400 `validation-failed` con todos los campos que no sirven.',
  })
  @ApiBody({ type: CreateProductRequestDto })
  @ApiCreatedResponse({ type: ProductDto })
  create(@CurrentSession() session: Session, @Body() body: unknown): Promise<ProductView> {
    return this.products.create(session, body);
  }

  @Patch(':productId')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Cambiar un producto',
    description:
      'Es de la gerencia (`product:manage`; cambiar el precio pide además `price:update`). Archivar es `active: false`: un producto con historia no se borra. La unidad no cambia si el producto ya tiene movimientos (409 `unit-locked`).',
  })
  @ApiParam({ name: 'productId', type: String, format: 'uuid' })
  @ApiBody({ type: UpdateProductRequestDto })
  @ApiOkResponse({ type: ProductDto })
  update(
    @CurrentSession() session: Session,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ): Promise<ProductView> {
    return this.products.update(session, productId, body);
  }
}
