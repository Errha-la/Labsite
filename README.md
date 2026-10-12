# Labsite

NTUST research laboratory website built with Vite. The site presents the lab, its members, research, projects, academic collaborations, and contact information in Traditional Chinese and English.

## Requirements

- Node.js `24.21.0` and npm `11.19.0` (see `.nvmrc` and `package.json`)

## Run locally

```sh
npm ci
npm run dev
```

Vite prints the local development URL after startup. To build and preview the production files:

```sh
npm run build
npm run preview
```

Run the Playwright checks with:

```sh
npm test
```

## Project layout

- `index.html` contains the page structure, content, and client-side interactions.
- `assets/data/` contains research and homepage story data.
- `assets/design/styles.css` contains the site styles.
- `assets/js/` contains the runtime and interactive site modules.
- `assets/images/` and `assets/vendor/` contain images and browser libraries used by the site.
- `tests/` contains Playwright acceptance and smoke tests.
- `vite.config.js` configures the build and copies required static files from `assets/` into `dist/`. This project uses `assets/` directly and does not use a `public/` directory.

`package.json` and `package-lock.json` pin the npm project metadata and dependency tree. Install dependencies with `npm ci` to use the committed lockfile.

## Deployment

Pushing to `main` runs the GitHub Actions workflow in `.github/workflows/deploy.yml`. It installs the locked dependencies, builds the site, runs the Playwright suite, and deploys the generated `dist/` directory to GitHub Pages when the checks pass.
