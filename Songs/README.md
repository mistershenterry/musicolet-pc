# Songs

Default folder for songs downloaded from inside the app.

The folder itself is tracked so it always exists in a fresh clone, but its
contents are not: `.gitignore` keeps every audio file out of the repository.
Only this file and `.gitkeep` are committed.

This path is a convenience for running from source (`npm start`), where the
repository root is also the app's working directory. The installed and portable
builds don't ship it — `electron-builder` only bundles `src/**/*` and
`package.json` — and writing into an installed app's own folder needs admin
rights on Windows, so a packaged build must download to a folder the user picks
(or to the app's data folder) instead of here.

Add this folder under **Settings -> Library** to have the songs you download
show up in the library.
