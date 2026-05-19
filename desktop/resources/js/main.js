/**
 * Fulcrum Desktop - Neutralinojs Frontend
 *
 * This script handles:
 * 1. Initializing Neutralino
 * 2. Starting/connecting to the local bundled server (default)
 * 3. Optionally connecting to a remote server if remoteHost is configured
 * 4. Graceful shutdown on window close
 */

// Configuration
const DEFAULT_PORT = 7777;
const FALLBACK_SCHEMA_VERSION = 5; // Used if package.json cannot be read
const HEALTH_CHECK_TIMEOUT = 3000; // 3 seconds per check
const MAX_HEALTH_RETRIES = 10;
const DEV_PORT = 5173;
const UPDATE_CHECK_URL = 'https://github.com/knowsuchagency/fulcrum/releases/latest/download/manifest.json';
const UPDATE_CHECK_INTERVAL = 2 * 60 * 60 * 1000; // Check every 2 hours

// State
let serverUrl = null;
let serverPid = null;
let isShuttingDown = false;
let desktopSettings = null;
let currentZoom = 1.2;
let currentRoute = { pathname: '/', search: '' }; // Track current SPA route from iframe
let isDevMode = false;
let logFilePath = null;
let loadingStartTime = null;
let cachedSchemaVersion = null; // Cached schema version from package.json
const MIN_LOADING_DURATION = 3000; // Show loading screen for at least 3 seconds

// =============================================================================
// Centralized JSONL Logger (writes to ~/.fulcrum/desktop.log)
// =============================================================================

/**
 * Initialize the log file path
 */
async function initLogger() {
  const home = NL_OS === 'Windows'
    ? await Neutralino.os.getEnv('USERPROFILE')
    : await Neutralino.os.getEnv('HOME');
  logFilePath = `${home}/.fulcrum/desktop.log`;
}

/**
 * Desktop logger - writes JSONL to desktop.log
 */
const log = {
  _write: async function(level, msg, ctx) {
    const entry = {
      ts: new Date().toISOString(),
      lvl: level,
      src: 'Desktop/UI',
      msg,
      ...(ctx && Object.keys(ctx).length > 0 ? { ctx } : {}),
    };

    // Always log to console
    const consoleMethod = level === 'debug' ? 'log' : level;
    console[consoleMethod](`[Desktop/UI]`, msg, ctx ?? '');

    // Write to log file if path is initialized
    if (logFilePath) {
      try {
        await Neutralino.filesystem.appendFile(logFilePath, JSON.stringify(entry) + '\n');
      } catch (err) {
        // Silently fail if we can't write to log file
        console.error('Failed to write to log file:', err);
      }
    }
  },

  debug: function(msg, ctx) { this._write('debug', msg, ctx); },
  info: function(msg, ctx) { this._write('info', msg, ctx); },
  warn: function(msg, ctx) { this._write('warn', msg, ctx); },
  error: function(msg, ctx) { this._write('error', msg, ctx); },
};

/**
 * Get the path to settings file
 */
async function getSettingsPath() {
  // Get home directory from environment
  const home = NL_OS === 'Windows'
    ? await Neutralino.os.getEnv('USERPROFILE')
    : await Neutralino.os.getEnv('HOME');
  return `${home}/.fulcrum/settings.json`;
}

/**
 * Get current schema version from bundled package.json major version
 * Schema version is derived from the major version number (e.g., 5.4.6 → 5)
 */
async function getSchemaVersion() {
  // Return cached value if available
  if (cachedSchemaVersion !== null) {
    return cachedSchemaVersion;
  }

  try {
    const bundleDir = await getBundlePath();
    const content = await Neutralino.filesystem.readFile(`${bundleDir}/package.json`);
    const pkg = JSON.parse(content);
    const majorVersion = parseInt(pkg.version.split('.')[0], 10);
    if (!isNaN(majorVersion) && majorVersion > 0) {
      cachedSchemaVersion = majorVersion;
      return majorVersion;
    }
  } catch (err) {
    log.debug('Could not read schema version from package.json, using fallback', { error: String(err) });
  }

  cachedSchemaVersion = FALLBACK_SCHEMA_VERSION;
  return FALLBACK_SCHEMA_VERSION;
}

/**
 * Get a nested value from settings (supports both new and legacy formats)
 */
function getSettingValue(key) {
  if (!desktopSettings) return undefined;

  // Try nested path first (e.g., 'server.port')
  const parts = key.split('.');
  if (parts.length === 2) {
    const [group, prop] = parts;
    if (desktopSettings[group] && desktopSettings[group][prop] !== undefined) {
      return desktopSettings[group][prop];
    }
  }

  // Fall back to flat key (legacy)
  return desktopSettings[key];
}

/**
 * Migrate settings from flat to nested format
 * @param {object} settings - The settings object to migrate
 * @param {number} targetVersion - The target schema version to migrate to
 */
function migrateSettings(settings, targetVersion) {
  const version = settings._schemaVersion || 1;
  if (version >= targetVersion) {
    return settings; // Already migrated
  }

  console.log('[Fulcrum] Migrating settings from version', version, 'to', targetVersion);

  const migrated = {
    _schemaVersion: targetVersion,
    server: { port: DEFAULT_PORT },
    editor: { app: 'vscode', host: '', sshPort: 22 },
  };

  // Copy existing nested groups if present
  for (const key of ['server', 'paths', 'editor', 'integrations', 'appearance', 'notifications', 'zai', 'desktop']) {
    if (settings[key] && typeof settings[key] === 'object') {
      migrated[key] = { ...migrated[key], ...settings[key] };
    }
  }

  // Schema 1 → 2: Migrate flat keys to nested structure
  if (version < 2) {
    const migrationMap = {
      port: ['server', 'port'],
      defaultGitReposDir: ['paths', 'defaultGitReposDir'],
      sshPort: ['editor', 'sshPort'],
      linearApiKey: ['integrations', 'linearApiKey'],
      githubPat: ['integrations', 'githubPat'],
      language: ['appearance', 'language'],
    };

    for (const [flatKey, [group, prop]] of Object.entries(migrationMap)) {
      if (settings[flatKey] !== undefined && settings[flatKey] !== null) {
        // Don't migrate old default port (3333) - let user get new default
        if (flatKey === 'port' && settings[flatKey] === 3333) {
          continue;
        }
        if (!migrated[group]) migrated[group] = {};
        if (migrated[group][prop] === undefined || migrated[group][prop] === null || migrated[group][prop] === '') {
          migrated[group][prop] = settings[flatKey];
        }
      }
    }

  }

  // Preserve non-migrated keys (like lastUpdateCheck, lastConnectedHost)
  for (const key of ['lastUpdateCheck', 'lastConnectedHost']) {
    if (settings[key] !== undefined) {
      migrated[key] = settings[key];
    }
  }

  console.log('[Fulcrum] Settings migrated:', migrated);
  return migrated;
}

/**
 * Load settings from file
 */
async function loadSettings() {
  try {
    const settingsPath = await getSettingsPath();
    const schemaVersion = await getSchemaVersion();
    const content = await Neutralino.filesystem.readFile(settingsPath);
    let settings = JSON.parse(content);
    log.debug('Loaded settings', settings);

    // Migrate if needed
    if (!settings._schemaVersion || settings._schemaVersion < schemaVersion) {
      settings = migrateSettings(settings, schemaVersion);
      // Save migrated settings
      await Neutralino.filesystem.writeFile(settingsPath, JSON.stringify(settings, null, 2));
      log.info('Saved migrated settings');
    }

    // D-12 PR 2: ensure profiles shape (independent of _schemaVersion bumps
    // since the major version controls schemaVersion and we don't want to
    // gate profile migration on that). Cheap if already migrated.
    const beforeProfiles = JSON.stringify(settings.connection ?? null);
    settings = ensureProfilesShape(settings);
    const afterProfiles = JSON.stringify(settings.connection);
    if (beforeProfiles !== afterProfiles) {
      await Neutralino.filesystem.writeFile(settingsPath, JSON.stringify(settings, null, 2));
      log.info('Migrated connection to profiles shape', { connection: settings.connection });
    }

    desktopSettings = settings;

    // Restore zoom level if previously saved
    if (settings.desktop?.zoomLevel) {
      currentZoom = settings.desktop.zoomLevel;
      // Update the zoom display
      const zoomLevelEl = document.getElementById('zoom-level');
      if (zoomLevelEl) {
        zoomLevelEl.textContent = Math.round(currentZoom * 100) + '%';
      }
      log.debug('Restored zoom level', { zoomLevel: currentZoom });
    }

    return desktopSettings;
  } catch (err) {
    // File doesn't exist or is invalid, use defaults
    log.info('No existing settings, using defaults');
    desktopSettings = {};
    return desktopSettings;
  }
}

/**
 * Save settings to file (always in nested format)
 */
async function saveSettings(settings) {
  try {
    const settingsPath = await getSettingsPath();
    const schemaVersion = await getSchemaVersion();

    // Ensure .fulcrum directory exists
    const fulcrumDir = settingsPath.substring(0, settingsPath.lastIndexOf('/'));
    try {
      await Neutralino.filesystem.createDirectory(fulcrumDir);
    } catch {
      // Directory might already exist
    }

    // Ensure schema version is set
    settings._schemaVersion = schemaVersion;

    await Neutralino.filesystem.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    desktopSettings = settings;
    log.debug('Settings saved', settings);
  } catch (err) {
    log.error('Failed to save settings', { error: String(err) });
  }
}

/**
 * Update the status display
 */
function setStatus(text, detail = '') {
  const statusEl = document.getElementById('status-text');
  const detailEl = document.getElementById('status-detail');
  if (statusEl) statusEl.textContent = text;
  if (detailEl) detailEl.textContent = detail;
}

/**
 * Show error state
 */
function showError(title, message) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <img src="/icons/icon.png" alt="Fulcrum" class="logo" style="animation: none; opacity: 0.5;">
    <div class="error">
      <div class="error-title">${title}</div>
      <div>${message}</div>
    </div>
    <button class="retry-btn" onclick="location.reload()">Retry</button>
  `;
}

/**
 * Check if a server is healthy
 * Uses native HTTP request via curl to bypass WebView CORS restrictions
 */
async function checkServerHealth(baseUrl) {
  try {
    // Use curl for health check to bypass WebView CORS restrictions
    // -s: silent, -o /dev/null: discard output, -w "%{http_code}": print status code
    // --max-time: timeout in seconds
    const timeoutSec = Math.ceil(HEALTH_CHECK_TIMEOUT / 1000);
    const result = await Neutralino.os.execCommand(
      `curl -s -o /dev/null -w "%{http_code}" --max-time ${timeoutSec} "${baseUrl}/health"`
    );
    const statusCode = parseInt(result.stdOut.trim(), 10);
    return statusCode >= 200 && statusCode < 300;
  } catch (err) {
    log.debug('Health check failed', { baseUrl, error: String(err) });
    return false;
  }
}

/**
 * Wait for server to be ready with retries
 */
async function waitForServerReady(baseUrl) {
  log.info('Waiting for server to be ready', { baseUrl, maxRetries: MAX_HEALTH_RETRIES });
  for (let i = 0; i < MAX_HEALTH_RETRIES; i++) {
    setStatus('Connecting to server...', `Attempt ${i + 1}/${MAX_HEALTH_RETRIES}`);
    log.debug('Health check attempt', { attempt: i + 1, maxRetries: MAX_HEALTH_RETRIES, baseUrl });
    if (await checkServerHealth(baseUrl)) {
      log.info('Server is ready', { baseUrl, attempts: i + 1 });
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  log.warn('Server did not become ready after retries', { baseUrl, attempts: MAX_HEALTH_RETRIES });
  return false;
}

/**
 * Set zoom level - reloads iframe with zoom query parameter
 * The Fulcrum frontend applies this as root font-size for native scaling
 */
function setZoom(level, skipSave = false) {
  currentZoom = Math.max(0.5, Math.min(2.0, level)); // Clamp between 50% and 200%

  // Update zoom level display
  const zoomLevel = document.getElementById('zoom-level');
  if (zoomLevel) {
    zoomLevel.textContent = Math.round(currentZoom * 100) + '%';
  }
  console.log('[Fulcrum] Zoom:', Math.round(currentZoom * 100) + '%');

  // Persist zoom level to settings
  if (!skipSave && desktopSettings) {
    saveSettings({
      ...desktopSettings,
      desktop: { ...desktopSettings.desktop, zoomLevel: currentZoom }
    });
  }

  // Reload iframe with new zoom parameter, preserving current SPA route
  // Route is tracked via postMessage from the Fulcrum frontend
  const frame = document.getElementById('fulcrum-frame');
  if (frame && serverUrl) {
    const url = new URL(serverUrl);
    url.pathname = currentRoute.pathname;
    if (currentZoom !== 1.0) {
      url.searchParams.set('zoom', currentZoom.toString());
    }
    // Preserve any other search params from the route (but not zoom - we set that)
    const routeParams = new URLSearchParams(currentRoute.search);
    routeParams.delete('zoom'); // Don't double-add zoom
    for (const [key, value] of routeParams) {
      url.searchParams.set(key, value);
    }
    frame.src = url.toString();
  }
}

// Global zoom functions for button onclick handlers
window.zoomIn = () => setZoom(currentZoom + 0.1);
window.zoomOut = () => setZoom(currentZoom - 0.1);
window.zoomReset = () => setZoom(1.2);

/**
 * Navigate to a path in the Fulcrum app
 * Updates the iframe URL, preserving zoom level
 */
function navigateTo(path) {
  const frame = document.getElementById('fulcrum-frame');
  if (frame && serverUrl) {
    const url = new URL(serverUrl);
    // Parse path and query
    const [pathname, search] = path.split('?');
    url.pathname = pathname;
    // Preserve zoom
    if (currentZoom !== 1.0) {
      url.searchParams.set('zoom', currentZoom.toString());
    }
    // Add any query params from the path
    if (search) {
      const params = new URLSearchParams(search);
      for (const [key, value] of params) {
        url.searchParams.set(key, value);
      }
    }
    frame.src = url.toString();
    // Update route tracking
    currentRoute = { pathname, search: search ? `?${search}` : '' };
    log.debug('Navigated to', { path, url: url.toString() });
  }
}

/**
 * Send a message to the Fulcrum app via postMessage
 * Used for triggering UI actions like opening modals
 */
function postMessageToApp(type, data = {}) {
  const frame = document.getElementById('fulcrum-frame');
  if (frame?.contentWindow) {
    frame.contentWindow.postMessage({ type, ...data }, '*');
    log.debug('Posted message to app', { type, data });
  }
}

/**
 * Update the floating top-right server indicator. Hidden when on local;
 * shows the remote host (without scheme) when on remote.
 */
function updateServerIndicator(url) {
  const el = document.getElementById('server-indicator');
  if (!el) return;
  let isRemote = false;
  let label = '';
  try {
    const u = new URL(url);
    const host = u.host;
    isRemote = !(host.startsWith('localhost') || host.startsWith('127.0.0.1'));
    label = `remote: ${host}`;
  } catch {
    isRemote = false;
  }
  if (isRemote) {
    el.textContent = label;
    el.classList.add('visible');
  } else {
    el.classList.remove('visible');
    el.textContent = '';
  }
}

/**
 * Load the Fulcrum app in an iframe
 */
async function loadFulcrumApp(url) {
  setStatus('Loading Fulcrum...', url);
  serverUrl = url;
  updateServerIndicator(url);

  log.info('Loading app', { url });

  const frame = document.getElementById('fulcrum-frame');
  const zoomParam = currentZoom !== 1.0 ? `?zoom=${currentZoom}` : '';
  frame.src = url + zoomParam;

  // Set a timeout to detect if iframe fails to load
  const loadTimeout = setTimeout(() => {
    log.error('Iframe load timeout', { url });
    showError('Connection Failed', `Could not load Fulcrum from ${url}.`);
  }, 10000); // 10 second timeout

  frame.onload = async () => {
    clearTimeout(loadTimeout);

    // Ensure minimum loading screen duration
    const elapsed = Date.now() - loadingStartTime;
    const remaining = MIN_LOADING_DURATION - elapsed;
    if (remaining > 0) {
      log.debug('Waiting for minimum loading duration', { remaining });
      await new Promise(resolve => setTimeout(resolve, remaining));
    }

    document.body.classList.add('loaded');
    log.info('App loaded successfully', { url });
  };

  frame.onerror = (err) => {
    clearTimeout(loadTimeout);
    log.error('Failed to load app (onerror)', { url, error: String(err) });
    showError('Load Failed', 'Could not load Fulcrum interface.');
  };
}

/**
 * Get local server port from settings (nested format)
 */
function getLocalPort() {
  if (isDevMode) return DEV_PORT;
  return desktopSettings?.server?.port || DEFAULT_PORT;
}

/**
 * Get path to the bundle directory (contains server, lib, etc.)
 */
async function getBundlePath() {
  if (NL_OS === 'Darwin') {
    // macOS: .../Fulcrum.app/Contents/MacOS -> .../Fulcrum.app/Contents/Resources/bundle
    return `${NL_PATH}/../Resources/bundle`;
  } else {
    // Linux: .../usr/bin -> .../usr/share/fulcrum/bundle
    return `${NL_PATH}/../share/fulcrum/bundle`;
  }
}

/**
 * Get the Fulcrum data directory
 */
async function getFulcrumDir() {
  const home = NL_OS === 'Windows'
    ? await Neutralino.os.getEnv('USERPROFILE')
    : await Neutralino.os.getEnv('HOME');
  return `${home}/.fulcrum`;
}

/**
 * Start the local server if not already running
 * Called when launcher didn't start it (first launch or remote mode switch)
 */
async function startLocalServer() {
  const port = getLocalPort();
  const localUrl = `http://localhost:${port}`;

  // Check if server is already running
  if (await checkServerHealth(localUrl)) {
    log.info('Server already running (startLocalServer)');
    return true;
  }

  setStatus('Starting local server...', `Port ${port}`);
  log.info('Starting local server', { port });

  try {
    const bundleDir = await getBundlePath();
    const fulcrumDir = await getFulcrumDir();

    // Determine PTY library based on OS and architecture
    const arch = typeof NL_ARCH !== 'undefined' ? NL_ARCH : 'x64';
    let ptyLib;
    if (NL_OS === 'Darwin') {
      ptyLib = arch === 'arm64'
        ? `${bundleDir}/lib/librust_pty_arm64.dylib`
        : `${bundleDir}/lib/librust_pty.dylib`;
    } else {
      // Linux
      ptyLib = arch === 'arm64' || arch === 'aarch64'
        ? `${bundleDir}/lib/librust_pty_arm64.so`
        : `${bundleDir}/lib/librust_pty.so`;
    }

    const serverBin = `${bundleDir}/server/fulcrum-server`;

    // Build command with environment variables
    const cmd = `NODE_ENV=production PORT=${port} FULCRUM_DIR="${fulcrumDir}" ` +
      `FULCRUM_PACKAGE_ROOT="${bundleDir}" BUN_PTY_LIB="${ptyLib}" ` +
      `"${serverBin}"`;

    log.debug('Server command', { cmd });

    // Start server process in background
    const result = await Neutralino.os.spawnProcess(cmd);
    serverPid = result?.pid ?? null;
    log.info('Server process spawned', { pid: serverPid });

    // Wait for server to be ready
    if (await waitForServerReady(localUrl)) {
      log.info('Server is ready');
      return true;
    }

    log.error('Server failed to become ready');
    return false;
  } catch (err) {
    log.error('Failed to start server', { error: String(err) });
    return false;
  }
}

// =============================================================================
// Server-profile management (D-12 PR 2)
// =============================================================================
//
// Settings shape after PR 2 migration:
//   connection.activeProfileId  — string id of the profile in use
//   connection.profiles         — array, always includes the synthetic
//                                  Local profile, plus any user-added remotes
//
// A profile is one of:
//   { id: 'local',   label: 'Local', isLocal: true }
//   { id: <host>,    label: <name>,  url: 'https://host…' }
//
// The Local profile is fixed — never deleted, never duplicated, always at
// index 0. Remote profile ids are derived from URL host so adding the same
// URL twice idempotently updates the existing profile.

const LOCAL_PROFILE = Object.freeze({ id: 'local', label: 'Local', isLocal: true });

/**
 * Normalize a user-typed remote URL.
 * - Strips trailing slash.
 * - Adds https:// when scheme is missing.
 * - Returns null when the input doesn't look like a URL we can use.
 */
function normalizeRemoteUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let value = input.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) {
    value = 'https://' + value;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.host) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Pick a human-readable default label from a hostname. Strips the
 * `.divinci.ai` suffix for our SaaS tenants so "fulcrum-acme" reads cleanly.
 */
function defaultLabelForHost(host) {
  return host.replace(/\.divinci\.ai$/, '');
}

/**
 * Lazily migrate the connection block to the profiles shape.
 *
 * Three input states we handle:
 *   1. No connection block at all (fresh install / pre-D-12 install)
 *      → seed with Local-only, activeProfileId='local'.
 *   2. PR 1 shape: { mode: 'local'|'remote', remoteUrl? }
 *      → seed Local; if mode=='remote' & remoteUrl is valid, add a remote
 *        profile and set it active.
 *   3. PR 2 shape (already has profiles array)
 *      → no-op (return unchanged).
 *
 * Pure: takes a settings object, returns a settings object. Caller decides
 * whether to persist.
 */
function ensureProfilesShape(settings) {
  const conn = settings?.connection ?? {};
  if (Array.isArray(conn.profiles)) {
    if (!conn.profiles.find((p) => p.id === 'local')) {
      conn.profiles = [LOCAL_PROFILE, ...conn.profiles];
    }
    if (!conn.activeProfileId) {
      conn.activeProfileId = 'local';
    }
    return { ...settings, connection: conn };
  }

  const profiles = [LOCAL_PROFILE];
  let activeProfileId = 'local';

  // PR 1 → PR 2 migration: pull the single remoteUrl into a profile.
  if (conn.mode === 'remote' && conn.remoteUrl) {
    const url = normalizeRemoteUrl(conn.remoteUrl);
    if (url) {
      try {
        const host = new URL(url).host;
        profiles.push({ id: host, label: defaultLabelForHost(host), url });
        activeProfileId = host;
      } catch {
        // Bad URL — drop the migration and stay local.
      }
    }
  }

  return {
    ...settings,
    connection: { activeProfileId, profiles },
  };
}

function getProfiles() {
  return desktopSettings?.connection?.profiles ?? [LOCAL_PROFILE];
}

function findProfile(id) {
  return getProfiles().find((p) => p.id === id) ?? null;
}

function getActiveProfileId() {
  return desktopSettings?.connection?.activeProfileId ?? 'local';
}

/**
 * Connect to local server. Spawns the bundled server if not already running.
 * Caller is responsible for updating activeProfileId.
 */
async function connectToLocal() {
  const localPort = getLocalPort();
  const localUrl = `http://localhost:${localPort}`;

  setStatus('Connecting to local server...', `localhost:${localPort}${isDevMode ? ' (dev)' : ''}`);
  log.info('Connecting to local server', { port: localPort, isDevMode });

  if (await checkServerHealth(localUrl)) {
    log.info('Server already running');
    loadFulcrumApp(localUrl);
    return true;
  }

  log.info('Server not running, starting...');
  if (await startLocalServer()) {
    loadFulcrumApp(localUrl);
    return true;
  }

  log.error('Could not start local server');
  showError('Server Failed', 'Could not start local server. Check ~/.fulcrum/desktop.log for details.');
  return false;
}

/**
 * Connect to a remote Fulcrum server at the given URL. Does NOT spawn a
 * server. Auth flows through the remote's own mechanism (CF Access SSO
 * sets a cookie inside this webview). Caller is responsible for updating
 * activeProfileId.
 */
async function connectToRemoteUrl(url) {
  const remoteUrl = normalizeRemoteUrl(url);
  if (!remoteUrl) {
    showError('Invalid URL', 'Could not parse the remote server URL.');
    return false;
  }

  setStatus('Connecting to remote server...', remoteUrl);
  log.info('Connecting to remote server', { remoteUrl });

  const reachable = await checkServerHealth(remoteUrl);
  if (!reachable) {
    log.warn('Remote /health did not respond OK — continuing anyway (may be CF Access gated)', { remoteUrl });
  }

  loadFulcrumApp(remoteUrl);
  return true;
}

/**
 * Unified entry point for switching connections. Looks up the profile,
 * updates activeProfileId in settings, and dispatches to local vs remote.
 */
async function connectToProfile(id) {
  const profile = findProfile(id) ?? LOCAL_PROFILE;
  log.info('Switching to profile', { id: profile.id, label: profile.label });

  await saveSettings({
    ...desktopSettings,
    lastConnectedHost: profile.isLocal ? 'localhost' : `remote:${profile.url}`,
    connection: { ...desktopSettings.connection, activeProfileId: profile.id },
  });

  await setupMacMenu();

  if (profile.isLocal) {
    return connectToLocal();
  }
  return connectToRemoteUrl(profile.url);
}

/**
 * Add (or update if host id collides) a remote profile and connect to it.
 */
async function addProfileAndConnect(label, url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) {
    return { ok: false, error: 'Please enter a valid URL (e.g. https://fulcrum-acme.divinci.ai).' };
  }
  const host = new URL(normalized).host;
  if (host === 'localhost' || host.startsWith('127.0.0.1')) {
    return { ok: false, error: 'Localhost is the Local profile — no need to add it as a remote.' };
  }

  const cleanLabel = (label || '').trim() || defaultLabelForHost(host);
  const id = host;
  const existing = getProfiles();
  const remotesWithoutCollision = existing.filter((p) => p.id !== id && p.id !== 'local');
  const updated = [
    LOCAL_PROFILE,
    ...remotesWithoutCollision,
    { id, label: cleanLabel, url: normalized },
  ];

  await saveSettings({
    ...desktopSettings,
    connection: { ...desktopSettings.connection, profiles: updated },
  });

  await connectToProfile(id);
  return { ok: true };
}

/**
 * Delete a profile by id. 'local' is fixed and cannot be deleted. If the
 * deleted profile was active, falls back to Local.
 */
async function deleteProfile(id) {
  if (id === 'local') {
    log.warn('Refusing to delete Local profile');
    return;
  }
  const wasActive = getActiveProfileId() === id;
  const next = getProfiles().filter((p) => p.id !== id);
  await saveSettings({
    ...desktopSettings,
    connection: {
      ...desktopSettings.connection,
      profiles: next,
      activeProfileId: wasActive ? 'local' : desktopSettings.connection.activeProfileId,
    },
  });
  await setupMacMenu();
  if (wasActive) {
    document.body.classList.remove('loaded');
    await connectToProfile('local');
  }
}

/**
 * Main connection logic — boots into the saved active profile.
 */
async function tryConnect() {
  log.info('tryConnect() called');
  await loadSettings();
  const activeId = getActiveProfileId();
  log.info('Booting into profile', { activeId });
  const ok = await connectToProfile(activeId);
  if (!ok && activeId !== 'local') {
    log.warn('Active profile failed, falling back to Local', { activeId });
    await connectToProfile('local');
  }
}

// =============================================================================
// Add Profile + Manage Profiles modals
// =============================================================================

function openAddProfileModal() {
  const overlay = document.getElementById('add-profile-overlay');
  const labelInput = document.getElementById('add-profile-label');
  const urlInput = document.getElementById('add-profile-url');
  const errorBox = document.getElementById('add-profile-error');
  if (!overlay) return;
  errorBox.style.display = 'none';
  errorBox.textContent = '';
  labelInput.value = '';
  urlInput.value = '';
  overlay.classList.add('visible');
  urlInput.focus();
}

function closeAddProfileModal() {
  document.getElementById('add-profile-overlay')?.classList.remove('visible');
}

async function submitAddProfileModal() {
  const label = document.getElementById('add-profile-label')?.value ?? '';
  const url = document.getElementById('add-profile-url')?.value ?? '';
  const errorBox = document.getElementById('add-profile-error');
  const result = await addProfileAndConnect(label, url);
  if (!result.ok) {
    errorBox.textContent = result.error;
    errorBox.style.display = 'block';
    return;
  }
  closeAddProfileModal();
  document.body.classList.remove('loaded');
}

function openManageProfilesModal() {
  const overlay = document.getElementById('manage-profiles-overlay');
  if (!overlay) return;
  renderProfileList();
  overlay.classList.add('visible');
}

function closeManageProfilesModal() {
  document.getElementById('manage-profiles-overlay')?.classList.remove('visible');
}

/**
 * Render the profile list inside the Manage Profiles modal. Called every
 * time the modal opens, and after each delete.
 */
function renderProfileList() {
  const listEl = document.getElementById('manage-profiles-list');
  if (!listEl) return;
  const profiles = getProfiles();
  const activeId = getActiveProfileId();
  // Clear without using innerHTML — safer pattern, avoids XSS hook tripping.
  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
  for (const p of profiles) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const meta = document.createElement('div');
    meta.className = 'profile-meta';
    const labelEl = document.createElement('div');
    labelEl.className = 'profile-label';
    labelEl.textContent = p.label + (p.id === activeId ? '  (active)' : '');
    const urlEl = document.createElement('div');
    urlEl.className = 'profile-url';
    urlEl.textContent = p.isLocal ? `localhost:${getLocalPort()}` : p.url;
    meta.appendChild(labelEl);
    meta.appendChild(urlEl);
    row.appendChild(meta);
    if (!p.isLocal) {
      const del = document.createElement('button');
      del.className = 'text-btn profile-delete';
      del.textContent = 'Delete';
      del.onclick = async () => {
        await deleteProfile(p.id);
        renderProfileList();
      };
      row.appendChild(del);
    }
    listEl.appendChild(row);
  }
}

window.fulcrumOpenAddProfile = openAddProfileModal;
window.fulcrumCloseAddProfile = closeAddProfileModal;
window.fulcrumSubmitAddProfile = submitAddProfileModal;
window.fulcrumOpenManageProfiles = openManageProfilesModal;
window.fulcrumCloseManageProfiles = closeManageProfilesModal;
window.fulcrumGetConnectionState = () => ({
  activeProfileId: getActiveProfileId(),
  profiles: getProfiles(),
  current: serverUrl,
});

// Esc closes whichever overlay is open.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.connect-overlay.visible');
  if (open) {
    e.preventDefault();
    open.classList.remove('visible');
  }
});

// =============================================================================
// macOS native menu — built dynamically so the Server submenu can reflect
// the current profile list and active profile.
// =============================================================================

async function setupMacMenu() {
  if (NL_OS !== 'Darwin') return;

  // Profile items: one per profile, with a ✓ prefix on the active one.
  const activeId = getActiveProfileId();
  const profileItems = getProfiles().map((p) => ({
    id: `profile:${p.id}`,
    text: `${p.id === activeId ? '✓ ' : '  '}Connect to ${p.label}`,
  }));

  await Neutralino.window.setMainMenu([
    {
      id: 'app',
      text: 'Fulcrum',
      menuItems: [
        { id: 'about', text: 'About Fulcrum' },
        { text: '-' },
        { id: 'quit', text: 'Quit Fulcrum', shortcut: 'q', action: 'terminate:' }
      ]
    },
    {
      id: 'edit',
      text: 'Edit',
      menuItems: [
        { id: 'undo', text: 'Undo', shortcut: 'z', action: 'undo:' },
        { id: 'redo', text: 'Redo', shortcut: 'Z', action: 'redo:' },
        { text: '-' },
        { id: 'cut', text: 'Cut', shortcut: 'x', action: 'cut:' },
        { id: 'copy', text: 'Copy', shortcut: 'c', action: 'copy:' },
        { id: 'paste', text: 'Paste', shortcut: 'v', action: 'paste:' },
        { id: 'selectAll', text: 'Select All', shortcut: 'a', action: 'selectAll:' }
      ]
    },
    {
      id: 'view',
      text: 'View',
      menuItems: [
        { id: 'zoomIn', text: 'Zoom In', shortcut: '+' },
        { id: 'zoomOut', text: 'Zoom Out', shortcut: '-' },
        { id: 'zoomReset', text: 'Actual Size', shortcut: '0' }
      ]
    },
    {
      id: 'go',
      text: 'Go',
      menuItems: [
        { id: 'goTasks', text: 'Tasks', shortcut: '1' },
        { id: 'goTerminals', text: 'Terminals', shortcut: '2' },
        { id: 'goTaskTerminals', text: 'Task Terminals', shortcut: 'i' },
        { id: 'goRepositories', text: 'Repositories', shortcut: '3' },
        { id: 'goReview', text: 'Review', shortcut: '4' },
        { id: 'goMonitoring', text: 'Monitoring', shortcut: '5' },
        { text: '-' },
        { id: 'goSettings', text: 'Settings…', shortcut: ',' },
        { text: '-' },
        { id: 'commandPalette', text: 'Command Palette', shortcut: 'k' },
        { id: 'newTask', text: 'New Task', shortcut: 'j' },
        { id: 'showHelp', text: 'Keyboard Shortcuts', shortcut: '/' }
      ]
    },
    {
      id: 'server',
      text: 'Server',
      menuItems: [
        ...profileItems,
        { text: '-' },
        { id: 'serverAdd', text: 'Add Remote Profile…' },
        { id: 'serverManage', text: 'Manage Profiles…' },
      ]
    }
  ]);
}

function handleMacMenuClick(evt) {
  const id = evt.detail.id;
  // Profile switch items: id is "profile:<profileId>"
  if (typeof id === 'string' && id.startsWith('profile:')) {
    const profileId = id.slice('profile:'.length);
    document.body.classList.remove('loaded');
    connectToProfile(profileId);
    return;
  }
  switch (id) {
    // Zoom
    case 'zoomIn': zoomIn(); break;
    case 'zoomOut': zoomOut(); break;
    case 'zoomReset': zoomReset(); break;
    // Navigation
    case 'goTasks': navigateTo('/tasks'); break;
    case 'goTerminals': navigateTo('/terminals'); break;
    case 'goTaskTerminals': navigateTo('/terminals?tab=all-tasks'); break;
    case 'goRepositories': navigateTo('/repositories'); break;
    case 'goReview': navigateTo('/review'); break;
    case 'goMonitoring': navigateTo('/monitoring'); break;
    case 'goSettings': navigateTo('/settings'); break;
    // Actions (via postMessage to React app)
    case 'commandPalette': postMessageToApp('fulcrum:action', { action: 'openCommandPalette' }); break;
    case 'newTask': postMessageToApp('fulcrum:action', { action: 'openNewTask' }); break;
    case 'showHelp': postMessageToApp('fulcrum:action', { action: 'showShortcuts' }); break;
    // Server profile management
    case 'serverAdd': openAddProfileModal(); break;
    case 'serverManage': openManageProfilesModal(); break;
  }
}

/**
 * Handle extension ready event (when running with local server extension)
 */
function handleExtensionReady(port) {
  console.log(`[Fulcrum] Local server extension ready on port ${port}`);

  // Save port for future reference (nested format)
  saveSettings({
    ...desktopSettings,
    server: { ...desktopSettings?.server, port: port },
    lastConnectedHost: 'localhost'
  });

  loadFulcrumApp(`http://localhost:${port}`);
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info('Initiating shutdown...');

  // Kill the server process if we spawned it
  if (serverPid) {
    try {
      log.info('Killing server process', { pid: serverPid });
      await Neutralino.os.execCommand(`kill ${serverPid}`);
      // Give it a moment to terminate gracefully
      await new Promise(resolve => setTimeout(resolve, 500));
      // Force kill if still running
      try {
        await Neutralino.os.execCommand(`kill -9 ${serverPid}`);
      } catch {
        // Process already terminated
      }
    } catch (err) {
      log.error('Failed to kill server process', { pid: serverPid, error: String(err) });
    }
  }

  Neutralino.app.exit();
}

// =============================================================================
// Update Checking
// =============================================================================

/**
 * Get platform identifier for update manifest
 */
function getPlatformId() {
  const os = NL_OS.toLowerCase();
  // NL_ARCH is 'x64' or 'arm64' on supported platforms
  const arch = typeof NL_ARCH !== 'undefined' ? NL_ARCH : 'x64';

  if (os === 'darwin') {
    return `darwin-${arch}`;
  } else if (os === 'linux') {
    return `linux-${arch}`;
  } else if (os === 'windows') {
    return `windows-${arch}`;
  }
  return null;
}

/**
 * Compare semantic versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
  const parsed1 = parseSemver(v1);
  const parsed2 = parseSemver(v2);
  if (!parsed1 || !parsed2) return 0;

  if (parsed1.major !== parsed2.major) return parsed1.major - parsed2.major;
  if (parsed1.minor !== parsed2.minor) return parsed1.minor - parsed2.minor;
  if (parsed1.patch !== parsed2.patch) return parsed1.patch - parsed2.patch;

  const pre1 = parsed1.preRelease;
  const pre2 = parsed2.preRelease;
  if (pre1.length === 0 && pre2.length === 0) return 0;
  if (pre1.length === 0) return 1;
  if (pre2.length === 0) return -1;

  const maxLen = Math.max(pre1.length, pre2.length);
  for (let i = 0; i < maxLen; i++) {
    const id1 = pre1[i];
    const id2 = pre2[i];
    if (id1 === undefined) return -1;
    if (id2 === undefined) return 1;
    const diff = compareIdentifiers(id1, id2);
    if (diff !== 0) return diff;
  }

  return 0;
}

function parseSemver(version) {
  const cleaned = String(version).trim().replace(/^v/, '');
  const mainAndPre = cleaned.split('+')[0];
  const parts = mainAndPre.split('-');
  const main = parts[0];
  const preReleaseRaw = parts[1];
  const mainParts = main.split('.');
  if (mainParts.length === 0 || mainParts.length > 3) return null;

  if (mainParts.some((part) => part.length > 1 && part.startsWith('0'))) return null;

  const major = Number(mainParts[0]);
  const minor = Number(mainParts[1] ?? '0');
  const patch = Number(mainParts[2] ?? '0');
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  if (major < 0 || minor < 0 || patch < 0) return null;

  if (preReleaseRaw) {
    const preReleaseParts = preReleaseRaw.split('.');
    if (preReleaseParts.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
      return null;
    }
  }

  const preRelease = preReleaseRaw
    ? preReleaseRaw.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];

  return { major, minor, patch, preRelease };
}

function compareIdentifiers(a, b) {
  const isNumA = typeof a === 'number';
  const isNumB = typeof b === 'number';
  if (isNumA && isNumB) return a - b;
  if (isNumA) return -1;
  if (isNumB) return 1;
  return String(a).localeCompare(String(b));
}

/**
 * Check for updates
 * @param {boolean} showNoUpdateMessage - Show message even if no update available
 */
async function checkForUpdates(showNoUpdateMessage = false) {
  try {
    console.log('[Fulcrum] Checking for updates...');

    // Fetch the manifest
    const response = await fetch(UPDATE_CHECK_URL);
    if (!response.ok) {
      console.log('[Fulcrum] Failed to fetch update manifest:', response.status);
      return null;
    }

    const manifest = await response.json();
    const currentVersion = NL_APPVERSION;
    const latestVersion = manifest.version;

    console.log(`[Fulcrum] Current: ${currentVersion}, Latest: ${latestVersion}`);

    if (compareVersions(latestVersion, currentVersion) > 0) {
      // New version available
      const platformId = getPlatformId();
      const downloadUrl = manifest.platforms?.[platformId]?.url;

      return {
        currentVersion,
        latestVersion,
        downloadUrl
      };
    } else if (showNoUpdateMessage) {
      await Neutralino.os.showMessageBox(
        'Up to Date',
        `You are running the latest version (${currentVersion}).`,
        'INFO',
        ['OK']
      );
    }

    return null;
  } catch (err) {
    console.error('[Fulcrum] Update check failed:', err);
    if (showNoUpdateMessage) {
      await Neutralino.os.showMessageBox(
        'Update Check Failed',
        'Could not check for updates. Please check your internet connection.',
        'WARNING',
        ['OK']
      );
    }
    return null;
  }
}

/**
 * Prompt user about available update
 */
async function promptForUpdate(updateInfo) {
  const message = `A new version of Fulcrum is available!\n\n` +
    `Current: ${updateInfo.currentVersion}\n` +
    `Latest: ${updateInfo.latestVersion}\n\n` +
    `Would you like to download the update?`;

  try {
    const result = await Neutralino.os.showMessageBox(
      'Update Available',
      message,
      'QUESTION',
      ['Download', 'Later']
    );

    if (result === 'Download' && updateInfo.downloadUrl) {
      // Open download URL in browser
      await Neutralino.os.open(updateInfo.downloadUrl);
    }
  } catch (err) {
    console.error('[Fulcrum] Failed to show update dialog:', err);
  }
}

/**
 * Auto-check for updates on startup (once per day)
 */
async function autoCheckForUpdates() {
  // Don't check in dev mode
  if (isDevMode) {
    console.log('[Fulcrum] Skipping update check in dev mode');
    return;
  }

  try {
    // Check if we should check (based on last check time)
    const settingsPath = await getSettingsPath();
    let settings = {};
    try {
      const content = await Neutralino.filesystem.readFile(settingsPath);
      settings = JSON.parse(content);
    } catch {
      // No settings file yet
    }

    const lastCheck = settings.lastUpdateCheck || 0;
    const now = Date.now();

    if (now - lastCheck < UPDATE_CHECK_INTERVAL) {
      console.log('[Fulcrum] Skipping update check (checked recently)');
      return;
    }

    // Save check time
    settings.lastUpdateCheck = now;
    await saveSettings(settings);

    // Check for updates
    const updateInfo = await checkForUpdates();
    if (updateInfo) {
      await promptForUpdate(updateInfo);
    }
  } catch (err) {
    console.error('[Fulcrum] Auto update check failed:', err);
  }
}

// Expose for manual check from UI
window.checkForUpdates = () => checkForUpdates(true);

/**
 * Play a notification sound locally
 * Uses native system commands for each platform
 */
async function playNotificationSound() {
  try {
    if (NL_OS === 'Darwin') {
      // macOS: use afplay with system sound
      await Neutralino.os.execCommand('afplay /System/Library/Sounds/Glass.aiff');
    } else if (NL_OS === 'Linux') {
      // Linux: try various audio players in order of preference
      try {
        // Try PulseAudio first (most common)
        await Neutralino.os.execCommand('paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null');
      } catch {
        try {
          // Try ALSA
          await Neutralino.os.execCommand('aplay /usr/share/sounds/sound-icons/xylofon.wav 2>/dev/null');
        } catch {
          // Fall back to beep if available
          await Neutralino.os.execCommand('echo -e "\\a" 2>/dev/null');
        }
      }
    } else if (NL_OS === 'Windows') {
      // Windows: use PowerShell to play system sound
      await Neutralino.os.execCommand('powershell -c "[System.Media.SystemSounds]::Exclamation.Play()"');
    }
    console.log('[Fulcrum] Notification sound played');
  } catch (err) {
    // Sound is non-critical, just log the error
    console.error('[Fulcrum] Failed to play notification sound:', err);
  }
}

/**
 * Initialize the application
 */
async function init() {
  // Record start time for minimum loading duration
  loadingStartTime = Date.now();

  try {
    // Initialize Neutralino
    Neutralino.init();

    // Initialize logger (needs Neutralino to be ready)
    await initLogger();
    log.info('Neutralino initialized', { os: NL_OS, version: NL_APPVERSION });

    // Set up native menu for macOS (required for Cmd+C/V/X/A shortcuts to work)
    if (NL_OS === 'Darwin') {
      await setupMacMenu();
      Neutralino.events.on('mainMenuItemClicked', handleMacMenuClick);
      console.log('[Fulcrum] macOS menu configured');
    }

    // Check for --dev flag in command line args
    isDevMode = typeof NL_ARGS !== 'undefined' && NL_ARGS.includes('--dev');
    if (isDevMode) {
      console.log('[Fulcrum] Running in development mode (port 5173)');
    }

    // Set up event listeners
    Neutralino.events.on('windowClose', shutdown);

    // Listen for extension ready (local server)
    Neutralino.events.on('serverReady', (evt) => {
      handleExtensionReady(evt.detail.port);
    });

    Neutralino.events.on('extClientConnect', (evt) => {
      console.log('[Fulcrum] Extension connected:', evt.detail);
    });

    // Listen for messages from iframe (postMessage from Fulcrum frontend)
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'fulcrum:route') {
        currentRoute = {
          pathname: event.data.pathname || '/',
          search: event.data.search || ''
        };
        console.log('[Fulcrum] Route updated:', currentRoute.pathname);
      } else if (event.data?.type === 'fulcrum:notification') {
        // Show native system notification
        const { title, message } = event.data;
        Neutralino.os.showNotification(title, message || '').catch((err) => {
          console.error('[Fulcrum] Failed to show notification:', err);
        });
      } else if (event.data?.type === 'fulcrum:playSound') {
        // Play notification sound locally
        playNotificationSound();
      } else if (event.data?.type === 'fulcrum:openUrl') {
        // Open URL with system handler (for vscode://, cursor://, etc.)
        const { url } = event.data;
        Neutralino.os.open(url).catch((err) => {
          console.error('[Fulcrum] Failed to open URL:', url, err);
        });
      }
    });

    // Start connection flow
    await tryConnect();

    // Check for updates after app is loaded (wait 5 seconds to not block startup)
    setTimeout(autoCheckForUpdates, 5000);

  } catch (err) {
    log.error('Initialization error', { error: String(err), stack: err?.stack });
    showError('Initialization Failed', err.message || 'Could not initialize the application.');
  }
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
