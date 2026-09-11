# ============================================================
# 核电工程隐患智能识别与定级系统 - Docker 镜像
# 阶段一：安装依赖并构建前端（tsc 类型检查 + vite build -> dist/）
# 阶段二：运行时（服务端为 TS 源码，经 tsx 执行，需要完整 node_modules）
# ============================================================

# ---- 构建阶段 ----
FROM node:22-alpine AS build
WORKDIR /app

# 先复制依赖清单，借助层缓存加速重复构建
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码并构建生产产物
COPY . .
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# 复用构建阶段产出的依赖（含 devDependencies，tsx 执行 TS 服务端源码需要）
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY server ./server
COPY shared ./shared
COPY configs ./configs
COPY datas/test/*.csv ./datas/test/
COPY .env.example ./

EXPOSE 3001

# 识别前需通过环境变量或模型配置页面接入真实模型
CMD ["npx", "tsx", "server/index.ts"]
