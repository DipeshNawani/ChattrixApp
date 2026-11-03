const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');

// Run several copies on one PC for testing:  npm run start:user2  (separate login/profile)
const profileArg = process.argv.find(a => a.startsWith('--profile='));
if (profileArg) app.setPath('userData', path.join(app.getPath('appData'), 'Chattrix-' + profileArg.split('=')[1]));

const PROTO = 'chattrix';
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTO, process.execPath, [path.resolve(process.argv[1])]);
} else app.setAsDefaultProtocolClient(PROTO);

let win = null;
let pendingLink = process.argv.find(a => a.startsWith(PROTO + '://')) || null;
const sendLink = url => { if (win && !win.webContents.isLoading()) win.webContents.send('deeplink', url); else pendingLink = url; };
app.on('open-url', (e, url) => { e.preventDefault(); sendLink(url); }); // macOS

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 780, minWidth: 820, minHeight: 540,
    backgroundColor: '#0f0f10', title: 'Chattrix', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      sandbox: false // preload needs require('socket.io-client')
    }
  });
  win.loadFile('index.html');
  win.webContents.on('did-finish-load', () => { if (pendingLink) { win.webContents.send('deeplink', pendingLink); pendingLink = null; } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  const allowed = ['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'];
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.includes(perm));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
