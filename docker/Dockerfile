# --- Build stage ---
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:ts


# --- Production stage ---
FROM node:22-alpine

WORKDIR /app

ENV PORT=6005

COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist dist

EXPOSE 6005

CMD ["npx", "fastify", "start", "-l", "info", "dist/app.js"]