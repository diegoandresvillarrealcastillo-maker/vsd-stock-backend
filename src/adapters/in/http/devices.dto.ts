import { ApiProperty } from '@nestjs/swagger';
import type { DeviceView } from '../../../domain/ports/in/devices.js';

/** Lo que se manda para registrar un dispositivo (C3-01). */
export class RegisterDeviceRequestDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'El identificador que el propio dispositivo se inventó antes de hablar con el servidor. Es la llave de la idempotencia: registrar dos veces el mismo no gasta otro código.',
  })
  readonly id!: string;

  @ApiProperty({
    type: String,
    maxLength: 80,
    required: false,
    nullable: true,
    example: 'Caja del frente',
    description: 'Para que el dueño reconozca el dispositivo en la lista.',
  })
  readonly name?: string | null;
}

export class DeviceDto implements DeviceView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({
    type: String,
    minLength: 2,
    maxLength: 4,
    example: 'AA',
    description:
      'El código corto que encabeza los folios de este dispositivo (`AA-000142`). Lo da el servidor y no se reutiliza jamás.',
  })
  readonly code!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Caja del frente' })
  readonly name!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly enrolledByUserId!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  readonly enrolledAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo se dio de baja. `null` mientras siga activo.',
  })
  readonly revokedAt!: Date | null;
}

/** Una página de dispositivos (ADR 0019). */
export class DevicePageDto {
  @ApiProperty({ type: [DeviceDto] })
  readonly items!: DeviceDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más.',
  })
  readonly nextCursor!: string | null;
}
