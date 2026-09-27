const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Library, trackId } = require('./library');
const { registerSchemes, handleProtocol } = require('./protocol');
const { DiscordPresence } = require('./discord');

const discord = new DiscordPresence();

registerSchemes();

// Optional: keep the library/settings in a custom folder (e.g. for a portable install).
if (process.env.MUSICOLET_PC_DATA) app.setPath('userData', path.resolve(process.env.MUSICOLET_PC_DATA));

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
let win = null;
let library = null;

const userFile = (name) => path.join(app.getPath('userData'), name);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function createWindow() {
  const saved = readJson(userFile('window.json'), {});
  win = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 800,
    x: saved.x,
    y: saved.y,
    minWidth: 940,
    minHeight: 600,
    title: 'Musicolet PC',
    backgroundColor: '#121214',
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    const b = win.getNormalBounds();
    writeJson(userFile('window.json'), { ...b, maximized: win.isMaximized() });
  });
  // Links should never navigate the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadURL('mco://app/index.html');
}

function registerIpc() {
  ipcMain.handle('state:load', () => readJson(userFile('state.json'), null));
  ipcMain.handle('state:save', (_e, state) => writeJson(userFile('state.json'), state));
  ipcMain.on('state:saveSync', (e, state) => {
    try {
      writeJson(userFile('state.json'), state);
    } finally {
      e.returnValue = true;
    }
  });

  ipcMain.handle('library:get', () => library.get());
  ipcMain.handle('library:addFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add music folder',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return library.addRoots(res.filePaths);
  });
  ipcMain.handle('library:removeFolder', (_e, dir) => library.removeRoot(dir));
  ipcMain.handle('library:scan', (e) =>
    library.scan((p) => {
      if (!e.sender.isDestroyed()) e.sender.send('library:progress', p);
    }),
  );

  ipcMain.handle('track:details', (_e, id) => library.details(id));
  ipcMain.handle('track:lyrics', (_e, id) => library.lyrics(id));
  ipcMain.handle('track:writeTags', async (_e, ids, changes) => {
    try {
      return await library.writeTags(ids, changes);
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });
  ipcMain.handle('track:trash', async (_e, ids) => {
    const removed = [];
    for (const id of ids) {
      const t = library.get().tracks[id];
      if (!t) continue;
      try {
        await shell.trashItem(t.path);
        removed.push(id);
      } catch {
        // leave it in the library if it could not be moved
      }
    }
    library.removeTracks(removed);
    return removed;
  });

  ipcMain.handle('discord:configure', (_e, cfg) => discord.configure(cfg));
  ipcMain.handle('discord:status', () => discord.status());
  ipcMain.on('discord:update', (_e, np) => discord.update(np));

  ipcMain.handle('shell:showInFolder', (_e, file) => shell.showItemInFolder(file));

  ipcMain.handle('dialog:pickImage', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose album art',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const file = res.filePaths[0];
    const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    return { path: file, dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` };
  });

  ipcMain.handle('cover:save', async (_e, coverName, suggested) => {
    const src = path.join(library.coverDir, path.basename(coverName));
    if (!fs.existsSync(src)) return false;
    const ext = path.extname(src);
    const res = await dialog.showSaveDialog(win, {
      title: 'Save album art',
      defaultPath: (suggested || 'cover').replace(/[\\/:*?"<>|]/g, '_') + ext,
    });
    if (res.canceled || !res.filePath) return false;
    fs.copyFileSync(src, res.filePath);
    return true;
  });

  ipcMain.handle('playlist:export', async (_e, name, ids) => {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export playlist',
      defaultPath: name.replace(/[\\/:*?"<>|]/g, '_') + '.m3u8',
      filters: [{ name: 'M3U playlist', extensions: ['m3u8', 'm3u'] }],
    });
    if (res.canceled || !res.filePath) return false;
    const tracks = library.get().tracks;
    const lines = ['#EXTM3U'];
    for (const id of ids) {
      const t = tracks[id];
      if (!t) continue;
      lines.push(`#EXTINF:${Math.round(t.duration || -1)},${t.artist ? t.artist + ' - ' : ''}${t.title}`);
      lines.push(t.path);
    }
    fs.writeFileSync(res.filePath, lines.join('\r\n') + '\r\n', 'utf8');
    return true;
  });

  ipcMain.handle('playlist:import', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Import playlist',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'M3U playlist', extensions: ['m3u8', 'm3u'] }],
    });
    if (res.canceled) return [];
    return res.filePaths.map((file) => {
      const base = path.dirname(file);
      const ids = fs
        .readFileSync(file, 'utf8')
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => trackId(path.resolve(base, l.replace(/^file:\/\/\/?/, ''))));
      return { name: path.basename(file, path.extname(file)), ids };
    });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Lets Windows group the taskbar button and pinned shortcut under our own icon instead of Electron's.
  if (process.platform === 'win32') app.setAppUserModelId('com.mistershenterry.musicoletpc');

  app.whenReady().then(() => {
    library = new Library(app.getPath('userData'));
    handleProtocol({
      rendererDir: RENDERER_DIR,
      coverDir: library.coverDir,
      isAllowedMedia: (file) => library.isAllowedMedia(file),
    });
    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());

  let presenceCleared = false;
  app.on('before-quit', (e) => {
    if (presenceCleared) return;
    presenceCleared = true;
    e.preventDefault();
    // Remove the "Listening to" status before exiting (don't wait more than a second).
    Promise.race([discord.disconnect(), new Promise((r) => setTimeout(r, 1000))]).finally(() => app.quit());
  });
}
