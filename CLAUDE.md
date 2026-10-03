# Musicolet PC

Electron music player. Main process in `src/main/`, UI in `src/renderer/` (plain JS, no framework, no build step).

## Rules for every change

- **Bump the patch version** in `package.json` (and `package-lock.json`, e.g. `npm version patch --no-git-tag-version`)
  in every commit that changes the app, however small: 1.0.1 → 1.0.2 → 1.0.3. Pushing a new version to `main`
  triggers `.github/workflows/release.yml`, which builds the Windows installer/portable exe and publishes a GitHub
  Release; installed copies then show the update prompt (`src/main/updater.js`, `src/renderer/js/updates.js`).
- The release notes are the commit message (minus trailer lines), so write the commit body for the user.
  Wrapping lines is fine: the workflow joins wrapped lines back into whole bullets/paragraphs before publishing.
- `BULLETIN.md` is the in-app bulletin board (Settings → Bulletin board, fetched live from `main` by
  `src/main/bulletin.js`). Editing it is not an app change: don't bump the version for board-only edits.
- Commit trailer: use `Contributed-To-By: Claude <model> <noreply@anthropic.com>` instead of `Co-Authored-By`.
