# docs

This is the Vantik documentation site. It uses
[Docusaurus](https://docusaurus.io/), a generator for a static website.

A push to `main` that changes this directory deploys the site to GitHub Pages.
See `.github/workflows/deploy-docs.yml`.

## How to install

```bash
pnpm install
```

## Local development

```bash
pnpm start
```

This command starts a local development server and opens a browser window. The
server shows most changes immediately, and you do not restart it.

## How to make the API reference

```bash
pnpm clean-api-docs
pnpm gen-api-docs
```

The second command reads `openapi/openapi.yml` and writes the pages under
`docs/api-reference`. It does not replace a page that exists, so the first
command removes the generated pages before it. Do not edit a `*.api.mdx` file
by hand, because these commands replace it. Edit `openapi/openapi.yml` and run
the commands again.

## How to build

```bash
pnpm build
```

This command writes the static site into the `build` directory. Any host for a
static site can then serve it.

## How to deploy by hand

The workflow deploys the site for you. To deploy it by hand with SSH, run:

```bash
USE_SSH=true pnpm run deploy
```

To deploy it by hand without SSH, run:

```bash
GIT_USER=<Your GitHub username> pnpm run deploy
```

Each command builds the site and pushes it to the `gh-pages` branch.
