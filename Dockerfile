# --- Dependencies ------------------------------------------------------------------------------
# better-sqlite3 is a native module. It normally downloads a prebuilt binary; the build tools are
# only here for when no prebuilt one matches, and stay out of the final image.
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- App ---------------------------------------------------------------------------------------
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# The database and icon cache live on a volume, owned by the unprivileged node user.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://localhost:3000/api/me').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Runs the database migrations, then starts the server (see server/index.js).
CMD ["node", "server/index.js"]
