// Finds a public album-cover URL for Discord Rich Presence. Discord can't display local files, so
// covers are looked up by artist + album (or artist + title) on iTunes, with Deezer as a fallback.
// Only used while Discord status is on and cover lookup is enabled. Results are cached on disk.
const fs = require('fs');

const TIMEOUT_MS = 6000;
const MISS_RETRY_MS = 7 * 24 * 3600 * 1000; // look up "not found" songs again after a week

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ') // "(Remastered)", "[Deluxe]"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// Loose match: one name contains the other after normalizing.
function same(a, b) {
  let x = norm(a);
  let y = norm(b);
  if (!x || !y) {
    // Names made only of brackets/symbols, e.g. the album "(III)": compare them as written.
    x = String(a || '').trim().toLowerCase();
    y = String(b || '').trim().toLowerCase();
    return !!x && x === y;
  }
  if (x === y) return true;
  // "contains" only for names long enough not to match by accident
  return Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x));
}

// Artists match if either name matches, also when a song lists several ("A, B" / "A feat. B").
function sameArtist(found, ours) {
  if (same(found, ours) || same(found, cleanArtist(ours))) return true;
  return String(ours || '')
    .split(/,|&|;|\bfeat\.?|\bft\.?|\bx\b/i)
    .some((part) => part.trim() && same(found, part.trim()));
}

// Search terms without YouTube-style noise: "Camellia Official" -> "Camellia", "[FREE DL] Song [Genre]" -> "Song".
const cleanArtist = (s) => String(s || '').replace(/\s*(-\s*topic|official|vevo|music)\s*$/i, '').trim() || String(s || '');
const cleanTerm = (s) => norm(s) || String(s || '');

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function fromItunes({ artist, album, title }) {
  const byAlbum = !!album;
  const term = encodeURIComponent(`${cleanArtist(artist)} ${cleanTerm(byAlbum ? album : title)}`);
  const data = await getJson(`https://itunes.apple.com/search?term=${term}&entity=${byAlbum ? 'album' : 'song'}&limit=15`);
  const hit = (data.results || []).find(
    (r) => sameArtist(r.artistName, artist) && (byAlbum ? same(r.collectionName, album) : same(r.trackName, title)),
  );
  return hit?.artworkUrl100 ? hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null;
}

async function fromDeezer({ artist, album, title }) {
  const q = (s) => String(s).replace(/"/g, '');
  const a = q(cleanArtist(artist));
  if (album) {
    const data = await getJson(`https://api.deezer.com/search/album?q=${encodeURIComponent(`artist:"${a}" album:"${q(cleanTerm(album))}"`)}`);
    const hit = (data.data || []).find((r) => sameArtist(r.artist?.name, artist) && same(r.title, album));
    return hit?.cover_xl || hit?.cover_big || null;
  }
  const data = await getJson(`https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${a}" track:"${q(cleanTerm(title))}"`)}`);
  const hit = (data.data || []).find((r) => sameArtist(r.artist?.name, artist) && same(r.title, title));
  return hit?.album?.cover_xl || hit?.album?.cover_big || null;
}

class CoverLookup {
  constructor(cacheFile) {
    this.file = cacheFile;
    this.pending = new Map();
    try {
      this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      this.cache = {};
    }
  }

  key({ artist, album, title }) {
    return norm(artist) + '|' + (album ? 'a:' + norm(album) : 't:' + norm(title));
  }

  // Cached result without hitting the network: a URL, null (known miss), or undefined (unknown).
  peek(song) {
    const hit = this.cache[this.key(song)];
    if (!hit) return undefined;
    if (!hit.url && Date.now() - hit.at > MISS_RETRY_MS) return undefined;
    return hit.url || null;
  }

  async find(song) {
    // Without an artist the search would match the wrong songs too often.
    if (!song.artist || (!song.album && !song.title)) return null;
    const cached = this.peek(song);
    if (cached !== undefined) return cached;
    const key = this.key(song);
    if (this.pending.has(key)) return this.pending.get(key);
    const job = (async () => {
      let url = null;
      let failed = false;
      for (const source of [fromItunes, fromDeezer]) {
        try {
          url = await source(song);
          if (url) break;
        } catch {
          failed = true; // offline or rate-limited: don't remember this as a miss
        }
      }
      if (url || !failed) {
        this.cache[key] = { url, at: Date.now() };
        this.save();
      }
      return url;
    })();
    this.pending.set(key, job);
    try {
      return await job;
    } finally {
      this.pending.delete(key);
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.cache));
    } catch {
      // cache is only an optimization
    }
  }
}

module.exports = { CoverLookup };
