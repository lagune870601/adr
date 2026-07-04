# ============================================================
# Adsterra 爬虫调度器 Docker Image
# 基础镜像: cloakhq/cloakbrowser (含 CloakBrowser 运行环境)
# 入口: main.js (任务调度器)
# ============================================================

FROM cloakhq/cloakbrowser:latest

LABEL description="Adsterra Crawler Scheduler"
LABEL maintainer="dev"

# 环境变量
ENV NODE_ENV=production

# 工作目录
WORKDIR /app

# 复制依赖清单（利用Docker缓存层）
COPY package.json package-lock.json ./

# 安装项目依赖
RUN npm install --only=production

# 复制源码
COPY shared/     ./shared/
COPY lib/        ./lib/
COPY proxy.js    ./
COPY signup.js   ./
COPY open-account.js ./
COPY login.js ./
COPY create-api-token.js ./
COPY change-name.js ./
COPY create-link.js ./
COPY create-payout.js ./
COPY payout.js     ./
COPY main.js     ./

# 启动主调度器
CMD ["node", "main.js"]