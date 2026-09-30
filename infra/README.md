# Infrastructure

`docker-compose.yml` starts only the local PostgreSQL and Redis dependencies:

```bash
pnpm infra:up
pnpm infra:down
```

`docker-compose.full.yml` builds and starts the complete template stack, including
the Next.js web app, Fastify Gateway, TypeScript Agent Runner and Python Worker:

```bash
pnpm docker:up
pnpm docker:down
pnpm docker:logs
```

The full stack publishes the web app on `http://localhost:3000`, Gateway on
`http://localhost:4000`, Agent Runner on `http://localhost:4100` and the Python
Worker on `http://localhost:4200`. The web image bakes the internal Compose
Gateway address into the Next.js rewrite during its production build.
