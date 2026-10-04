# webapp

This is the Vantik user interface. It is a React
application that [Vite](https://vite.dev/) builds to static files. People use it to review and to audit
the work that agents do.

The webapp talks to the API server. It does not talk to the database.

## How to start

Run the whole stack from the root of the repository, and not from this
directory. The root scripts give the apps their environment variables:

```bash
pnpm dev
```

This command starts the API server on port 3001 and the webapp on port 3000.
Open [http://localhost:3000](http://localhost:3000) in your browser.

Read the [root README](../../README.md) for the services that you must start
first.

## The directories

| Directory | What is in it |
| --- | --- |
| `src/pages` | The routes, one file for each: `[workspaceSlug]/issue/[issueId].tsx` serves `/:workspaceSlug/issue/:issueId` (see `src/routes.tsx`). |
| `src/modules` | The features, one directory for each feature: issues, projects, cycles, views, search, settings, and more. |
| `src/components` | The user interface parts that many modules use. |
| `src/store` | The client state, and the local database for the real-time sync. |
| `src/services` | The calls to the API server. |
| `src/hooks` | The React hooks that many modules use. |
| `src/common` | The types and the helpers that many modules use. |

## Configuration

The webapp reads its runtime configuration from the API server at
`/api/v1/config`. The one setting is `NEXT_PUBLIC_BACKEND_HOST`, which the
server reads from its environment. A self-hosted installation therefore sets it
when the container starts, and no rebuild is necessary.

In the image, nginx serves the build and proxies `/api/*` to the server
(`nginx.conf.template`). In development, Vite does the same (`vite.config.ts`).

## The scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the development server, with hot reload. |
| `pnpm build` | Builds the static files into `dist`. |
| `pnpm test` | Runs the tests one time with Vitest. |
| `pnpm typecheck` | Checks the types, and emits no output. |
| `pnpm lint` | Runs ESLint. It reports the problems, and it does not correct them. |

## Dependency patches

The repository patches `react-virtualized@9.22.6` for React 19, in
`patches/react-virtualized@9.22.6.patch`. The patch reads `props.ref`, and not
`element.ref`. It keeps callback refs and object refs. Remove the patch when an
upstream release includes the fix.
