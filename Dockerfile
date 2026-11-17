# 构建阶段：与 CI 保持一致（Node 24 / pnpm 12.6.0）
FROM node:24-alpine AS build
WORKDIR /app

RUN npm install -g pnpm@12.6.0

# 先装依赖，源码变动时可复用该层缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# API 地址在构建时注入（DefinePlugin + CSP meta），运行时不可替换；
# 留空则使用 rspack.config.ts 的默认地址，自定义地址：
# docker build --build-arg API_ORIGIN=https://your-api.example.com .
ARG API_ORIGIN=
RUN pnpm build

# 运行阶段：nginx 托管静态产物，最终镜像不含 Node 运行时
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80