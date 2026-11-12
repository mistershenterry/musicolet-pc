# Songs

The **Song Library** catalog: everything in this folder can be found and downloaded in Musicolet PC
(sidebar → Song Library).

## Adding songs

1. Put audio files in this folder (subfolders are fine) and push them to `main`.
2. A GitHub workflow ([`catalog.yml`](../.github/workflows/catalog.yml)) runs on its own: it reads each song's
   title, artist, album, length and cover, and commits [`catalog.json`](catalog.json) and the covers in `.covers/`.
   That catalog is what the app searches. No new app version or release is needed.
3. Within about 5 minutes, every copy of the app shows the new songs (or click the refresh button in the Song Library).

Removing or renaming a file works the same way: push the change and the catalog updates itself.

Tag your songs (title, artist, album, cover) before adding them: the Song Library's search and its artist and album
filters use those tags. Untagged files named `Artist - Title.mp3` still work; the name is used instead.

Supported: `.mp3`, `.flac`, `.ogg`, `.oga`, `.opus`, `.m4a`, `.m4b`, `.aac`, `.wav`, `.webm`, `.weba`.

To rebuild the catalog by hand: `node scripts/build-catalog.mjs` (from the repository folder).

## What happens to downloaded songs

Downloaded songs are stored encrypted, under random names, in a hidden folder inside the app's data folder, with a
key protected by Windows. They can be played (and deleted) in Musicolet PC, but not edited or opened elsewhere.
This stops casual copying; it can't stop a determined person, since the app has to decrypt a song to play it.

## Two things to keep in mind

Git keeps every version of every binary forever, so this folder only ever adds to the repository's size: removing a
song later doesn't shrink a clone. GitHub refuses single files over 100 MB and starts warning past about 1 GB per
repository.

This folder is public: anyone can download what's in it, with or without the app, and publishing music you don't
hold the rights to is distribution. A takedown would apply to this whole repository, the player included, not just
to the files in here.
