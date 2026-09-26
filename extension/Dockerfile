# syntax=docker/dockerfile:1

# Build context is the repo root (see compose.yaml): the extension compiles Avatar Core from ../avatar/src and
# resolves three, three-vrm and wlipsync from avatar/node_modules, so both packages are installed.
# Dependencies only: sources are bind-mounted by compose.yaml, dist/ is written back to the host through the mount.
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN chown node:node /repo
USER node
COPY --chown=node:node avatar/package.json avatar/package-lock.json avatar/
COPY --chown=node:node extension/package.json extension/package-lock.json extension/
RUN cd avatar && npm ci --no-audit --no-fund \
 && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.package-lock.sha256 \
 && cd ../extension && npm ci --no-audit --no-fund \
 && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.package-lock.sha256
COPY extension/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
WORKDIR /repo/extension
ENTRYPOINT ["entrypoint.sh"]
CMD ["npm", "run", "build"]

# Extension E2E: Chromium with the unpacked extension and real tab capture. The tag must match @playwright/test
# in extension/package-lock.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS e2e
WORKDIR /repo
# uid 1000 like `node` above (pwuser is 1001), so files written to the bind mount belong to the host user.
RUN chown ubuntu:ubuntu /repo
USER ubuntu
COPY --chown=ubuntu:ubuntu avatar/package.json avatar/package-lock.json avatar/
COPY --chown=ubuntu:ubuntu extension/package.json extension/package-lock.json extension/
RUN cd avatar && npm ci --no-audit --no-fund \
 && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.package-lock.sha256 \
 && cd ../extension && npm ci --no-audit --no-fund \
 && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.package-lock.sha256
COPY extension/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
WORKDIR /repo/extension
ENTRYPOINT ["entrypoint.sh"]
CMD ["npm", "run", "test:e2e"]
