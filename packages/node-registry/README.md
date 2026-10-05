# Node Registry

Versioned canvas node definitions, shared by the browser, the backend and (through JSON Schema) agents. Isomorphic: only `zod` and relative imports, no React, no Node APIs, no user-facing strings.

- `NodeDefinition`: `type` (dotted, unique), `version`, typed `inputs`/`outputs` ports, a zod `config` schema (every field has a default so `config.parse({})` works; no transforms) and an optional `estimateCost`.
- `defineNode`, `createRegistry` (duplicate `(type, version)` throws; `get(type)` returns the latest version), `canConnect` (the only place that decides which port types may be connected), `defaultConfig`.
- Example nodes: `text` (output `text`) and `image.generate` (input `prompt`, output `image`).
- Display names and port labels are not here: the web app looks them up by convention at `nodes.<type>.title` and `nodes.<type>.ports.<portId>`; the renderer and config form live in `apps/web/features/canvas/node-ui.tsx`.

## JSON Schema output

`toJsonSchemas(registry)` converts every definition (config in the zod "input" form, so defaulted fields are optional). The committed copy is `schemas/nodes.json`; regenerate it after changing a definition:

```bash
pnpm --filter @creative/node-registry generate
```

A unit test compares the generated output with the committed file, so drift fails `pnpm test` (and CI). Use this file as the single input for agent tool parameters and for non-TypeScript consumers instead of maintaining a second copy.

## Adding a node

1. Add `src/nodes/<name>.ts` with `defineNode(...)` and list it in `nodeDefinitions` (`src/index.ts`).
2. Add `nodes.<type>.*` messages and an entry in `nodeUi` (`apps/web/features/canvas/node-ui.tsx`); tests fail until both exist.
3. Run `generate` and commit `schemas/nodes.json`.

Changing an existing config incompatibly: add a new `version`, keep the old definition registered.
