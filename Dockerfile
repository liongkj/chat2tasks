FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bubblewrap \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global @openai/codex@0.163.0
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json *schema.json ./
COPY --chown=node:node prompts ./prompts
RUN mkdir -p /app/data /home/node/.codex && chown -R node:node /app /home/node
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=2786 HOME=/home/node CODEX_HOME=/home/node/.codex
USER node
EXPOSE 2786
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
