#!/usr/bin/env node
// Album groups from the command line, so they can be set without opening the app (e.g. by Claude from a prompt).
// An album group is a custom tag (TXXX:MUSICOLET_ALBUM_GROUP, MP3 only) that keeps a song out of other albums
// with the same name: only songs with the same album name AND the same group form one album in Musicolet PC.
//
//   npm run album-group -- find <text>            songs whose album or title contains <text>, with their group
//   npm run album-group -- dupes                  album names that Musicolet PC currently merges from several artists/folders
//   npm run album-group -- set <group> <song...>  give songs a group (songs with the same group stay together)
//   npm run album-group -- clear <song...>        remove the group (back to normal grouping)
//   npm run album-group -- show <song...>         print a song's album, artist and group
//
// <song> is a path, or just the file name (e.g. "Override.mp3") which is looked up in the library folders
// (read from Musicolet PC's library.json; override with --dir "C:\path"). Musicolet PC picks up changes on its
// next scan: restart it, or use Settings → Rescan library.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const NodeID3 = require('node-id3');
const { parseFile } = await import('music-metadata');

const TAG = 'MUSICOLET_ALBUM_GROUP';
const AUDIO = new Set(['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.aac', '.wav', '.webm', '.weba']);

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
const extraDir = dirFlag >= 0 ? args.splice(dirFlag, 2)[1] : null;
const [cmd, ...rest] = args;

function libraryRoots() {
  if (extraDir) return [path.resolve(extraDir)];
  const appData = process.env.APPDATA || path.join(os.homedir(), '.config');
  for (const name of ['Musicolet PC', 'musicolet-pc']) {
    try {
      const lib = JSON.parse(fs.readFileSync(path.join(appData, name, 'library.json'), 'utf8'));
      if (lib.roots?.length) return lib.roots;
    } catch {
      // try the next location
    }
  }
  return [path.join(os.homedir(), 'Music')];
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((e) => e.isFile() && e.name.toLowerCase() === '.nomedia')) return out;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (AUDIO.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

let allFiles = null;
const files = () => (allFiles ||= libraryRoots().flatMap((r) => walk(r)));

function resolveSong(arg) {
  if (fs.existsSync(arg)) return path.resolve(arg);
  const want = arg.toLowerCase();
  const hits = files().filter((f) => path.basename(f).toLowerCase() === want || path.basename(f, path.extname(f)).toLowerCase() === want);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`"${arg}" matches several files, give the full path:\n  ${hits.join('\n  ')}`);
  throw new Error(`No song file named "${arg}" in ${libraryRoots().join(', ')}`);
}

function readGroup(native) {
  for (const tags of Object.values(native || {})) {
    for (const t of tags) {
      const id = String(t.id || '').toUpperCase();
      if (id !== TAG && !id.endsWith(':' + TAG)) continue;
      const v = Array.isArray(t.value) ? t.value[0] : t.value;
      const text = String(v?.text ?? v ?? '').trim();
      if (text) return text;
    }
  }
  return '';
}

async function info(file) {
  const m = await parseFile(file, { duration: false, skipCovers: true });
  const c = m.common;
  return { file, title: c.title || path.basename(file), artist: c.artist || '', album: c.album || '', albumArtist: c.albumartist || '', group: readGroup(m.native) };
}

const line = (s) => `${path.basename(s.file)}\n    album: ${s.album || '(none)'} | artist: ${s.artist || '(none)'} | group: ${s.group || '(none)'}\n    ${s.file}`;

function writeGroup(file, group) {
  if (path.extname(file).toLowerCase() !== '.mp3') throw new Error(`${path.basename(file)}: album groups can only be written to MP3 files`);
  const res = NodeID3.update({ userDefinedText: [{ description: TAG, value: group }] }, file);
  if (res instanceof Error) throw res;
}

try {
  switch (cmd) {
    case 'find': {
      const q = rest.join(' ').toLowerCase();
      if (!q) throw new Error('Usage: find <text>');
      let n = 0;
      for (const f of files()) {
        const s = await info(f);
        if (`${s.album} ${s.title} ${path.basename(f)}`.toLowerCase().includes(q)) {
          console.log(line(s));
          n++;
        }
      }
      console.log(`\n${n} song(s) found.`);
      break;
    }
    case 'dupes': {
      // Same album name, no album artist, different folders or artists: likely unrelated albums that merge.
      const byName = new Map();
      for (const f of files()) {
        const s = await info(f);
        if (!s.album) continue;
        const key = `${s.album.toLowerCase()}|${(s.albumArtist || '').toLowerCase()}|${s.group.toLowerCase()}`;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(s);
      }
      let n = 0;
      for (const songs of byName.values()) {
        const artists = new Set(songs.map((s) => s.artist.toLowerCase()));
        if (songs.length < 2 || artists.size < 2) continue;
        n++;
        console.log(`"${songs[0].album}"${songs[0].group ? ` [group ${songs[0].group}]` : ''}: ${songs.length} songs by ${artists.size} different artists`);
        for (const s of songs) console.log('  - ' + line(s).replace(/\n/g, '\n    '));
      }
      console.log(n ? `\n${n} album name(s) shared by different artists.` : 'No album names shared by different artists.');
      break;
    }
    case 'set': {
      const [group, ...songs] = rest;
      if (!group || !songs.length) throw new Error('Usage: set <group> <song...>');
      for (const arg of songs) {
        const f = resolveSong(arg);
        writeGroup(f, group.trim());
        console.log('set: ' + line(await info(f)));
      }
      console.log('\nRestart Musicolet PC or use Settings → Rescan library to see the change.');
      break;
    }
    case 'clear': {
      if (!rest.length) throw new Error('Usage: clear <song...>');
      for (const arg of rest) {
        const f = resolveSong(arg);
        writeGroup(f, '');
        console.log('cleared: ' + line(await info(f)));
      }
      console.log('\nRestart Musicolet PC or use Settings → Rescan library to see the change.');
      break;
    }
    case 'show': {
      if (!rest.length) throw new Error('Usage: show <song...>');
      for (const arg of rest) console.log(line(await info(resolveSong(arg))));
      break;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  }
} catch (err) {
  console.error('Error: ' + err.message);
  process.exit(1);
}
