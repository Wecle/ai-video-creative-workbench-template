# Infrastructure

`docker-compose.yml` starts only the local PostgreSQL and Redis dependencies:

```bash
pnpm infra:up
pnpm infra:down
```

`docker-compose.full.yml` builds and starts the complete template stack, including
the Next.js web app, independent Gateway, Backend, TypeScript Agent Runner and
Python Worker:

```bash
pnpm docker:up
pnpm docker:down
pnpm docker:logs
```

The full stack publishes the web app on `http://localhost:3000`, Gateway on
`http://localhost:4000`, Backend debug access on `http://localhost:4001`, Agent
Runner on `http://localhost:4100` and the Python Worker on
`http://localhost:4200`. The web image bakes the internal Compose
Gateway address into the Next.js rewrite during its production build.

Gateway and Backend have separate workspace packages, images and ports. A
production deployment can release the Gateway without rebuilding or deploying
the Backend.
