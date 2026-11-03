const { contextBridge, ipcRenderer } = require('electron');
const { io } = require('socket.io-client');

let socket = null;
const listeners = {};
const fire = (ev, ...args) => (listeners[ev] || []).forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } });
ipcRenderer.on('deeplink', (_e, url) => fire('deeplink', url));

contextBridge.exposeInMainWorld('chat', {
  on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },

  connect(url, token) {
    return new Promise(resolve => {
      if (socket) socket.disconnect();
      let first = true;
      try { socket = io(url, { auth: { token }, timeout: 60000, reconnectionDelay: 1000, reconnectionDelayMax: 5000 }); }
      catch { return resolve({ ok: false, error: 'Invalid server URL' }); }

      socket.on('connect_error', err => {
        if (!first) return;
        first = false;
        const unauthorized = err && err.message === 'unauthorized';
        socket.disconnect();
        resolve({ ok: false, unauthorized, error: unauthorized ? 'Session expired, please log in again' : 'Cannot reach server. Check the URL and try again (a sleeping free server can take ~1 minute to wake up).' });
      });
      socket.on('connect', () => { if (first) { first = false; resolve({ ok: true }); } else fire('status', 'online'); });
      socket.on('disconnect', () => fire('status', 'offline'));
      socket.onAny((ev, ...args) => fire(ev, ...args));
    });
  },

  // request/response (server acknowledges)
  request(ev, data) {
    return new Promise(resolve => {
      if (!socket || !socket.connected) return resolve({ ok: false, error: 'Not connected to server' });
      const t = setTimeout(() => resolve({ ok: false, error: 'Request timed out' }), 20000);
      socket.emit(ev, data || {}, res => { clearTimeout(t); resolve(res || { ok: false, error: 'No response' }); });
    });
  },
  // fire-and-forget
  emit(ev, data) { if (socket && socket.connected) socket.emit(ev, data || {}); },

  disconnect() { if (socket) { socket.disconnect(); socket = null; } }
});
