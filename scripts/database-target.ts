/**
 * A que base apunta una cadena de conexion, dicho sin la contrasena. Sirve para tres cosas: que una persona vea
 * a donde va a aplicar una migracion antes de aplicarla (ADR 0010), que nada destructivo corra contra una base
 * que no sea desechable, y que ningun mensaje filtre una credencial.
 */
export interface DatabaseTarget {
  host: string;
  port: string;
  database: string;
  user: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function describeDatabaseTarget(connectionString: string): DatabaseTarget {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // No se repite el texto recibido: puede llevar una contrasena.
    throw new Error('The connection string is not a valid URL');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('The connection string must start with postgresql://');
  }
  return {
    host: url.hostname,
    port: url.port === '' ? '5432' : url.port,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
  };
}

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.toLowerCase());
}

/** El texto que se le muestra a la persona: usuario, host, puerto y base. Nunca la contrasena. */
export function formatDatabaseTarget(target: DatabaseTarget): string {
  return `${target.user}@${target.host}:${target.port}/${target.database}`;
}

/**
 * Las pruebas de integracion borran y recrean el esquema `public`: solo pueden correr contra una base local
 * cuyo nombre diga que es de pruebas. Si alguien apunta `TEST_DATABASE_URL` a un ambiente real, se detiene aqui.
 */
export function assertDisposableDatabase(connectionString: string): DatabaseTarget {
  const target = describeDatabaseTarget(connectionString);
  if (!isLocalHost(target.host) || !target.database.endsWith('_test')) {
    throw new Error(
      `Refusing to reset ${formatDatabaseTarget(target)}: only a local database whose name ends in "_test" is disposable`,
    );
  }
  return target;
}

/** Una migracion aplicada no se deshace sola (ADR 0010): fuera de esta maquina, una persona la confirma. */
export function requiresConfirmation(target: DatabaseTarget): boolean {
  return !isLocalHost(target.host);
}

/** La confirmacion es escribir el host: obliga a leer a donde se va, que un «si» no obliga. */
export function isConfirmed(typed: string, target: DatabaseTarget): boolean {
  return typed.trim().toLowerCase() === target.host.toLowerCase();
}
