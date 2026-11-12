#!/usr/bin/env node
// Builds the Song Library catalog: reads every audio file in Songs/ and writes
//   Songs/catalog.json   title, artist, album, length, size and file path of every song
//   Songs/.covers/       one cover image per song (so the app can show covers before downloading)
// Runs automatically on GitHub when Songs/ changes (.github/workflows/catalog.yml); `npm run catalog` runs it locally.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { parseFile } from 'music-metadata';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SONGS = path.resolve(ROOT, process.argv[2] || 'Songs');
const COVERS = path.join(SONGS, '.covers');
const AUDIO = new Set(['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.aac', '.wav', '.webm', '.weba']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (AUDIO.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

// "Artist - Title.mp3" when the file has no tags.
function fromName(file) {
  const base = path.basename(file, path.extname(file));
  const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

fs.mkdirSync(COVERS, { recursive: true });
const songs = [];
const keepCovers = new Set();
for (const file of walk(SONGS)) {
  const rel = path.relative(SONGS, file).split(path.sep).join('/');
  const id = crypto.createHash('sha1').update(rel.toLowerCase()).digest('hex').slice(0, 12);
  let meta = null;
  try {
    meta = await parseFile(file, { duration: true });
  } catch (err) {
    console.warn(`Skipping unreadable file ${rel}: ${err.message}`);
    continue;
  }
  const c = meta.common;
  const guess = fromName(file);
  let cover = null;
  const pic = c.picture?.[0];
  if (pic?.data?.length) {
    cover = `.covers/${id}${/png/i.test(pic.format) ? '.png' : '.jpg'}`;
    fs.writeFileSync(path.join(SONGS, cover), pic.data);
    keepCovers.add(path.basename(cover));
  }
  songs.push({
    id,
    file: rel,
    title: c.title || guess.title,
    artist: c.artist || (c.artists || []).join(', ') || guess.artist,
    album: c.album || '',
    duration: Math.round(meta.format.duration || 0),
    size: fs.statSync(file).size,
    cover,
  });
}

// Remove covers of songs that were deleted or replaced.
for (const f of fs.readdirSync(COVERS)) if (!keepCovers.has(f)) fs.unlinkSync(path.join(COVERS, f));

const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
songs.sort((a, b) => cmp(a.artist, b.artist) || cmp(a.album, b.album) || cmp(a.title, b.title));
fs.writeFileSync(path.join(SONGS, 'catalog.json'), JSON.stringify({ version: 1, songs }, null, 1) + '\n');
console.log(`Catalog: ${songs.length} song(s), ${keepCovers.size} cover(s).`);
