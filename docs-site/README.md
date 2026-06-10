# Eidentic Docs Site

Static documentation site for [Eidentic](https://github.com/eidentic/eidentic), built with [Astro Starlight](https://starlight.astro.build/).

This directory is **not** part of the monorepo pnpm workspace (`packages/*`). It has its own `package.json` and lockfile and does not affect `pnpm -r build` or the test suite.

## Local development

```bash
cd docs-site
npm install
npm run dev
```

Open `http://localhost:4321`.

## Build

```bash
cd docs-site
npm run build
```

Output is in `docs-site/dist/`. Preview with:

```bash
npm run preview
```

## Deploy

### Vercel

1. Add the `docs-site` directory as a new Vercel project (or use the root repo with `docs-site` as the root directory).
2. Set:
   - **Build command:** `npm run build`
   - **Output directory:** `dist`
   - **Root directory:** `docs-site`

### Netlify

1. In Netlify, set:
   - **Base directory:** `docs-site`
   - **Build command:** `npm run build`
   - **Publish directory:** `docs-site/dist`

### GitHub Pages

Use a GitHub Actions workflow:

```yaml
name: Deploy docs
on:
  push:
    branches: [main]
    paths: ['docs-site/**']

jobs:
  build-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
        working-directory: docs-site
      - run: npm run build
        working-directory: docs-site
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs-site/dist
      - uses: actions/deploy-pages@v4
```

## Content

Pages live in `src/content/docs/`. Each `.md` or `.mdx` file maps directly to a URL:

| File | URL |
|---|---|
| `getting-started.md` | `/getting-started` |
| `guides/nextjs.md` | `/guides/nextjs` |
| `guides/memory.md` | `/guides/memory` |
| `guides/structured-output.md` | `/guides/structured-output` |
| `guides/tools.md` | `/guides/tools` |
| `guides/runtimes.md` | `/guides/runtimes` |
| `guides/server-studio.md` | `/guides/server-studio` |
| `reference.md` | `/reference` |

## Configuration

Astro + Starlight config is in `astro.config.mjs`. Brand accent color, sidebar nav, GitHub link, and site metadata are all set there.
