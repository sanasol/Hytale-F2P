const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const JAVA_EXECUTABLE = 'java' + (process.platform === 'win32' ? '.exe' : '');

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

const DEFAULT_APP_DIR = getAppDir();
const CONFIG_FILE = path.join(DEFAULT_APP_DIR, 'config.json');

function getResolvedAppDir(customPath) {
  if (customPath && customPath.trim()) {
    return path.join(customPath.trim(), 'HytaleF2P');
  }
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.installPath && config.installPath.trim()) {
        return path.join(config.installPath.trim(), 'HytaleF2P');
      }
    }
  } catch (err) {
  }
  return DEFAULT_APP_DIR;
}

const APP_DIR = DEFAULT_APP_DIR;
const CACHE_DIR = path.join(APP_DIR, 'cache');
const TOOLS_DIR = path.join(APP_DIR, 'butler');
const GAME_DIR = path.join(APP_DIR, 'release', 'package', 'game', 'latest');
const JRE_DIR = path.join(APP_DIR, 'release', 'package', 'jre', 'latest');

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath === '~') {
    return os.homedir();
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

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
    createFolders();
    const config = loadConfig();
    const next = { ...config, ...update };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.log('Notice: could not save config:', err.message);
  }
}

async function findJavaOnPath(commandName = 'java') {
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(lookupCmd, [commandName]);
    const line = stdout.split(/\r?\n/).map(lineItem => lineItem.trim()).find(Boolean);
    return line || null;
  } catch (err) {
    return null;
  }
}

async function getMacJavaHome() {
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const { stdout } = await execFileAsync('/usr/libexec/java_home');
    const home = stdout.trim();
    if (!home) {
      return null;
    }
    return path.join(home, 'bin', JAVA_EXECUTABLE);
  } catch (err) {
    return null;
  }
}

async function resolveJavaPath(inputPath) {
  const trimmed = (inputPath || '').trim();
  if (!trimmed) {
    return null;
  }

  const expanded = expandHome(trimmed);
  if (fs.existsSync(expanded)) {
    const stat = fs.statSync(expanded);
    if (stat.isDirectory()) {
      const candidate = path.join(expanded, 'bin', JAVA_EXECUTABLE);
      return fs.existsSync(candidate) ? candidate : null;
    }
    return expanded;
  }

  if (!path.isAbsolute(expanded)) {
    return await findJavaOnPath(trimmed);
  }

  return null;
}

async function detectSystemJava() {
  const envHome = process.env.JAVA_HOME;
  if (envHome) {
    const envJava = path.join(envHome, 'bin', JAVA_EXECUTABLE);
    if (fs.existsSync(envJava)) {
      return envJava;
    }
  }

  const macJava = await getMacJavaHome();
  if (macJava && fs.existsSync(macJava)) {
    return macJava;
  }

  const pathJava = await findJavaOnPath('java');
  if (pathJava && fs.existsSync(pathJava)) {
    return pathJava;
  }

  return null;
}

async function getJavaDetection() {
  const candidates = [];
  const bundledJava = getBundledJavaPath() || path.join(JRE_DIR, 'bin', JAVA_EXECUTABLE);

  candidates.push({
    label: 'Bundled JRE',
    path: bundledJava,
    exists: fs.existsSync(bundledJava)
  });

  const javaHomeEnv = process.env.JAVA_HOME;
  if (javaHomeEnv) {
    const envJava = path.join(javaHomeEnv, 'bin', JAVA_EXECUTABLE);
    candidates.push({
      label: 'JAVA_HOME',
      path: envJava,
      exists: fs.existsSync(envJava),
      note: fs.existsSync(envJava) ? '' : 'Not found'
    });
  } else {
    candidates.push({
      label: 'JAVA_HOME',
      path: '',
      exists: false,
      note: 'Not set'
    });
  }

  if (process.platform === 'darwin') {
    const macJava = await getMacJavaHome();
    if (macJava) {
      candidates.push({
        label: 'java_home',
        path: macJava,
        exists: fs.existsSync(macJava),
        note: fs.existsSync(macJava) ? '' : 'Not found'
      });
    } else {
      candidates.push({
        label: 'java_home',
        path: '',
        exists: false,
        note: 'Not found'
      });
    }
  }

  const pathJava = await findJavaOnPath('java');
  if (pathJava) {
    candidates.push({
      label: 'PATH',
      path: pathJava,
      exists: true
    });
  } else {
    candidates.push({
      label: 'PATH',
      path: '',
      exists: false,
      note: 'java not found'
    });
  }

  return {
    javaPath: loadJavaPath(),
    candidates
  };
}

function getOS() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  return 'unknown';
}

function getArch() {
  return process.arch === 'x64' ? 'amd64' : process.arch;
}

function createFolders() {
  const configDir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

async function downloadFile(url, dest, progressCallback) {
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://launcher.hytale.com/'
    }
  });

  const totalSize = parseInt(response.headers['content-length'], 10);
  let downloaded = 0;
  const startTime = Date.now();

  const writer = fs.createWriteStream(dest);

  response.data.on('data', (chunk) => {
    downloaded += chunk.length;
    if (progressCallback && totalSize > 0) {
      const percent = Math.min(100, Math.max(0, (downloaded / totalSize) * 100));
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? downloaded / elapsed : 0;
      progressCallback(null, percent, speed, downloaded, totalSize);
    }
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });
}

async function installButler(toolsDir = TOOLS_DIR) {
  if (!fs.existsSync(toolsDir)) {
    fs.mkdirSync(toolsDir, { recursive: true });
  }
  
  const butlerName = process.platform === 'win32' ? 'butler.exe' : 'butler';
  const butlerPath = path.join(toolsDir, butlerName);
  const zipPath = path.join(toolsDir, 'butler.zip');

  if (fs.existsSync(butlerPath)) {
    return butlerPath;
  }

  let urls = [];
  const osName = getOS();
  const arch = getArch();
  if (osName === 'windows') {
    urls = ['https://broth.itch.zone/butler/windows-amd64/LATEST/archive/default'];
  } else if (osName === 'darwin') {
    if (arch === 'arm64') {
      urls = [
        'https://broth.itch.zone/butler/darwin-arm64/LATEST/archive/default',
        'https://broth.itch.zone/butler/darwin-amd64/LATEST/archive/default'
      ];
    } else {
      urls = ['https://broth.itch.zone/butler/darwin-amd64/LATEST/archive/default'];
    }
  } else if (osName === 'linux') {
    urls = ['https://broth.itch.zone/butler/linux-amd64/LATEST/archive/default'];
  } else {
    throw new Error('Operating system not supported');
  }

  console.log('Fetching Butler tool...');
  let lastError = null;
  for (const url of urls) {
    try {
      await downloadFile(url, zipPath);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }

  console.log('Unpacking Butler...');
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(toolsDir, true);

  if (process.platform !== 'win32') {
    fs.chmodSync(butlerPath, 0o755);
  }

  try {
    fs.unlinkSync(zipPath);
  } catch (err) {
    console.log('Notice: could not delete butler.zip');
  }

  return butlerPath;
}

async function downloadPWR(version = 'release', fileName = '1.pwr', progressCallback, cacheDir = CACHE_DIR) {
  const osName = getOS();
  const arch = getArch();
  const url = `https://game-patches.hytale.com/patches/${osName}/${arch}/${version}/0/${fileName}`;
  
  const dest = path.join(cacheDir, fileName);

  if (fs.existsSync(dest)) {
    console.log('PWR file found in cache:', dest);
    return dest;
  }

  console.log('Fetching PWR patch file:', url);
  await downloadFile(url, dest, progressCallback);
  console.log('PWR saved to:', dest);
  
  return dest;
}

async function applyPWR(pwrFile, progressCallback, gameDir = GAME_DIR, toolsDir = TOOLS_DIR) {
  const butlerPath = await installButler(toolsDir);
  const gameLatest = gameDir;
  const stagingDir = path.join(gameLatest, 'staging-temp');
  
  const clientPath = findClientPath(gameLatest);
  
  if (clientPath) {
    console.log('Game files detected, skipping patch installation.');
    return;
  }

  if (!fs.existsSync(gameLatest)) {
    fs.mkdirSync(gameLatest, { recursive: true });
  }
  if (!fs.existsSync(stagingDir)) {
    fs.mkdirSync(stagingDir, { recursive: true });
  }

  if (progressCallback) {
    progressCallback('Installing game patch...', null, null, null, null);
  }

  console.log('Installing game patch...');
  
  if (!fs.existsSync(butlerPath)) {
    throw new Error(`Butler tool not found at: ${butlerPath}`);
  }
  
  if (!fs.existsSync(pwrFile)) {
    throw new Error(`PWR file not found at: ${pwrFile}`);
  }

  const args = [
    'apply',
    '--staging-dir',
    stagingDir,
    pwrFile,
    gameLatest
  ];
  
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(butlerPath, args, {
        maxBuffer: 1024 * 1024 * 10,
        timeout: 600000
      }, (error, stdout, stderr) => {
        if (error) {
          console.error('Butler stderr:', stderr);
          console.error('Butler stdout:', stdout);
          reject(new Error(`Patch installation failed: ${error.message}${stderr ? '\n' + stderr : ''}`));
        } else {
          resolve();
        }
      });
    });
  } catch (error) {
    throw error;
  }

  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  if (progressCallback) {
    progressCallback('Installation complete', null, null, null, null);
  }
  console.log('Installation complete');
}

async function downloadJRE(progressCallback, cacheDir = CACHE_DIR, jreDir = JRE_DIR) {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  
  const osName = getOS();
  const arch = getArch();

  const bundledJava = getBundledJavaPath(jreDir);
  if (bundledJava) {
    console.log('Java runtime found, skipping download');
    return;
  }

  console.log('Requesting Java runtime information...');
  const response = await axios.get('https://launcher.hytale.com/version/release/jre.json', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  const jreData = response.data;

  const osData = jreData.download_url[osName];
  if (!osData) {
    throw new Error(`Java runtime unavailable for platform: ${osName}`);
  }

  const platform = osData[arch];
  if (!platform) {
    throw new Error(`Java runtime unavailable for architecture ${arch} on ${osName}`);
  }

  const fileName = path.basename(platform.url);
  const cacheFile = path.join(cacheDir, fileName);

  if (!fs.existsSync(cacheFile)) {
    if (progressCallback) {
      progressCallback('Fetching Java runtime...', null, null, null, null);
    }
    console.log('Fetching Java runtime...');
    await downloadFile(platform.url, cacheFile, progressCallback);
    console.log('Download finished');
  }

  if (progressCallback) {
    progressCallback('Validating files...', null, null, null, null);
  }
  console.log('Validating files...');
  const fileBuffer = fs.readFileSync(cacheFile);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  const hex = hashSum.digest('hex');
  
  if (hex !== platform.sha256) {
    fs.unlinkSync(cacheFile);
    throw new Error(`File validation failed: expected ${platform.sha256} but got ${hex}`);
  }

  if (progressCallback) {
    progressCallback('Unpacking Java runtime...', null, null, null, null);
  }
  console.log('Unpacking Java runtime...');
  await extractJRE(cacheFile, jreDir);

  if (process.platform !== 'win32') {
    const javaCandidates = [
      path.join(jreDir, 'bin', JAVA_EXECUTABLE),
      path.join(jreDir, 'Contents', 'Home', 'bin', JAVA_EXECUTABLE)
    ];
    for (const javaPath of javaCandidates) {
      if (fs.existsSync(javaPath)) {
        fs.chmodSync(javaPath, 0o755);
      }
    }
  }

  flattenJREDir(jreDir);

  try {
    fs.unlinkSync(cacheFile);
  } catch (err) {
    console.log('Notice: could not delete cached Java files:', err.message);
  }

  console.log('Java runtime ready');
}

async function extractJRE(archivePath, destDir) {
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  if (archivePath.endsWith('.zip')) {
    return extractZip(archivePath, destDir);
  } else if (archivePath.endsWith('.tar.gz')) {
    return extractTarGz(archivePath, destDir);
  } else {
    throw new Error(`Archive type not supported: ${archivePath}`);
  }
}

function extractZip(zipPath, dest) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  for (const entry of entries) {
    const entryPath = path.join(dest, entry.entryName);
    
    const resolvedPath = path.resolve(entryPath);
    const resolvedDest = path.resolve(dest);
    if (!resolvedPath.startsWith(resolvedDest)) {
      throw new Error(`Invalid file path detected: ${entryPath}`);
    }

    if (entry.isDirectory) {
      fs.mkdirSync(entryPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      fs.writeFileSync(entryPath, entry.getData());
      if (process.platform !== 'win32') {
        fs.chmodSync(entryPath, entry.header.attr >>> 16);
      }
    }
  }
}

function extractTarGz(tarGzPath, dest) {
  const tar = require('tar');
  return tar.extract({
    file: tarGzPath,
    cwd: dest,
    strip: 0
  });
}

function flattenJREDir(jreLatest) {
  try {
    const entries = fs.readdirSync(jreLatest, { withFileTypes: true });
    
    if (entries.length !== 1 || !entries[0].isDirectory()) {
      return;
    }

    const nested = path.join(jreLatest, entries[0].name);
    const files = fs.readdirSync(nested, { withFileTypes: true });

    for (const file of files) {
      const oldPath = path.join(nested, file.name);
      const newPath = path.join(jreLatest, file.name);
      fs.renameSync(oldPath, newPath);
    }

    fs.rmSync(nested, { recursive: true, force: true });
  } catch (err) {
    console.log('Notice: could not restructure Java directory:', err.message);
  }
}

function getBundledJavaPath(jreDir = JRE_DIR) {
  const candidates = [
    path.join(jreDir, 'bin', JAVA_EXECUTABLE)
  ];

  if (process.platform === 'darwin') {
    candidates.push(path.join(jreDir, 'Contents', 'Home', 'bin', JAVA_EXECUTABLE));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getJavaExec(jreDir = JRE_DIR) {
  const bundledJava = getBundledJavaPath(jreDir);
  if (bundledJava) {
    return bundledJava;
  }

  console.log('Notice: Java runtime not found, using system default');
  return 'java';
}

function getClientCandidates(gameLatest) {
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(gameLatest, 'Client', 'HytaleClient.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(gameLatest, 'Client', 'Hytale.app', 'Contents', 'MacOS', 'HytaleClient'));
    candidates.push(path.join(gameLatest, 'Client', 'HytaleClient'));
  } else {
    candidates.push(path.join(gameLatest, 'Client', 'HytaleClient'));
  }
  return candidates;
}

function findClientPath(gameLatest) {
  const candidates = getClientCandidates(gameLatest);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isGameInstalled() {
  const appDir = getResolvedAppDir();
  const gameDir = path.join(appDir, 'release', 'package', 'game', 'latest');
  const clientPath = findClientPath(gameDir);
  return clientPath !== null;
}

async function uninstallGame() {
  const appDir = getResolvedAppDir();
  
  if (!fs.existsSync(appDir)) {
    throw new Error('Game is not installed');
  }

  try {
    fs.rmSync(appDir, { recursive: true, force: true });
    console.log('Game uninstalled successfully - removed entire HytaleF2P folder');
    
    if (fs.existsSync(CONFIG_FILE)) {
      const config = loadConfig();
      delete config.installPath;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    }
  } catch (error) {
    throw new Error(`Failed to uninstall game: ${error.message}`);
  }
}

async function launchGame(playerName = 'Player', progressCallback, javaPathOverride, installPathOverride) {
  const customAppDir = getResolvedAppDir(installPathOverride);
  const customCacheDir = path.join(customAppDir, 'cache');
  const customToolsDir = path.join(customAppDir, 'butler');
  const customGameDir = path.join(customAppDir, 'release', 'package', 'game', 'latest');
  const customJreDir = path.join(customAppDir, 'release', 'package', 'jre', 'latest');
  
  [customAppDir, customCacheDir, customToolsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
  
  saveUsername(playerName);
  if (installPathOverride) {
    saveInstallPath(installPathOverride);
  }

  const configuredJava = (javaPathOverride !== undefined && javaPathOverride !== null
    ? javaPathOverride
    : loadJavaPath() || '').trim();
  let javaBin = null;

  if (configuredJava) {
    javaBin = await resolveJavaPath(configuredJava);
    if (!javaBin) {
      throw new Error(`Configured Java path not found: ${configuredJava}`);
    }
  } else {
    try {
      await downloadJRE(progressCallback, customCacheDir, customJreDir);
    } catch (error) {
      const fallback = await detectSystemJava();
      if (fallback) {
        javaBin = fallback;
      } else {
        throw error;
      }
    }

    if (!javaBin) {
      javaBin = getJavaExec(customJreDir);
    }
  }

  const gameLatest = customGameDir;
  let clientPath = findClientPath(gameLatest);

  if (!clientPath) {
    if (progressCallback) {
      progressCallback('Fetching game files...', null, null, null, null);
    }
    console.log('Game files missing, downloading and installing patch...');
    const pwrFile = await downloadPWR('release', '1.pwr', progressCallback, customCacheDir);
    await applyPWR(pwrFile, progressCallback, customGameDir, customToolsDir);
  }

  clientPath = findClientPath(gameLatest);
  if (!clientPath) {
    const attempted = getClientCandidates(gameLatest).join(', ');
    throw new Error(`Game client missing. Tried: ${attempted}`);
  }

  const uuid = getUuidForUser(playerName);
  const args = [
    '--app-dir', gameLatest,
    '--java-exec', javaBin,
    '--auth-mode', 'offline',
    '--uuid', uuid,
    '--name', playerName
  ];

  if (progressCallback) {
    progressCallback('Starting game...', null, null, null, null);
  }
  console.log('Starting game...');
  console.log(`Command: "${clientPath}" ${args.join(' ')}`);
  
  const child = exec(`"${clientPath}" ${args.map(a => `"${a}"`).join(' ')}`, {
    stdio: 'inherit',
    detached: true
  });

  child.unref();
}

function saveUsername(username) {
  saveConfig({ username: username || 'Player' });
}

function loadUsername() {
  const config = loadConfig();
  return config.username || 'Player';
}

function getUuidForUser(username) {
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

module.exports = {
  launchGame,
  saveUsername,
  loadUsername,
  saveJavaPath,
  loadJavaPath,
  saveInstallPath,
  loadInstallPath,
  isGameInstalled,
  uninstallGame,
  getJavaDetection
};
