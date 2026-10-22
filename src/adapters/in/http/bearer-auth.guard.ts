import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Authenticate, Session } from '../../../domain/ports/in/authenticate.js';
import { AUTHENTICATE } from './tokens.js';

interface RequestWithSession {
  headers: Record<string, string | string[] | undefined>;
  session?: Session;
}

/**
 * Pone la sesion en la peticion: de la cabecera `Authorization` a la persona, su negocio y su rol (ADR 0022). Si no se
 * puede saber quien llama, el caso de uso lanza un AuthenticationError y el filtro lo contesta; aqui no se decide
 * nada de eso. Todo endpoint de una persona lo usa: `@UseGuards(BearerAuthGuard)`.
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(@Inject(AUTHENTICATE) private readonly authenticate: Authenticate) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const header = request.headers['authorization'];
    request.session = await this.authenticate.execute(Array.isArray(header) ? header[0] : header);
    return true;
  }
}

/** La sesion que encontro `BearerAuthGuard`. Solo existe en endpoints que lo usan. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Session => {
    const session = context.switchToHttp().getRequest<RequestWithSession>().session;
    if (session === undefined) {
      // Un endpoint que pide la sesion sin proteger con el guardia es un defecto del programa, no del cliente.
      throw new Error(
        'CurrentSession was used on a route that is not protected by BearerAuthGuard',
      );
    }
    return session;
  },
);
