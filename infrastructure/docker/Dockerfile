# syntax=docker/dockerfile:1.7

# ARC Control — API and console.
#
# One image serves both; the command decides which. They are separate
# processes and separate deployments, but they share a build, and keeping one
# image means the console can never drift to a different version of the
# object model than the API it reads.

# ---- build ------------------------------------------------------------------
FROM node:22.22.0-bookworm-slim AS build

WORKDIR /src

# Manifests first, so a dependency layer is cached independently of source.
COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json ./
COPY packages/schemas/package.json                 packages/schemas/
COPY packages/store/package.json                   packages/store/
COPY packages/agent-identity/package.json          packages/agent-identity/
COPY packages/policy-engine/package.json           packages/policy-engine/
COPY packages/approvals/package.json               packages/approvals/
COPY packages/evidence/package.json                packages/evidence/
COPY packages/audit/package.json                   packages/audit/
COPY packages/execution/package.json               packages/execution/
COPY packages/gateway/package.json                 packages/gateway/
COPY packages/mcp-security/package.json            packages/mcp-security/
COPY packages/sdk-typescript/package.json          packages/sdk-typescript/
COPY packages/cli/package.json                     packages/cli/
COPY packages/cli/bin/                             packages/cli/bin/
COPY connectors/generic-http/package.json          connectors/generic-http/
COPY connectors/simulation/package.json            connectors/simulation/
COPY connectors/mcp/package.json                   connectors/mcp/
COPY apps/control-api/package.json                 apps/control-api/
COPY apps/control-console/package.json             apps/control-console/

# `--ignore-scripts` skips the root `prepare` build, which cannot run before
# the sources are copied in.
RUN npm ci --ignore-scripts

COPY tsconfig.base.json tsconfig.build.json ./
COPY packages/ packages/
COPY connectors/ connectors/
COPY apps/ apps/
# The image is only built if the evals pass, so the evals and what they import
# (the mock MCP server in examples/) have to be in the build stage. schemas/ is
# copied into the runtime image below, so it must exist here too.
COPY evals/ evals/
COPY examples/ examples/
COPY schemas/ schemas/

RUN npm run build && npm test --silent && npm run evals --silent

# Drop TypeScript and the rest of the dev tree from what gets copied forward.
RUN npm prune --omit=dev --ignore-scripts

# ---- runtime ----------------------------------------------------------------
FROM node:22.22.0-bookworm-slim AS runtime

# Signal handling: the API installs SIGTERM and SIGINT handlers to close the
# listener and flush the store, so it must receive them directly rather than
# through a shell.
ENV NODE_ENV=production \
    ARC_HOST=0.0.0.0 \
    ARC_PORT=8787 \
    ARC_CONSOLE_HOST=0.0.0.0 \
    ARC_CONSOLE_PORT=8788

WORKDIR /app

COPY --from=build /src/node_modules   ./node_modules
COPY --from=build /src/package.json   ./package.json
COPY --from=build /src/packages       ./packages
COPY --from=build /src/connectors     ./connectors
COPY --from=build /src/apps           ./apps
COPY --from=build /src/schemas        ./schemas

# The durable store lives here. Mount a volume over it, or the audit chain
# does not survive a restart.
RUN mkdir -p /var/lib/arc-control && chown node:node /var/lib/arc-control
VOLUME /var/lib/arc-control
ENV ARC_DATA_DIR=/var/lib/arc-control

USER node

EXPOSE 8787 8788

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ARC_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/control-api/dist/main.js"]
