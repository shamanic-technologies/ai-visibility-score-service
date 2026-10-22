FROM node:22.23.4-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22.23.4-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/openapi.json ./
COPY --from=builder /app/drizzle ./drizzle
USER app
EXPOSE 8080
CMD ["node", "dist/index.js"]
