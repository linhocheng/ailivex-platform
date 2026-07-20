FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# 非 root 執行（node:slim 內建 uid 1000 的 node user）；chown 保 runtime 若寫 /app 不被擋
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
