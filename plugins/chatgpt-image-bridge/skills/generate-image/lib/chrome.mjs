// Запуск системного Chrome (или Edge) с отдельным профилем и портом DevTools.
// Никаких флагов, скрывающих автоматизацию: это обычный браузер пользователя
// с открытым портом отладки.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { connect } from './cdp.mjs';

export class BrowserNotFoundError extends Error {}
export class LockBusyError extends Error {}

function candidates() {
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return [
      ...roots.map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  return names.map((name) => {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    return found.status === 0 ? found.stdout.trim() : '';
  });
}

export function findBrowser() {
  const override = process.env.CHATGPT_IMAGE_BROWSER;
  if (override) {
    if (!fs.existsSync(override)) throw new BrowserNotFoundError(`CHATGPT_IMAGE_BROWSER указывает на несуществующий файл: ${override}`);
    return override;
  }
  const found = candidates().find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) {
    throw new BrowserNotFoundError('не найден Chrome или Edge. Установите Google Chrome или укажите путь к браузеру в CHATGPT_IMAGE_BROWSER.');
  }
  return found;
}

// Два Chrome на одном профиле работать не могут: второй запуск просто отдаёт
// адрес первому процессу и завершается. Поэтому вызовы идут строго по одному.
// В замке записан режим: пока открыто окно входа, генерация не ждёт впустую.
export async function acquireLock(lockPath, { mode, timeoutMs, onWait }) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, mode }), { flag: 'wx' });
      return () => releaseLock(lockPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = readLock(lockPath);
    if (!holder || !isAlive(holder.pid)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (holder.mode === 'login' && mode !== 'login') {
      throw new LockBusyError('открыто окно входа chatgpt-image login — закройте его и повторите вызов.');
    }
    if (Date.now() > deadline) {
      throw new LockBusyError(`профиль занят другим вызовом chatgpt-image (pid ${holder.pid}).`);
    }
    if (!announced) {
      onWait?.(holder);
      announced = true;
    }
    await sleep(1000);
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function releaseLock(lockPath) {
  if (readLock(lockPath)?.pid === process.pid) fs.rmSync(lockPath, { force: true });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Запускает браузер и ждёт, пока он напишет порт DevTools в профиль.
// mode: 'hidden' — окно за краем экрана, 'visible' — обычное окно,
//       'headless' — без окна (только для тестов).
// devtools: false — обычный браузер без порта отладки. Так открывается окно
// входа: проверка Cloudflare на auth.openai.com не проходит, пока к браузеру
// подключён DevTools, и бесконечно показывается заново.
export async function launchBrowser({ executable, profileDir, mode, url = 'about:blank', devtools = true }) {
  fs.mkdirSync(profileDir, { recursive: true });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  await closeOrphan(portFile);
  fs.rmSync(portFile, { force: true });

  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (devtools) args.push('--remote-debugging-port=0');
  if (mode === 'hidden') args.push('--window-position=-32000,-32000', '--window-size=1280,900');
  // Позицию задаём явно: иначе Chrome восстановит сохранённую в профиле,
  // а после скрытого режима она за краем экрана.
  if (mode === 'visible') args.push('--window-position=100,60', '--window-size=1100,900');
  if (mode === 'headless') args.push('--headless=new', '--window-size=1280,900');
  args.push(url);

  // На POSIX браузер получает свою группу процессов, чтобы убить её целиком.
  const child = spawn(executable, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
  let exited = false;
  const exitPromise = new Promise((resolve) => child.once('exit', () => { exited = true; resolve(); }));
  child.once('error', () => { exited = true; });

  const browser = {
    process: child,
    exited: exitPromise,
    get running() { return !exited; },
    kill: () => killTree(child),
  };

  if (!devtools) {
    // Если профиль уже открыт другим окном Chrome, новый процесс отдаёт ему
    // адрес и сразу завершается — это надо заметить, а не ждать молча.
    await sleep(1500);
    if (exited) throw new Error('браузер сразу завершился — возможно, профиль уже открыт в другом окне Chrome. Закройте его и повторите.');
    return browser;
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`браузер завершился сразу после запуска: ${executable}`);
    const lines = readPortFile(portFile);
    if (lines) {
      browser.wsUrl = `ws://127.0.0.1:${lines[0]}${lines[1]}`;
      return browser;
    }
    await sleep(100);
  }
  killTree(child);
  throw new Error('браузер не открыл порт DevTools за 30 секунд.');
}

// На Windows прерванный по таймауту вызов завершается без обработчиков выхода,
// и браузер может остаться висеть за краем экрана, занимая профиль. Замок уже
// наш, значит, отвечающий на старом порту браузер — сирота прошлого вызова.
async function closeOrphan(portFile) {
  const lines = readPortFile(portFile);
  if (!lines) return;
  const base = `http://127.0.0.1:${lines[0]}`;
  try {
    const version = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json());
    const connection = await connect(version.webSocketDebuggerUrl);
    await Promise.race([connection.send('Browser.close').catch(() => {}), sleep(3000)]);
    connection.close();
  } catch {
    return; // на порту никого — браузер завершился штатно
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await sleep(200);
  }
}

function readPortFile(portFile) {
  try {
    const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
    return lines[0] && lines[1] ? lines : null;
  } catch {
    return null;
  }
}

export function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export function defaultHome() {
  return process.env.CHATGPT_IMAGE_HOME || path.join(os.homedir(), '.chatgpt-image');
}
