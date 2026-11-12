// Custom "mco://" protocol.
//  mco://app/<file>      -> UI files from src/renderer
//  mco://media/<path>    -> audio files inside the library folders (supports Range requests for seeking)
//  mco://cover/<name>    -> cached album art
// Serving everything from one origin lets Web Audio (the equalizer) read the audio samples.
const { protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.weba': 'audio/webm',
};

function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'mco',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ]);
}

async function serveFile(file, request) {
  let st;
  try {
    st = await fs.promises.stat(file);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  };
  const range = request.headers.get('range');
  if (range && st.size > 0) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = 0;
    let end = st.size - 1;
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, st.size - parseInt(m[2], 10));
      } else {
        if (m[1] !== '') start = parseInt(m[1], 10);
        if (m[2] !== '') end = Math.min(parseInt(m[2], 10), st.size - 1);
      }
    }
    if (start >= st.size || end < start) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
  }
  headers['Content-Length'] = String(st.size);
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
}

function isInside(dir, file) {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// A downloaded song: decrypted on the fly from the vault, with Range support so seeking works.
async function serveVault(file, info, vault, request) {
  let size;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers = {
    'Content-Type': MIME['.' + info.ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  };
  let start = 0;
  let end = size - 1;
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (m && size > 0) {
    if (m[1] === '' && m[2] !== '') start = Math.max(0, size - parseInt(m[2], 10));
    else {
      if (m[1] !== '') start = parseInt(m[1], 10);
      if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
    }
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  return new Response(vault.stream(file, info.iv, start, end), { status: m ? 206 : 200, headers });
}

function handleProtocol({ rendererDir, coverDir, isAllowedMedia, vaultInfo, vault, songCover }) {
  protocol.handle('mco', (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    if (url.host === 'app') {
      const rel = pathname.replace(/^\/+/, '') || 'index.html';
      const full = path.resolve(rendererDir, rel);
      if (!isInside(rendererDir, full)) return new Response('Forbidden', { status: 403 });
      return serveFile(full, request);
    }
    if (url.host === 'media') {
      const file = pathname.replace(/^\/+/, '');
      if (!isAllowedMedia(file)) return new Response('Forbidden', { status: 403 });
      const info = vaultInfo?.(file);
      if (info) return serveVault(file, info, vault, request);
      return serveFile(file, request);
    }
    if (url.host === 'libcover' && songCover) {
      // Song Library covers: fetched from the Song Library server, cached on disk.
      return songCover(pathname.replace(/^\/+/, '')).then((file) => (file ? serveFile(file, request) : new Response('Not found', { status: 404 })));
    }
    if (url.host === 'cover') {
      return serveFile(path.join(coverDir, path.basename(pathname)), request);
    }
    return new Response('Not found', { status: 404 });
  });
}

module.exports = { registerSchemes, handleProtocol };
