console.log('[Notarize] Script loaded');

let notarize;
try {
  notarize = require('@electron/notarize').notarize;
  console.log('[Notarize] @electron/notarize loaded successfully');
} catch (err) {
  console.error('[Notarize] Failed to load @electron/notarize:', err.message);
  throw err;
}

const path = require('path');

exports.default = async function notarizing(context) {
  console.log('[Notarize] afterSign hook called');
  console.log('[Notarize] Context:', JSON.stringify({
    platform: context.electronPlatformName,
    appOutDir: context.appOutDir,
    outDir: context.outDir
  }, null, 2));

  const { electronPlatformName, appOutDir } = context;

  // Only notarize macOS builds
  if (electronPlatformName !== 'darwin') {
    console.log('[Notarize] Skipping: not macOS');
    return;
  }

  // Check credentials
  const hasAppleId = !!process.env.APPLE_ID;
  const hasPassword = !!process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const hasTeamId = !!process.env.APPLE_TEAM_ID;

  console.log('[Notarize] Credentials check:', { hasAppleId, hasPassword, hasTeamId });

  if (!hasAppleId || !hasPassword || !hasTeamId) {
    console.log('[Notarize] Skipping: missing credentials');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log('[Notarize] Starting notarization...');
  console.log('[Notarize] App path:', appPath);
  console.log('[Notarize] Team ID:', process.env.APPLE_TEAM_ID);

  try {
    await notarize({
      appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
    console.log('[Notarize] Notarization complete!');
  } catch (error) {
    console.error('[Notarize] Notarization failed:', error.message);
    console.error('[Notarize] Full error:', error);
    throw error;
  }
};
