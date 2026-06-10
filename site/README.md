# Eidentic landing site

A single, self-contained static landing page (`index.html`) — no build step, no dependencies.
Inline CSS, matches the Studio brand palette.

## Preview locally

```bash
python3 -m http.server 4178 --directory site
# open http://localhost:4178
```

## Deploy

It's one static file, so any static host works:

- **Vercel / Netlify** — point the project at the `site/` directory (no build command).
- **GitHub Pages** — serve `site/` via a Pages Action, or move `index.html` to a `gh-pages`
  branch root.
- **Cloudflare Pages** — output directory `site`, no build.

Update the `github.com/eidentic/eidentic` links and the `npm install` line once the repo is
public and the package is published.
