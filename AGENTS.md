# Pilot project instructions

Whenever a change affects Pilot's behavior, APIs, integration, setup, or implementation status, update the relevant web documentation in `apps/docs/src/content.js` in the same change. Keep implemented features, verified behavior, and remaining limits accurate. A README-only update does not replace the web docs update.

Preserve unrelated work in the docs and landing page, including work from concurrent sessions. After changing the web docs, run `npm run build --prefix apps/docs` and the existing docs tests when applicable.
