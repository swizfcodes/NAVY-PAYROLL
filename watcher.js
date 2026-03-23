/**
 * Navy Payroll - File Watcher
 * Watches project files and restarts NavyPayroll-App service on changes.
 * Run as: node watcher.js
 * Or add as a third WinSW service via install-service.js
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = __dirname;
const WINSW   = path.join(ROOT, 'NavyPayroll-App.exe');
const DELAY   = 2000; // wait 2s after last change before restarting

const WATCH_DIRS = [
  ROOT,
];

const IGNORE = new Set([
  'node_modules',
  'logs',
  'preferences',
  'notifications',
  'certs',
  'cloud_backups',
  'cache',
  '.vs',
  '.vscode',
  'backups',
  'restores',
  'uploads',
  '.gitignore',
  'storage',
  'query',
  'data',
  'temp',
  '.git',
  'NavyPayroll-App.exe',
  'NavyPayroll-Proxy.exe',
  'NavyPayroll-Watcher.exe',
  'winsw.exe',
  'watcher.js',
]);

const IGNORE_EXT = new Set([
  '.log', '.pem', '.bat', '.xml', '.md',
]);

let restartTimer = null;
let restarting   = false;

function shouldIgnore(filePath) {
  const parts = filePath.split(path.sep);
  for (const part of parts) {
    if (IGNORE.has(part)) return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (IGNORE_EXT.has(ext)) return true;
  return false;
}

function restartService() {
  if (restarting) return;
  restarting = true;

  console.log(`[${new Date().toISOString()}] File change detected — restarting NavyPayroll-App...`);

  try {
    execSync(`"${WINSW}" restart`, { cwd: ROOT, encoding: 'utf8' });
    console.log(`[${new Date().toISOString()}] NavyPayroll-App restarted ✔`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Restart failed:`, e.message);
  }

  restarting = false;
}

function onFileChange(eventType, filename) {
  if (!filename) return;
  const fullPath = path.join(ROOT, filename);
  if (shouldIgnore(fullPath)) return;

  console.log(`[${new Date().toISOString()}] Changed: ${filename}`);

  // Debounce — wait for changes to settle
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(restartService, DELAY);
}

// Watch project root recursively
console.log('Navy Payroll — File Watcher');
console.log('============================');
console.log(`Watching: ${ROOT}`);
console.log(`Restart delay: ${DELAY}ms`);
console.log('Ignoring: node_modules, logs, public, certs, .git');
console.log('');

fs.watch(ROOT, { recursive: true }, onFileChange);

console.log('Watching for file changes... (Ctrl+C to stop)');