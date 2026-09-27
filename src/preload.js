const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  saveStateSync: (state) => ipcRenderer.sendSync('state:saveSync', state),

  getLibrary: () => ipcRenderer.invoke('library:get'),
  addFolder: () => ipcRenderer.invoke('library:addFolder'),
  removeFolder: (dir) => ipcRenderer.invoke('library:removeFolder', dir),
  scan: () => ipcRenderer.invoke('library:scan'),
  onScanProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('library:progress', handler);
    return () => ipcRenderer.removeListener('library:progress', handler);
  },

  details: (id) => ipcRenderer.invoke('track:details', id),
  lyrics: (id) => ipcRenderer.invoke('track:lyrics', id),
  writeTags: (ids, changes) => ipcRenderer.invoke('track:writeTags', ids, changes),
  trash: (ids) => ipcRenderer.invoke('track:trash', ids),

  discordConfigure: (cfg) => ipcRenderer.invoke('discord:configure', cfg),
  discordStatus: () => ipcRenderer.invoke('discord:status'),
  discordUpdate: (np) => ipcRenderer.send('discord:update', np),

  showInFolder: (file) => ipcRenderer.invoke('shell:showInFolder', file),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  saveCover: (cover, name) => ipcRenderer.invoke('cover:save', cover, name),
  exportPlaylist: (name, ids) => ipcRenderer.invoke('playlist:export', name, ids),
  importPlaylist: () => ipcRenderer.invoke('playlist:import'),

  mediaUrl: (file) => 'mco://media/' + encodeURIComponent(file),
  coverUrl: (name) => (name ? 'mco://cover/' + encodeURIComponent(name) : ''),
});
