const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

// Domain configuration
const ORIGINAL_DOMAIN = 'hytale.com';

// Get target domain from config or environment
function getTargetDomain() {
  // Check environment variable first
  if (process.env.HYTALE_AUTH_DOMAIN) {
    return process.env.HYTALE_AUTH_DOMAIN;
  }
  // Try to load from config
  try {
    const { getAuthDomain } = require('../core/config');
    return getAuthDomain();
  } catch (e) {
    // Config not available, use default
    return 'sanasol.ws';
  }
}

// Default domain - must be exactly 10 characters (same as hytale.com)
const DEFAULT_NEW_DOMAIN = 'sanasol.ws';

/**
 * Patches HytaleClient and HytaleServer binaries to replace hytale.com with custom domain
 * This allows the game to connect to a custom authentication server
 */
class ClientPatcher {
  constructor() {
    this.patchedFlag = '.patched_custom';
  }

  /**
   * Get the target domain for patching
   */
  getNewDomain() {
    const domain = getTargetDomain();
    // Validate domain length matches original
    if (domain.length !== ORIGINAL_DOMAIN.length) {
      console.warn(`Warning: Domain "${domain}" length (${domain.length}) doesn't match original "${ORIGINAL_DOMAIN}" (${ORIGINAL_DOMAIN.length})`);
      console.warn(`Using default domain: ${DEFAULT_NEW_DOMAIN}`);
      return DEFAULT_NEW_DOMAIN;
    }
    return domain;
  }

  /**
   * Convert a string to UTF-16LE bytes (how .NET stores strings)
   */
  stringToUtf16LE(str) {
    const buf = Buffer.alloc(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      buf.writeUInt16LE(str.charCodeAt(i), i * 2);
    }
    return buf;
  }

  /**
   * Convert a string to UTF-8 bytes (how Java stores strings)
   */
  stringToUtf8(str) {
    return Buffer.from(str, 'utf8');
  }

  /**
   * Find all occurrences of a pattern in a buffer
   */
  findAllOccurrences(buffer, pattern) {
    const positions = [];
    let pos = 0;
    while (pos < buffer.length) {
      const index = buffer.indexOf(pattern, pos);
      if (index === -1) break;
      positions.push(index);
      pos = index + 1;
    }
    return positions;
  }

  /**
   * UTF-8 domain replacement for Java JAR files.
   * Java stores strings in UTF-8 format in the constant pool.
   */
  findAndReplaceDomainUtf8(data, oldDomain, newDomain) {
    let count = 0;
    const result = Buffer.from(data);

    const oldUtf8 = this.stringToUtf8(oldDomain);
    const newUtf8 = this.stringToUtf8(newDomain);

    // Find all occurrences of the domain
    const positions = this.findAllOccurrences(result, oldUtf8);

    for (const pos of positions) {
      // Replace the domain
      newUtf8.copy(result, pos);
      count++;
      console.log(`  Patched UTF-8 occurrence at offset 0x${pos.toString(16)}`);
    }

    return { buffer: result, count };
  }

  /**
   * Smart domain replacement that handles both null-terminated and non-null-terminated strings.
   * .NET AOT stores some strings in various formats:
   * - Standard UTF-16LE (each char is 2 bytes with \x00 high byte)
   * - Length-prefixed where last char may have metadata byte instead of \x00
   */
  findAndReplaceDomainSmart(data, oldDomain, newDomain) {
    let count = 0;
    const result = Buffer.from(data);

    // Get UTF-16LE bytes without the last character
    const oldUtf16NoLast = this.stringToUtf16LE(oldDomain.slice(0, -1));
    const newUtf16NoLast = this.stringToUtf16LE(newDomain.slice(0, -1));
    const oldLastChar = this.stringToUtf16LE(oldDomain.slice(-1));
    const newLastChar = this.stringToUtf16LE(newDomain.slice(-1));

    // ASCII code of last characters
    const oldLastCharByte = oldDomain.charCodeAt(oldDomain.length - 1);
    const newLastCharByte = newDomain.charCodeAt(newDomain.length - 1);

    // Find all occurrences of the domain without the last character
    const positions = this.findAllOccurrences(result, oldUtf16NoLast);

    for (const pos of positions) {
      // Check if we have the last character following
      const lastCharPos = pos + oldUtf16NoLast.length;
      if (lastCharPos + 1 > result.length) continue;

      // Read the byte at last char position
      const lastCharFirstByte = result[lastCharPos];

      // Check if first byte matches the last character of old domain
      if (lastCharFirstByte === oldLastCharByte) {
        // Replace all but last character
        newUtf16NoLast.copy(result, pos);

        // Replace just the first byte of the last character (preserve metadata byte if any)
        result[lastCharPos] = newLastCharByte;

        // If there's a proper null byte (standard UTF-16LE), also check/preserve it
        if (lastCharPos + 1 < result.length) {
          const secondByte = result[lastCharPos + 1];
          // Log what type of occurrence this is
          if (secondByte === 0x00) {
            console.log(`  Patched UTF-16LE occurrence at offset 0x${pos.toString(16)}`);
          } else {
            console.log(`  Patched length-prefixed occurrence at offset 0x${pos.toString(16)} (metadata: 0x${secondByte.toString(16)})`);
          }
        }
        count++;
      }
    }

    return { buffer: result, count };
  }

  /**
   * Check if the client binary has already been patched
   */
  isPatchedAlready(clientPath) {
    const newDomain = this.getNewDomain();
    const patchFlagFile = clientPath + this.patchedFlag;
    if (fs.existsSync(patchFlagFile)) {
      try {
        const flagData = JSON.parse(fs.readFileSync(patchFlagFile, 'utf8'));
        // Check if patched with same target domain
        if (flagData.targetDomain === newDomain) {
          return true;
        }
      } catch (e) {
        // Flag file corrupted, will re-patch
      }
    }
    return false;
  }

  /**
   * Mark the client as patched
   */
  markAsPatched(clientPath) {
    const newDomain = this.getNewDomain();
    const patchFlagFile = clientPath + this.patchedFlag;
    const flagData = {
      patchedAt: new Date().toISOString(),
      originalDomain: ORIGINAL_DOMAIN,
      targetDomain: newDomain,
      patcherVersion: '1.0.0'
    };
    fs.writeFileSync(patchFlagFile, JSON.stringify(flagData, null, 2));
  }

  /**
   * Create a backup of the original client binary
   */
  backupClient(clientPath) {
    const backupPath = clientPath + '.original';
    if (!fs.existsSync(backupPath)) {
      console.log(`  Creating backup at ${path.basename(backupPath)}`);
      fs.copyFileSync(clientPath, backupPath);
      return backupPath;
    }
    console.log('  Backup already exists');
    return backupPath;
  }

  /**
   * Restore the original client binary from backup
   */
  restoreClient(clientPath) {
    const backupPath = clientPath + '.original';
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, clientPath);
      const patchFlagFile = clientPath + this.patchedFlag;
      if (fs.existsSync(patchFlagFile)) {
        fs.unlinkSync(patchFlagFile);
      }
      console.log('Client restored from backup');
      return true;
    }
    console.log('No backup found to restore');
    return false;
  }

  /**
   * Patch the client binary to use the custom domain
   * @param {string} clientPath - Path to the HytaleClient binary
   * @param {function} progressCallback - Optional callback for progress updates
   * @returns {object} Result object with success status and details
   */
  async patchClient(clientPath, progressCallback) {
    const newDomain = this.getNewDomain();
    console.log('=== Client Patcher ===');
    console.log(`Target: ${clientPath}`);
    console.log(`Replacing: ${ORIGINAL_DOMAIN} -> ${newDomain}`);

    // Check if file exists
    if (!fs.existsSync(clientPath)) {
      const error = `Client binary not found: ${clientPath}`;
      console.error(error);
      return { success: false, error };
    }

    // Check if already patched
    if (this.isPatchedAlready(clientPath)) {
      console.log(`Client already patched for ${newDomain}, skipping`);
      if (progressCallback) {
        progressCallback('Client already patched', 100);
      }
      return { success: true, alreadyPatched: true, patchCount: 0 };
    }

    if (progressCallback) {
      progressCallback('Preparing to patch client...', 10);
    }

    // Create backup
    console.log('Creating backup...');
    this.backupClient(clientPath);

    if (progressCallback) {
      progressCallback('Reading client binary...', 20);
    }

    // Read the binary
    console.log('Reading client binary...');
    const data = fs.readFileSync(clientPath);
    console.log(`Binary size: ${(data.length / 1024 / 1024).toFixed(2)} MB`);

    if (progressCallback) {
      progressCallback('Patching domain references...', 50);
    }

    // Perform the domain replacement
    console.log('Patching domain references...');
    const { buffer: patchedData, count } = this.findAndReplaceDomainSmart(data, ORIGINAL_DOMAIN, newDomain);

    if (count === 0) {
      console.log('No occurrences of hytale.com found - binary may already be modified or has different format');
      return { success: true, patchCount: 0, warning: 'No domain occurrences found' };
    }

    if (progressCallback) {
      progressCallback('Writing patched binary...', 80);
    }

    // Write the patched binary
    console.log('Writing patched binary...');
    fs.writeFileSync(clientPath, patchedData);

    // Mark as patched
    this.markAsPatched(clientPath);

    if (progressCallback) {
      progressCallback('Patching complete', 100);
    }

    console.log(`Successfully patched ${count} occurrences`);
    console.log('=== Patching Complete ===');

    return { success: true, patchCount: count };
  }

  /**
   * Patch the server JAR to use the custom domain
   * JAR files are ZIP archives, so we need to extract, patch class files, and repackage
   * @param {string} serverPath - Path to the HytaleServer.jar
   * @param {function} progressCallback - Optional callback for progress updates
   * @returns {object} Result object with success status and details
   */
  async patchServer(serverPath, progressCallback) {
    const newDomain = this.getNewDomain();
    console.log('=== Server Patcher ===');
    console.log(`Target: ${serverPath}`);
    console.log(`Replacing: ${ORIGINAL_DOMAIN} -> ${newDomain}`);

    // Check if file exists
    if (!fs.existsSync(serverPath)) {
      const error = `Server JAR not found: ${serverPath}`;
      console.error(error);
      return { success: false, error };
    }

    // Check if already patched
    if (this.isPatchedAlready(serverPath)) {
      console.log(`Server already patched for ${newDomain}, skipping`);
      if (progressCallback) {
        progressCallback('Server already patched', 100);
      }
      return { success: true, alreadyPatched: true, patchCount: 0 };
    }

    if (progressCallback) {
      progressCallback('Preparing to patch server...', 10);
    }

    // Create backup
    console.log('Creating backup...');
    this.backupClient(serverPath);

    if (progressCallback) {
      progressCallback('Extracting server JAR...', 20);
    }

    // Open the JAR file as a ZIP
    console.log('Opening server JAR...');
    const zip = new AdmZip(serverPath);
    const entries = zip.getEntries();
    console.log(`JAR contains ${entries.length} entries`);

    if (progressCallback) {
      progressCallback('Patching class files...', 40);
    }

    // Patch each entry that might contain domain strings
    let totalCount = 0;
    const oldUtf8 = this.stringToUtf8(ORIGINAL_DOMAIN);
    const newUtf8 = this.stringToUtf8(newDomain);

    for (const entry of entries) {
      // Only patch class files and certain resource files
      const name = entry.entryName;
      if (name.endsWith('.class') || name.endsWith('.properties') ||
          name.endsWith('.json') || name.endsWith('.xml') || name.endsWith('.yml')) {

        const data = entry.getData();

        // Check if this entry contains the domain
        if (data.includes(oldUtf8)) {
          const { buffer: patchedData, count } = this.findAndReplaceDomainUtf8(data, ORIGINAL_DOMAIN, newDomain);
          if (count > 0) {
            zip.updateFile(entry.entryName, patchedData);
            console.log(`  Patched ${count} occurrences in ${name}`);
            totalCount += count;
          }
        }
      }
    }

    if (totalCount === 0) {
      console.log('No occurrences of hytale.com found in server JAR entries');
      return { success: true, patchCount: 0, warning: 'No domain occurrences found in JAR' };
    }

    if (progressCallback) {
      progressCallback('Writing patched JAR...', 80);
    }

    // Write the patched JAR
    console.log('Writing patched JAR...');
    zip.writeZip(serverPath);

    // Mark as patched
    this.markAsPatched(serverPath);

    if (progressCallback) {
      progressCallback('Server patching complete', 100);
    }

    console.log(`Successfully patched ${totalCount} occurrences in server`);
    console.log('=== Server Patching Complete ===');

    return { success: true, patchCount: totalCount };
  }

  /**
   * Find the client binary path based on platform
   */
  findClientPath(gameDir) {
    const candidates = [];

    if (process.platform === 'darwin') {
      // macOS: Check both app bundle and direct binary
      candidates.push(path.join(gameDir, 'Client', 'Hytale.app', 'Contents', 'MacOS', 'HytaleClient'));
      candidates.push(path.join(gameDir, 'Client', 'HytaleClient'));
    } else if (process.platform === 'win32') {
      candidates.push(path.join(gameDir, 'Client', 'HytaleClient.exe'));
    } else {
      candidates.push(path.join(gameDir, 'Client', 'HytaleClient'));
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Find the server JAR path
   */
  findServerPath(gameDir) {
    const candidates = [
      path.join(gameDir, 'Server', 'HytaleServer.jar'),
      path.join(gameDir, 'Server', 'server.jar')
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Ensure both client and server are patched before launching
   * @param {string} gameDir - Path to the game directory
   * @param {function} progressCallback - Optional callback for progress updates
   */
  async ensureClientPatched(gameDir, progressCallback) {
    const results = {
      client: null,
      server: null,
      success: true
    };

    // Patch client
    const clientPath = this.findClientPath(gameDir);
    if (clientPath) {
      if (progressCallback) {
        progressCallback('Patching client binary...', 10);
      }
      results.client = await this.patchClient(clientPath, (msg, pct) => {
        if (progressCallback) {
          progressCallback(`Client: ${msg}`, pct ? pct / 2 : null);
        }
      });
    } else {
      console.warn('Could not find HytaleClient binary');
      results.client = { success: false, error: 'Client binary not found' };
    }

    // Patch server
    const serverPath = this.findServerPath(gameDir);
    if (serverPath) {
      if (progressCallback) {
        progressCallback('Patching server JAR...', 50);
      }
      results.server = await this.patchServer(serverPath, (msg, pct) => {
        if (progressCallback) {
          progressCallback(`Server: ${msg}`, pct ? 50 + pct / 2 : null);
        }
      });
    } else {
      console.warn('Could not find HytaleServer.jar');
      results.server = { success: false, error: 'Server JAR not found' };
    }

    // Calculate overall success
    results.success = (results.client && results.client.success) || (results.server && results.server.success);
    results.alreadyPatched = (results.client && results.client.alreadyPatched) && (results.server && results.server.alreadyPatched);
    results.patchCount = (results.client ? results.client.patchCount || 0 : 0) + (results.server ? results.server.patchCount || 0 : 0);

    if (progressCallback) {
      progressCallback('Patching complete', 100);
    }

    return results;
  }
}

// Export singleton instance
module.exports = new ClientPatcher();
