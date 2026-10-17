/** Se lanza cuando algo pide la base de datos y `DATABASE_URL` nunca se definio. */
export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super('The database is not configured: set DATABASE_URL (see docs/ambientes.md)');
    this.name = 'DatabaseNotConfiguredError';
  }
}
