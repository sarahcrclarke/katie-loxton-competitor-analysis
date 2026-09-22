# katie-loxton-competitor-analysis

Automated competitor monitoring and trading dashboard for Katie Loxton.

## Phase 1 (current)

This is a proof of concept for a single competitor, **Strathberry**, before
the dashboard is extended to the full competitor set. It proves that:

- a basic Next.js (App Router + TypeScript + Tailwind) app builds and runs;
- GitHub Actions can automatically capture a mobile, full-page screenshot of
  the Strathberry UK homepage using Playwright; and
- the app can display the latest successful capture (or a clear "no capture
  yet" state, never fabricated data).

### Running the capture manually

1. In GitHub, go to **Actions → Capture Strathberry → Run workflow** to
   trigger a capture on demand (in addition to its daily schedule).
2. The workflow saves the screenshot and a JSON metadata record to
   `public/captures/strathberry/YYYY-MM-DD/` and commits them back to this
   branch.
3. The landing page (`/`) shows the most recent successful capture, if one
   exists.

### Local development

```bash
npm install
npm run dev        # start the Next.js dev server
npm run build       # production build
npx playwright install --with-deps chromium   # one-time, for local captures
npm run capture:strathberry                   # run the capture script locally
```

No database, authentication, or API layer is included at this stage by
design — only what's needed to prove the capture pipeline works.
