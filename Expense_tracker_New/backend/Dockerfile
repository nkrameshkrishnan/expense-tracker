# Matches the Lambda runtime (Node.js 20.x) for behavioral parity.
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
