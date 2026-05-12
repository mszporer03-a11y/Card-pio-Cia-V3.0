/**
 * Electron main process — Cardápio Cia v3.0
 * Spawns the bundled Express server (cardapio-cia-build.exe) and opens a
 * native desktop window. No browser required.
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn }   = require('child_process');
const path        = require('path');
const net         = require('net');
const fs          = require('fs');

// Remove the default Electron menu bar (looks like a native desktop app).
Menu.setApplicationMenu(null);

const PORT = 3456;
let mainWindow   = null;
let serverProcess = null;

// ── Data directory ────────────────────────────────────────────────────────────
// PORTABLE_EXECUTABLE_DIR is set by electron-builder's portable builds;
// it is the directory where the user placed the .exe — ideal for persistent data.
function getDataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  return path.dirname(app.getPath('exe'));
}

// ── Server executable (bundled as an Electron resource) ──────────────────────
function getServerExe() {
  return path.join(process.resourcesPath, 'server', 'cardapio-cia-build.exe');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function ensureDataDirs(base) {
  ['data/images', 'data/uploads', 'output'].forEach(rel => {
    fs.mkdirSync(path.join(base, rel), { recursive: true });
  });
}

// Always copy bundled public/ to data dir so UI updates propagate on every new version.
function ensurePublic(dataDir) {
  const target  = path.join(dataDir, 'public');
  const bundled = path.join(process.resourcesPath, 'public');
  if (fs.existsSync(bundled)) {
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(bundled, target, { recursive: true, force: true });
  }
}

// Always copy bundled assets/ (logo, etc.) to data dir so updates propagate.
function ensureAssets(dataDir) {
  const target  = path.join(dataDir, 'assets');
  const bundled = path.join(process.resourcesPath, 'assets');
  if (fs.existsSync(bundled)) {
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(bundled, target, { recursive: true, force: true });
  }
}

// Wait for the Express server to accept connections on PORT.
function waitForServer(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.createConnection(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) return reject(new Error('Servidor não iniciou a tempo.'));
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

// If something is already listening on PORT (e.g., leftover process), skip spawn.
function isPortInUse(port) {
  return new Promise(resolve => {
    const socket = net.createConnection(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const dataDir   = getDataDir();
  const serverExe = getServerExe();

  ensureDataDirs(dataDir);
  ensurePublic(dataDir);
  ensureAssets(dataDir);

  try {
    const alreadyUp = await isPortInUse(PORT);

    if (!alreadyUp) {
      if (!fs.existsSync(serverExe)) {
        dialog.showErrorBox(
          'Cardápio Cia v3.0',
          `O servidor não foi encontrado em:\n${serverExe}\n\nReinicie o aplicativo a partir da pasta correta.`
        );
        app.quit();
        return;
      }

      serverProcess = spawn(serverExe, [], {
        cwd: dataDir,
        stdio: 'ignore',
        windowsHide: true,
        detached: false,
        env: { ...process.env, CARDAPIO_DATA_DIR: dataDir },
      });

      serverProcess.on('error', err => {
        console.error('Erro ao iniciar servidor:', err);
      });
    }

    await waitForServer(PORT);
  } catch (err) {
    dialog.showErrorBox('Cardápio Cia v3.0', `Não foi possível iniciar o servidor:\n${err.message}`);
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Cardápio Cia v3.0',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Prevent right-click context menu
  mainWindow.webContents.on('context-menu', (e) => { e.preventDefault(); });

  // Open external links in the system browser, not inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://localhost:${PORT}`)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
});

// ── Quit & cleanup ────────────────────────────────────────────────────────────
app.on('window-all-closed', () => {
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
  }
  app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
});
