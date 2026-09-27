#!/usr/bin/env node
// Генерирует изображение в веб-интерфейсе ChatGPT через браузер и сохраняет его.
// Работает на подписке ChatGPT пользователя — API-ключ OpenAI не нужен.
//
// Использование: chatgpt-image "<промпт>" <выход.png> [--size WxH] [--image <файл>]... [--chat <адрес>]
//                chatgpt-image login
//
// --chat <адрес> — продолжить разговор ChatGPT, в котором уже есть картинка:
// промпт уходит туда как просьба о правках, приложенные раньше референсы
// ChatGPT уже видит.
//
// Коды выхода: 0 — готово (stdout: путь, второй строкой «chat: <адрес
// разговора>», если адрес известен), 1 — ChatGPT не выдал картинку,
// 2 — ошибка аргументов, 3 — нужен вход или действие пользователя в окне
// браузера, 127 — нет подходящего Node или браузера.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'использование: chatgpt-image "<промпт>" <выход.png> [--size WxH] [--image <файл>]... [--chat <адрес>]\n'
  + '               chatgpt-image login';

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

if (typeof WebSocket === 'undefined') {
  process.stderr.write(`chatgpt-image: нужен Node.js 22 или новее, сейчас ${process.version}.\n`);
  process.exit(127);
}

const { connect } = await import('../lib/cdp.mjs');
const chrome = await import('../lib/chrome.mjs');
const chatgpt = await import('../lib/chatgpt.mjs');

// Агент на Windows обычно зовёт скрипт из Git Bash и передаёт пути вида
// /c/Users/... или /tmp/... — Node их не понимает, переводим через cygpath.
function nativePath(p) {
  if (process.platform === 'win32' && p.startsWith('/')) {
    try {
      return execFileSync('cygpath', ['-w', p], { encoding: 'utf8' }).trim();
    } catch {
      const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
      if (drive) return `${drive[1].toUpperCase()}:${drive[2] ?? '/'}`;
    }
  }
  return p;
}

// Путь для вывода: на Windows с прямыми слешами, как у codex-image.
function displayPath(p) {
  return process.platform === 'win32' ? p.replaceAll('\\', '/') : p;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === 'login') return { command: 'login' };
  if (argv.length < 2) throw new CliError(2, USAGE);

  const [prompt, out, ...rest] = argv;
  if (!prompt.trim()) throw new CliError(2, 'chatgpt-image: промпт пустой');

  let size = '';
  let chat = '';
  const images = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--size' || arg === '--image' || arg === '--chat') {
      const value = rest[i + 1];
      if (value === undefined) {
        throw new CliError(2, {
          '--size': 'chatgpt-image: для --size нужно значение (WxH, например 1536x1024)',
          '--image': 'chatgpt-image: для --image нужен путь к файлу',
          '--chat': 'chatgpt-image: для --chat нужен адрес разговора ChatGPT',
        }[arg]);
      }
      if (arg === '--size') size = value;
      else if (arg === '--chat') chat = parseChatUrl(value);
      else images.push(value);
      i++;
    } else {
      throw new CliError(2, `chatgpt-image: неизвестный аргумент: ${arg}`);
    }
  }

  if (size && !/^[1-9][0-9]*x[1-9][0-9]*$/.test(size)) {
    throw new CliError(2, `chatgpt-image: --size должен быть в формате WxH (например 1536x1024), получено: ${size}`);
  }

  const outPath = path.resolve(nativePath(out));
  if (!fs.existsSync(path.dirname(outPath)) || !fs.statSync(path.dirname(outPath)).isDirectory()) {
    throw new CliError(2, `chatgpt-image: папка для результата не существует: ${displayPath(path.dirname(outPath))}`);
  }

  const imagePaths = images.map((image) => {
    const resolved = path.resolve(nativePath(image));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new CliError(2, `chatgpt-image: картинка не найдена: ${image}`);
    }
    return resolved;
  });

  return { command: 'generate', prompt, outPath, size, images: imagePaths, chat };
}

// --chat принимает только адрес разговора на chatgpt.com. В тестах
// (CHATGPT_IMAGE_URL) — ещё и разговор на том же сервере, что и макет.
function parseChatUrl(value) {
  const origins = [new URL(chatgpt.CHAT_URL).origin];
  const testUrl = process.env.CHATGPT_IMAGE_URL;
  if (testUrl && URL.canParse(testUrl)) origins.push(new URL(testUrl).origin);
  const url = URL.canParse(value) ? new URL(value) : null;
  const chat = url && !url.search && !url.hash && origins.includes(url.origin) ? chatgpt.conversationUrl(value) : '';
  if (!chat) {
    throw new CliError(2, `chatgpt-image: --chat должен быть адресом разговора вида https://chatgpt.com/c/<id> или https://chatgpt.com/g/<id>/c/<id>, получено: ${value}`);
  }
  return chat;
}

function readTimeout() {
  const raw = process.env.CHATGPT_IMAGE_TIMEOUT ?? '300';
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new CliError(2, `chatgpt-image: CHATGPT_IMAGE_TIMEOUT должен быть числом секунд, получено: ${raw}`);
  }
  return Number(raw) * 1000;
}

// Во временном чате ChatGPT картинки не рисует, поэтому генерации идут в
// обычные чаты. Чтобы не засорять историю, их можно складывать в отдельный
// проект: его адрес задаётся в config.json как projectUrl.
function readProjectUrl(home) {
  const configPath = path.join(home, 'config.json');
  if (!fs.existsSync(configPath)) return '';
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new CliError(2, `chatgpt-image: не удалось прочитать ${displayPath(configPath)}: ${error.message}`);
  }
  const url = config.projectUrl ?? '';
  if (url && !/^https:\/\/chatgpt\.com\/g\/g-p-[^/]+\/project\/?$/.test(url)) {
    throw new CliError(2, `chatgpt-image: projectUrl в ${displayPath(configPath)} должен быть адресом проекта вида https://chatgpt.com/g/g-p-…/project, получено: ${url}`);
  }
  return url;
}

function settings() {
  const home = chrome.defaultHome();
  return {
    home,
    profileDir: path.join(home, 'profile'),
    lockPath: path.join(home, 'lock'),
    // Только для тестов на макете страницы: без окна Cloudflare пускает хуже.
    windowMode: process.env.CHATGPT_IMAGE_HEADLESS === '1' ? 'headless' : 'hidden',
  };
}

// Куда отправлять промпт: в разговор из --chat, иначе в новый чат проекта
// из config.json или просто в новый чат.
function startUrl(home, chat) {
  return chat || process.env.CHATGPT_IMAGE_URL || readProjectUrl(home) || chatgpt.CHAT_URL;
}

function findBrowserOrExit() {
  try {
    return chrome.findBrowser();
  } catch (error) {
    if (error instanceof chrome.BrowserNotFoundError) throw new CliError(127, `chatgpt-image: ${error.message}`);
    throw error;
  }
}

async function lockOrExit(lockPath, mode, timeoutMs) {
  try {
    return await chrome.acquireLock(lockPath, {
      mode,
      timeoutMs,
      onWait: () => process.stderr.write('chatgpt-image: профиль занят другим вызовом, жду…\n'),
    });
  } catch (error) {
    if (error instanceof chrome.LockBusyError) throw new CliError(error.message.includes('login') ? 3 : 1, `chatgpt-image: ${error.message}`);
    throw error;
  }
}

// Браузер нужно остановить при любом выходе, в том числе по Ctrl+C и по
// таймауту агента (SIGTERM), иначе он останется висеть за краем экрана.
const cleanups = [];
function onExit(fn) {
  cleanups.push(fn);
}
function runCleanups() {
  while (cleanups.length) {
    try {
      cleanups.pop()();
    } catch {
      // Уборка не должна превращать результат в ошибку.
    }
  }
}
process.on('exit', runCleanups);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => process.exit(code));
}

async function login() {
  const { home, profileDir, lockPath } = settings();
  fs.mkdirSync(home, { recursive: true });
  const executable = findBrowserOrExit();
  onExit(await lockOrExit(lockPath, 'login', readTimeout()));

  // Окно входа — обычный Chrome без DevTools: иначе Cloudflare не пропускает
  // на auth.openai.com. Скрипт в это окно не вмешивается и просто ждёт закрытия.
  const startPage = path.join(home, 'start.html');
  fs.writeFileSync(startPage, chatgpt.loginStartPage());
  const browser = await chrome.launchBrowser({ executable, profileDir, mode: 'visible', url: pathToFileURL(startPage).href, devtools: false });
  onExit(browser.kill);
  process.stderr.write('chatgpt-image: войдите в ChatGPT в открывшемся окне браузера и закройте окно, когда увидите чат.\n'
    + 'Если chatgpt.com доступен только через прокси, установите в этом окне то же расширение прокси, что и в основном браузере.\n');
  await browser.exited;
  return 0;
}

// Возвращает строки для stdout: путь к картинке и, если известен, адрес
// разговора — чтобы следующим вызовом с --chat попросить правки.
async function generate({ prompt, outPath, size, images, chat }) {
  const { home, profileDir, lockPath, windowMode } = settings();
  const url = startUrl(home, chat);
  const timeoutMs = readTimeout();
  fs.mkdirSync(home, { recursive: true });
  if (!fs.existsSync(profileDir) && !process.env.CHATGPT_IMAGE_URL) {
    throw new CliError(3, 'chatgpt-image: профиль браузера ещё не настроен. Выполните chatgpt-image login и войдите в ChatGPT.');
  }
  const executable = findBrowserOrExit();
  onExit(await lockOrExit(lockPath, 'generate', timeoutMs));

  const browser = await chrome.launchBrowser({ executable, profileDir, mode: windowMode });
  onExit(browser.kill);
  const connection = await connect(browser.wsUrl);
  onExit(() => connection.close());

  let page;
  try {
    ({ page } = await chatgpt.openChat(connection, url));
    const image = await chatgpt.generateImage(page, { prompt, size, images, timeoutMs, followUp: !!chat });
    const finalPath = withExtension(outPath, image.extension);
    fs.writeFileSync(finalPath, image.data);
    await closeBrowser(connection, browser);
    return [displayPath(finalPath), ...(image.chatUrl ? [`chat: ${image.chatUrl}`] : [])];
  } catch (error) {
    if (!(error instanceof chatgpt.ChatGptError)) throw error;
    const diagnostics = page ? await saveDiagnostics(page) : '';
    throw new CliError(error.needsUser ? 3 : 1, `chatgpt-image: ${error.message}${diagnostics}`);
  }
}

// Если ChatGPT отдал не тот формат, что в имени файла, честнее поправить
// расширение и напечатать фактический путь, чем записать WebP в .png.
function withExtension(outPath, extension) {
  const current = path.extname(outPath).toLowerCase();
  const same = current === `.${extension}` || (extension === 'jpg' && current === '.jpeg');
  return same ? outPath : outPath.slice(0, outPath.length - current.length) + `.${extension}`;
}

async function closeBrowser(connection, browser) {
  try {
    await Promise.race([connection.send('Browser.close'), chrome.sleep(3000)]);
    await Promise.race([browser.exited, chrome.sleep(5000)]);
  } catch {
    // Если закрыть вежливо не вышло, уборка при выходе добьёт процесс.
  }
}

// Скриншот и HTML страницы на момент ошибки — чтобы было видно, что пошло не
// так, без повторного запуска и лишней траты лимитов.
async function saveDiagnostics(page) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-image-'));
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(dir, 'screenshot.png'), Buffer.from(data, 'base64'));
    const html = await chatgpt.pageHtml(page);
    fs.writeFileSync(path.join(dir, 'page.html'), html);
    return `\n(скриншот и HTML страницы: ${displayPath(dir)})`;
  } catch {
    return '';
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === 'login') return await login();
    process.stdout.write(`${(await generate(args)).join('\n')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      return error.code;
    }
    process.stderr.write(`chatgpt-image: ${error.message}\n`);
    return 1;
  }
}

process.exitCode = await main();
runCleanups();
process.exit(process.exitCode);
