# Worker deployable — services/* is the area of independently deployable
# services (spec: "Runtime shape"). Internal packages ship TS source, so the
# image runs them through tsx; no build step exists to copy.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

# Install workspace dependencies for the worker graph only.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY services/worker/package.json services/worker/
COPY core/db/package.json core/db/
COPY shared/log/package.json shared/log/
COPY tooling/typescript-config/package.json tooling/typescript-config/
RUN pnpm install --frozen-lockfile --filter @workspace/worker

# Source (internal packages export TS directly).
COPY core core
COPY shared shared
COPY tooling tooling
COPY services/worker services/worker

ENV DATABASE_URL=
CMD ["pnpm", "--filter", "@workspace/worker", "start"]
