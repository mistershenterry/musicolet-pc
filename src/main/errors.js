// Error codes the app shows when something online fails:
//   277 = no internet (the request never reached the server)
//    -1 = the server is down (it answered with an error, e.g. the Song Library used up its free requests for the day)
//   429 = this connection is sending too much (the Song Library server's per-connection limit)
const OFFLINE = 277;
const DOWN = -1;
const LIMITED = 429;

// A request that never got an answer: Chromium's net::ERR_… errors and Node's socket errors.
const isNetworkError = (err) =>
  /net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|Failed to fetch/i.test(String(err?.message || err));

const SONG_LIBRARY = {
  [OFFLINE]: "Couldn't fetch Song Library information, please check your internet connection!",
  [DOWN]: 'Song Library is down. Check in tomorrow!',
  [LIMITED]: "You're doing that too fast. Wait a minute and try again.",
};

const UPDATES = {
  [OFFLINE]: "Couldn't fetch update information, please check your internet connection!",
  [DOWN]: 'Update server is down. Try again later!',
};

const failure = (messages, code) => ({ code, message: messages[code] });

// The Song Library server's answer, as a failure (or null when it's fine). 404 is up to the caller.
function songLibraryFailure(res) {
  if (res.ok || res.status === 404) return null;
  // The server's own per-connection limit (marked by this header), not an outage.
  if (res.status === 429 && res.headers.get('x-musicolet-limit')) return failure(SONG_LIBRARY, LIMITED);
  return failure(SONG_LIBRARY, DOWN);
}

const songLibraryOffline = () => failure(SONG_LIBRARY, OFFLINE);

const updateFailure = (err) => failure(UPDATES, isNetworkError(err) ? OFFLINE : DOWN);

module.exports = { OFFLINE, DOWN, LIMITED, isNetworkError, songLibraryFailure, songLibraryOffline, updateFailure };
