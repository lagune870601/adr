# ============================================================
# adz.js 多路并发访问器 Docker Image
# 基础镜像: cloakhq/cloakbrowser (含 CloakBrowser/Chromium 运行环境)
# 入口: adz.js
# ============================================================

FROM cloakhq/cloakbrowser:latest

LABEL description="adz.js 多路并发访问器"
LABEL maintainer="dev"

# 环境变量（代码内亦有默认值，命令行参数优先级最高）
ENV NODE_ENV=production \
    CONCURRENCY=5 \
    DWELL_SEC=20

# 工作目录
WORKDIR /app

# 复制依赖清单（利用 Docker 缓存层）
COPY package.json package-lock.json ./

# 安装生产依赖
RUN npm install --omit=dev

# 复制运行时所需文件（精简）
COPY adz.js ./
COPY shared/ ./shared/
COPY urls.json ./

# 可选：运行时用宿主机文件覆盖镜像内版本（调试/热更新，无需重建镜像）
#   docker run -v "$(pwd)/adz.js:/app/adz.js" adz-visitor:latest
#   docker run -d -e CONCURRENCY=1 --name=adz --restart=always -v /home/adz/adz.js:/app/adz.js -v /home/adz/urls.json:/app/urls.json adz

# 启动访问器
CMD ["node", "adz.js"]