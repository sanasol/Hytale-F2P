const fs = require('fs');
const path = require('path');
const os = require('os');

// Default auth domain - can be overridden by env var or config
const DEFAULT_AUTH_DOMAIN = 'sanasol.ws';

// Get auth domain from env, config, or default
function getAuthDomain() {
  // First check environment variable
  if (process.env.HYTALE_AUTH_DOMAIN) {
    return process.env.HYTALE_AUTH_DOMAIN;
  }
  // Then check config file
  const config = loadConfig();
  if (config.authDomain) {
    return config.authDomain;
  }
  // Fall back to default
  return DEFAULT_AUTH_DOMAIN;
}

// Get full auth server URL
function getAuthServerUrl() {
  const domain = getAuthDomain();
  return `https://sessions.${domain}`;
}

// Save auth domain to config
function saveAuthDomain(domain) {
  saveConfig({ authDomain: domain || DEFAULT_AUTH_DOMAIN });
}

function getAppDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'HytaleF2P');
  } else if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'HytaleF2P');
  } else {
    return path.join(home, '.hytalef2p');
  }
}

const CONFIG_FILE = path.join(getAppDir(), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.log('Notice: could not load config:', err.message);
  }
  return {};
}

function saveConfig(update) {
  try {
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    const config = loadConfig();
    const next = { ...config, ...update };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.log('Notice: could not save config:', err.message);
  }
}

function saveUsername(username) {
  saveConfig({ username: username || 'Player' });
}

function loadUsername() {
  const config = loadConfig();
  return config.username || 'Player';
}

function saveChatUsername(chatUsername) {
  saveConfig({ chatUsername: chatUsername || '' });
}

function loadChatUsername() {
  const config = loadConfig();
  return config.chatUsername || '';
}

function getUuidForUser(username) {
  const { v4: uuidv4 } = require('uuid');
  const config = loadConfig();
  const userUuids = config.userUuids || {};

  if (userUuids[username]) {
    return userUuids[username];
  }

  const newUuid = uuidv4();
  userUuids[username] = newUuid;
  saveConfig({ userUuids });

  return newUuid;
}

function saveJavaPath(javaPath) {
  const trimmed = (javaPath || '').trim();
  saveConfig({ javaPath: trimmed });
}

function loadJavaPath() {
  const config = loadConfig();
  return config.javaPath || '';
}

function saveInstallPath(installPath) {
  const trimmed = (installPath || '').trim();
  saveConfig({ installPath: trimmed });
}

function loadInstallPath() {
  const config = loadConfig();
  return config.installPath || '';
}

function saveModsToConfig(mods) {
  try {
    let config = loadConfig();
    config.installedMods = mods;
    
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('Mods saved to config.json');
  } catch (error) {
    console.error('Error saving mods to config:', error);
  }
}

function loadModsFromConfig() {
  try {
    const config = loadConfig();
    return config.installedMods || [];
  } catch (error) {
    console.error('Error loading mods from config:', error);
    return [];
  }
}

function isFirstLaunch() {
  const config = loadConfig();
  
  if ('hasLaunchedBefore' in config) {
    return !config.hasLaunchedBefore;
  }
  
  const hasUserData = config.installPath || config.username || config.javaPath || 
                      config.chatUsername || config.userUuids || 
                      Object.keys(config).length > 0;
  
  if (!hasUserData) {
    return true;
  }
  
  return true;
}

function markAsLaunched() {
  saveConfig({ hasLaunchedBefore: true, firstLaunchDate: new Date().toISOString() });
}

module.exports = {
  loadConfig,
  saveConfig,
  saveUsername,
  loadUsername,
  saveChatUsername,
  loadChatUsername,
  getUuidForUser,
  saveJavaPath,
  loadJavaPath,
  saveInstallPath,
  loadInstallPath,
  saveModsToConfig,
  loadModsFromConfig,
  isFirstLaunch,
  markAsLaunched,
  CONFIG_FILE,
  // Auth domain config
  DEFAULT_AUTH_DOMAIN,
  getAuthDomain,
  getAuthServerUrl,
  saveAuthDomain
};
