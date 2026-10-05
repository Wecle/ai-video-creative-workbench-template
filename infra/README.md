# Infrastructure

`docker-compose.yml` starts only the local PostgreSQL, Redis and Temporal dependencies:

```bash
pnpm infra:up
pnpm infra:down
```

`docker-compose.full.yml` builds and starts the complete template stack, including
the Next.js web app, independent Gateway, Backend, the TypeScript Agent Runner
(a Temporal worker) and Python Worker:

```bash
pnpm docker:up
pnpm docker:down
pnpm docker:logs
```

The full stack publishes the web app on `http://localhost:3000`, Gateway on
`http://localhost:4000`, Backend debug access on `http://localhost:4001`, the
Temporal UI on `http://localhost:8080`, Temporal gRPC on `localhost:7233` and the
Python Worker on `http://localhost:4200`. The Agent Runner publishes no port: it is
a Temporal worker and reports health through a ready file. The web image bakes the internal Compose
Gateway address into the Next.js rewrite during its production build.

Each compose file sets its own project name (`creative-dev` for `docker-compose.yml`,
`creative-full` for `docker-compose.full.yml`), so `pnpm docker:down` only stops the full
stack. Both files publish the same ports (5432, 6379, 7233, 8080) and **cannot run at the
same time**. `-p` and `COMPOSE_PROJECT_NAME` take precedence over `name:`; do not set the
variable in your shell or `.env`. The old project name `docker` left the orphaned volume
`docker_postgres-data`; remove it with `docker volume rm docker_postgres-data` once you no
longer need that data, then re-run `pnpm db:migrate` against the new dev database.

Gateway and Backend have separate workspace packages, images and ports. A
production deployment can release the Gateway without rebuilding or deploying
the Backend.

## Temporal

Both compose files run a self-hosted Temporal next to the shared PostgreSQL (the deprecated
`temporalio/auto-setup` image is not used):

| Service              | Role                                                                                  | Port                    |
| -------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| `temporal-setup`     | one-shot: creates `temporal` / `temporal_visibility` databases, tables, schema update | -                       |
| `temporal`           | `temporalio/server`, gRPC frontend                                                    | `127.0.0.1:7233`        |
| `temporal-namespace` | one-shot: creates the `default` namespace                                             | -                       |
| `temporal-ui`        | `temporalio/ui`                                                                       | `http://127.0.0.1:8080` |

- `temporal-setup` is idempotent and runs on every `up`, so it also works on an existing
  `postgres-data` volume (no `docker-entrypoint-initdb.d` script). Visibility uses PostgreSQL;
  there is no Elasticsearch.
- `NUM_HISTORY_SHARDS` is fixed to `4` for development. Temporal reads it only when the cluster
  is created; changing it later is ignored. Do not reuse a development database for production:
  size the shard count before the first production start.
- Production notes (not handled by this template): run Temporal on its own PostgreSQL instance
  with a dedicated role instead of the development user `template`, and enable TLS and auth.
- Optional, lighter local path: with the Temporal CLI installed (`brew install temporal`) you can
  run `temporal server start-dev` (port 7233, UI 8233, in-memory) instead of the compose
  Temporal services. It is not used by the scripts and not for acceptance.
