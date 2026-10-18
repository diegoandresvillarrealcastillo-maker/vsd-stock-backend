# Imagen del backend de VSD Stock (ADR 0011).
#
# Dos etapas: en la primera se instala y se compila con todas las
# dependencias; en la segunda solo viaja lo necesario para ejecutar. Asi la
# imagen final no lleva las pruebas ni las herramientas de calidad (Vitest,
# ESLint, Prettier). TypeScript si viaja, 24 MB: @nestjs/swagger lo declara
# como dependencia de pares y npm no permite podarlo.

# ---------- Etapa 1: compilar ----------
FROM node:24-slim AS build
WORKDIR /app

# Primero solo los manifiestos: mientras no cambien las dependencias, Docker
# reutiliza esta capa y no vuelve a instalar.
COPY package.json package-lock.json ./
# --ignore-scripts: sin husky ni otros scripts de instalacion dentro de la imagen.
RUN npm ci --ignore-scripts

# El cliente de Prisma se genera del esquema (no se versiona). Primero el esquema y la configuracion, para que esta
# capa solo se rehaga cuando cambian; el CLI sale de las dependencias de desarrollo, que aqui si estan instaladas.
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Deja solo las dependencias de produccion para copiarlas a la etapa final.
RUN npm prune --omit=dev --ignore-scripts

# ---------- Etapa 2: ejecutar ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# No se ejecuta como root: si algo se comprometiera, tendria los permisos
# de un usuario sin privilegios.
USER node

EXPOSE 3000

# El orquestador usa esto para saber si el contenedor esta sano. Reutiliza
# GET /health, que es justo para lo que existe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/infrastructure/main.js"]
