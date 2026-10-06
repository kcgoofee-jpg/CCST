# CCST 独立代理（不含酒馆）。构建：docker build -t ccst .   运行示例见 deploy/docker-compose.yml
# 镜像还没发布，需要自己构建；发布流程（.github/workflows/release-image.yml）已就绪，随下一个版本发布。
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/kcgoofee-jpg/CCST" \
      org.opencontainers.image.description="CCST: 让酒馆用 Claude 订阅的本地代理" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENV NODE_ENV=production \
    CLAUDE_SUBSCRIPTION_HOST=0.0.0.0 \
    CLAUDE_SUBSCRIPTION_PORT=8901 \
    CLAUDE_SUBSCRIPTION_DATA_DIR=/data \
    CLAUDE_CONFIG_DIR=/data/claude

WORKDIR /app

# 依赖单独一层，改代码不用重装。不要加 --omit=optional：Claude CLI 在可选依赖里。
# 用 package-lock.json 装：SDK 版本锁在 lockfile 里，镜像之间不会漂。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js manifest.json ./
COPY bin ./bin
COPY src ./src

# /data 放后端设置、用量统计、Claude 登录信息（CLAUDE_CONFIG_DIR），挂成卷才不会随容器丢。
# node 用户（uid 1000）是基础镜像自带的非 root 用户。
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8901

# 容器里自己访问自己算「本机」，不需要访问密码
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.CLAUDE_SUBSCRIPTION_PORT||8901)+'/status',{signal:AbortSignal.timeout(4000)}).then(r=>r.json()).then(j=>process.exit(j.plugin==='claude-subscription'?0:1),()=>process.exit(1))"

CMD ["node", "server.js"]
