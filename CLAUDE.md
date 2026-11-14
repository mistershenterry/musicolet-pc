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

## Separating albums (album groups): how to do it from a prompt

Songs are grouped into albums by album name (+ album artist, or folder when there's none). Unrelated songs that happen
to share an album name, e.g. two different "Override - Single" releases, get merged. An **album group** fixes this:
a custom tag `TXXX:MUSICOLET_ALBUM_GROUP` (MP3 only) holding any short code. Only songs with the same album name
**and** the same group share an album. Empty/missing = normal grouping. Users can also do it in the app
(right-click a song → Album group, or Edit tags → Album group).

When the user asks to separate (or merge back) albums, use `scripts/album-group.mjs` from the repo folder:

1. Find the songs: `npm run album-group -- find "Override"` (album or title contains the text), or
   `npm run album-group -- dupes` (album names currently shared by different artists, i.e. likely wrongly merged).
   Library folders come from the app's `%APPDATA%\Musicolet PC\library.json`; add `--dir "<folder>"` to override.
2. Give the song(s) that should split off a group code. Songs that belong together get the **same** code:
   `npm run album-group -- set <code> "<file name or full path>" ["<more songs>"]`
   Pick a short readable code, e.g. the artist (`regona`) or `v2`. File names without a path are looked up in the
   library folders; if a name matches several files, use the full path the tool prints.
3. To undo: `npm run album-group -- clear "<song>"`. To check: `npm run album-group -- show "<song>"`.
4. Tell the user to restart Musicolet PC or use Settings → Rescan library; changed files are re-read on the next scan.

Only MP3 files can be written. This edits tags in the user's music files, so say which files changed.

## Song Library (downloadable songs)

- Catalog = audio files in `Songs/` of the **private** repository `mistershenterry/musicolet-pc-songs` (local clone:
  `C:\Users\arwit\Downloads\musicolet-pc-songs`). Its own workflow builds `Songs/catalog.json` + `Songs/.covers/` on push.
  Adding songs = push audio files there (see that repository's README); never to this repository.
- The app gets the catalog, covers and songs from the Song Library server (`SONGS_SERVER` in `src/main/downloads.js`):
  a Cloudflare Worker in the songs repository's `worker/` folder that reads it with a read-only token kept as a
  Cloudflare secret. Users connect nothing. Covers are served to the UI by `mco://libcover/` (cached in userData).
  `MUSICOLET_PC_CATALOG` points at another folder URL (e.g. a local test server).
- Never put a token in this repository's code: it's public.
- Downloads are encrypted (AES-256-CTR, key protected with Electron safeStorage) in a random hidden folder in userData
  (`src/main/vault.js`) and played through the `mco://media` protocol, which decrypts on the fly with Range support.
- Downloaded songs (`t.downloaded` in the renderer, `library.isDownloaded()` in main) can only be played or deleted:
  no tag editing, no Go to folder / Show in Explorer. In the Folders tab they all appear in a virtual "Downloaded Songs"
  folder (`DOWNLOADS_FOLDER` in store.js), never opened in Explorer. Their album group comes from the song file in
  the Song Library (`TXXX:MUSICOLET_ALBUM_GROUP`, set before pushing it) and can't be changed in the app.
- Only add songs to the songs repository when the user asks: every song there can be downloaded by anyone using the app.
