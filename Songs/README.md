# Songs

The song catalog the app downloads from.

Put audio files in this folder and push them. The app's **Download songs**
button reads this folder straight from GitHub, lists what's in it, and copies
the files you pick into your own music folder. Nothing else needs updating:
the listing comes from the folder itself, so pushing a file is all it takes
for every copy of the app to offer it.

Name files `Artist - Title.ext` where you can — the download menu shows the
artist and title separately when a name follows that pattern, and falls back to
the plain file name when it doesn't.

Supported: `.mp3`, `.flac`, `.ogg`, `.oga`, `.opus`, `.m4a`, `.m4b`, `.aac`,
`.wav`, `.webm`, `.weba`. Anything else here is ignored by the menu.

Downloads do **not** land back in this folder. They go to a folder you choose
in the app (it offers your library folder), so a packaged build never tries to
write into its own install directory.

## Two things to keep in mind

Git keeps every version of every binary forever, so this folder only ever adds
to the repository's size — removing a song later doesn't shrink a clone.
GitHub refuses single files over 100 MB and starts warning past about 1 GB per
repository. If the catalog outgrows that, move the files to a GitHub Release
and point the menu at the release instead: same idea, no clone bloat, 2 GB per
file, uploaded with `gh release upload` rather than `git push`.

This folder is public, and publishing music you don't hold the rights to is
distribution. A takedown would apply to this whole repository, the player
included, not just to the files in here.
