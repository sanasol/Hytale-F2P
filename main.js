const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { launchGame, saveUsername, loadUsername, saveJavaPath, loadJavaPath, saveInstallPath, loadInstallPath, isGameInstalled, uninstallGame } = require('./backend/launcher');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#090909',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
      webSecurity: true
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools();
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      event.preventDefault();
    }
    if (input.control && input.shift && input.key.toLowerCase() === 'j') {
      event.preventDefault();
    }
    if (input.control && input.shift && input.key.toLowerCase() === 'c') {
      event.preventDefault();
    }
    if (input.key === 'F12') {
      event.preventDefault();
    }
    if (input.key === 'F5') {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('context-menu', (e) => {
    e.preventDefault();
  });

  mainWindow.webContents.setIgnoreMenuShortcuts(true);
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('launch-game', async (event, playerName, javaPath, installPath) => {
  try {
    const progressCallback = (message, percent, speed, downloaded, total) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const data = {
          message: message || null,
          percent: percent !== null && percent !== undefined ? Math.min(100, Math.max(0, percent)) : null,
          speed: speed !== null && speed !== undefined ? speed : null,
          downloaded: downloaded !== null && downloaded !== undefined ? downloaded : null,
          total: total !== null && total !== undefined ? total : null
        };
        mainWindow.webContents.send('progress-update', data);
      }
    };

    await launchGame(playerName, progressCallback, javaPath, installPath);
    
    return { success: true };
  } catch (error) {
    console.error('Launch error:', error);
    const errorMessage = error.message || error.toString();
    return { success: false, error: errorMessage };
  }
});

ipcMain.handle('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('save-username', (event, username) => {
  saveUsername(username);
  return { success: true };
});

ipcMain.handle('load-username', () => {
  return loadUsername();
});

ipcMain.handle('save-java-path', (event, javaPath) => {
  saveJavaPath(javaPath);
  return { success: true };
});

ipcMain.handle('load-java-path', () => {
  return loadJavaPath();
});

ipcMain.handle('save-install-path', (event, installPath) => {
  saveInstallPath(installPath);
  return { success: true };
});

ipcMain.handle('load-install-path', () => {
  return loadInstallPath();
});

ipcMain.handle('select-install-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Installation Folder'
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('is-game-installed', () => {
  return isGameInstalled();
});

ipcMain.handle('uninstall-game', async () => {
  try {
    await uninstallGame();
    return { success: true };
  } catch (error) {
    console.error('Uninstall error:', error);
    return { success: false, error: error.message };
  }
});
