# syntax=docker/dockerfile:1

# Dependencies only: sources are bind-mounted by compose.yaml.
FROM node:22-bookworm-slim AS dev
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.package-lock.sha256
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
ENV NODE_ENV=development
EXPOSE 5173
ENTRYPOINT ["entrypoint.sh"]
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Playwright image ships Chromium + system deps. The tag must match @playwright/test in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS e2e
WORKDIR /app
# uid 1000 like `node` above (pwuser is 1001), so test-results/ on the bind mount is writable and owned by the host user.
RUN chown ubuntu:ubuntu /app
USER ubuntu
COPY --chown=ubuntu:ubuntu package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.package-lock.sha256
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["entrypoint.sh"]
CMD ["npm", "run", "test:e2e"]
