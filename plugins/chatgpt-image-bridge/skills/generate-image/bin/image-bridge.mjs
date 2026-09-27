#!/usr/bin/env node
// Единая точка входа скилла generate-image: выбирает режим генерации и
// передаёт вызов нужному скрипту — codex-image (Codex CLI) или
// chatgpt-image.mjs (веб-интерфейс ChatGPT в браузере).
//
// Использование: image-bridge "<промпт>" <выход.png> [--size WxH] [--image <файл>]... [--chat <адрес>] [--via codex|web]
//                image-bridge login [--via codex|web]
//                image-bridge mode [codex|web]
//
// Режим берётся из первого заданного источника: --via, переменная
// CHATGPT_IMAGE_MODE, ключ "mode" в <CHATGPT_IMAGE_HOME или ~/.chatgpt-image>/config.json,
// иначе web. `mode codex|web` сохраняет режим в config.json.
//
// Все аргументы, кроме --via, уходят выбранному скрипту без изменений, его
// вывод и код выхода возвращаются как есть. Сам диспетчер выходит с кодом 2
// при ошибке аргументов или режима и с кодом 127, если для режима codex не
// нашёлся bash. Файлы из --image он до передачи проверяет сам: в любом режиме
// принимаются только картинки PNG, JPEG, WebP или GIF.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageFileExtension } from '../lib/chatgpt.mjs';

const MODES = ['codex', 'web'];
const DEFAULT_MODE = 'web';
// Опции скриптов со значением: значение переносится как есть, даже если
// выглядит как --via (например, файл с таким именем в --image).
const VALUE_OPTIONS = ['--size', '--image', '--chat'];

const binDir = path.dirname(fileURLToPath(import.meta.url));
const codexScript = path.join(binDir, 'codex-image');
const webScript = path.join(binDir, 'chatgpt-image.mjs');

const USAGE = 'использование: image-bridge "<промпт>" <выход.png> [--size WxH] [--image <файл>]... [--chat <адрес>] [--via codex|web]\n'
  + '               image-bridge login [--via codex|web]\n'
  + '               image-bridge mode [codex|web]';

const NO_BASH = 'image-bridge: для режима codex нужен bash — на Windows это Git Bash из Git for Windows (https://git-scm.com), '
  + 'на macOS и Linux он есть из коробки. Или переключитесь на режим web: image-bridge mode web.';
const NO_NODE = `image-bridge: не удалось запустить Node.js: ${process.execPath}`;

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Путь для сообщений: на Windows с прямыми слешами, как у скриптов режимов.
function displayPath(p) {
  return process.platform === 'win32' ? p.replaceAll('\\', '/') : p;
}

// Пути из Git Bash (/c/Users/..., /tmp/...) переводятся через cygpath, как в
// chatgpt-image: диспетчер должен прочитать тот же файл, что и скрипт режима.
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

// --image уходит в ChatGPT или codex, поэтому до передачи проверяется по
// содержимому: только картинки. Иначе агент, которому подсунули инструкцию
// в промпте, мог бы отправить туда, например, ключ SSH. Файл, который не
// удалось найти или прочитать, тоже не пропускается.
function checkImages(images) {
  for (const image of images) {
    const file = path.resolve(nativePath(image));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new CliError(2, `image-bridge: картинка не найдена: ${image}`);
    }
    let extension;
    try {
      extension = imageFileExtension(file);
    } catch (error) {
      throw new CliError(2, `image-bridge: не удалось прочитать картинку ${image}: ${error.message}`);
    }
    if (!extension) {
      throw new CliError(2, `image-bridge: --image принимает только картинки PNG, JPEG, WebP или GIF: ${image}`);
    }
  }
}

// Та же папка, что у chatgpt-image: профиль браузера, config.json, замок.
function configPath() {
  const home = process.env.CHATGPT_IMAGE_HOME || path.join(os.homedir(), '.chatgpt-image');
  return path.join(home, 'config.json');
}

function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new CliError(2, `image-bridge: не удалось прочитать ${displayPath(file)}: ${error.message}`);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new CliError(2, `image-bridge: не удалось прочитать ${displayPath(file)}: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new CliError(2, `image-bridge: в ${displayPath(file)} должен быть JSON-объект, например { "mode": "web" }`);
  }
  return config;
}

// Режим и его источник: --via > CHATGPT_IMAGE_MODE > config.json > по умолчанию.
// Неверное значение — ошибка с названием источника, а не тихий откат к web.
function resolveMode(via) {
  if (via !== undefined) {
    if (!MODES.includes(via)) throw new CliError(2, `image-bridge: --via должен быть codex или web, получено: ${via}`);
    return { mode: via, source: '--via' };
  }
  const env = process.env.CHATGPT_IMAGE_MODE;
  if (env) {
    if (!MODES.includes(env)) throw new CliError(2, `image-bridge: CHATGPT_IMAGE_MODE должен быть codex или web, получено: ${env}`);
    return { mode: env, source: 'CHATGPT_IMAGE_MODE' };
  }
  const file = configPath();
  const config = readConfig(file);
  if (config.mode !== undefined) {
    if (!MODES.includes(config.mode)) {
      throw new CliError(2, `image-bridge: "mode" в ${displayPath(file)} должен быть "codex" или "web", получено: ${JSON.stringify(config.mode)}`);
    }
    return { mode: config.mode, source: 'config.json' };
  }
  return { mode: DEFAULT_MODE, source: 'по умолчанию' };
}

// Вынимает --via из аргументов, остальное оставляет в исходном порядке.
// Значения --image запоминает отдельно — для проверки перед передачей.
function parseArgs(argv) {
  const rest = [];
  const images = [];
  let via;
  let chat = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--via') {
      if (i + 1 >= argv.length) throw new CliError(2, 'image-bridge: для --via нужно значение: codex или web');
      via = argv[++i];
      continue;
    }
    rest.push(arg);
    // Первые два аргумента — промпт и путь, опции идут после них.
    if (rest.length > 2 && VALUE_OPTIONS.includes(arg)) {
      if (arg === '--chat') chat = true;
      if (i + 1 < argv.length) {
        if (arg === '--image') images.push(argv[i + 1]);
        rest.push(argv[++i]);
      }
    }
  }
  return { via, rest, chat, images };
}

// Скрипт режима работает в том же терминале: stdio общие, код выхода — его.
// Сигналы передаются ему, чтобы он успел остановить codex или браузер и
// убрать временные файлы. На Windows сигналов как таковых нет: Ctrl+C и
// закрытие консоли скрипт получает сам, а child.kill там — это
// TerminateProcess без уборки, поэтому диспетчер просто ждёт его завершения.
function forward(command, args, notFound) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    const relays = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
      const relay = () => {
        if (process.platform !== 'win32' && child.exitCode === null && child.signalCode === null) child.kill(signal);
      };
      process.on(signal, relay);
      return [signal, relay];
    });
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      for (const [signal, relay] of relays) process.off(signal, relay);
      resolve(code);
    };
    child.once('error', (error) => {
      if (error.code === 'ENOENT') {
        process.stderr.write(`${notFound}\n`);
        finish(127);
      } else {
        process.stderr.write(`image-bridge: не удалось запустить ${command}: ${error.message}\n`);
        finish(1);
      }
    });
    child.once('exit', (code, signal) => {
      finish(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}

// bash для codex-image. На Windows bash.exe из System32 и WindowsApps —
// запускатель WSL: путь Windows к скрипту ему не передать, нужен bash из
// Git for Windows. Из PowerShell и cmd в PATH обычно есть только папка
// с git.exe, тогда bash ищется рядом с ней.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const override = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override && isFile(override)) return override;

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir));
  const systemRoot = path.resolve(process.env.SystemRoot || 'C:\\Windows').toLowerCase();
  const isWslLauncher = (dir) => {
    const lower = dir.toLowerCase();
    return lower === systemRoot || lower.startsWith(`${systemRoot}\\`) || lower.endsWith('\\windowsapps');
  };
  const fromPath = dirs.filter((dir) => !isWslLauncher(dir)).map((dir) => path.join(dir, 'bash.exe'));
  const nearGit = dirs.filter((dir) => isFile(path.join(dir, 'git.exe')))
    .flatMap((dir) => [path.join(dir, '..', 'bin', 'bash.exe'), path.join(dir, '..', '..', 'bin', 'bash.exe')]);
  return [...fromPath, ...nearGit].find(isFile) ?? '';
}

function print(line) {
  process.stdout.write(`${line}\n`);
}

function modeCommand(args, via) {
  if (via !== undefined) {
    throw new CliError(2, 'image-bridge: --via не используется с mode — режим указывается напрямую: mode codex или mode web');
  }
  if (args.length > 1) throw new CliError(2, USAGE);
  if (args.length === 0) {
    const { mode, source } = resolveMode();
    print(`${mode} (${source})`);
    return 0;
  }

  const [mode] = args;
  if (!MODES.includes(mode)) throw new CliError(2, `image-bridge: режим должен быть codex или web, получено: ${mode}`);
  // Остальные ключи (projectUrl) сохраняются. Битый файл не перезаписываем:
  // пусть пользователь сам решит, что в нём было.
  const file = configPath();
  const config = readConfig(file);
  config.mode = mode;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  print(`${mode} (config.json)`);

  const env = process.env.CHATGPT_IMAGE_MODE;
  if (env && env !== mode) {
    process.stderr.write(`image-bridge: режим сохранён, но пока задана переменная CHATGPT_IMAGE_MODE=${env}, используется она.\n`);
  }
  if (mode === 'web' && !fs.existsSync(path.join(path.dirname(file), 'profile'))) {
    process.stderr.write(`image-bridge: профиль браузера ещё не настроен — перед первой генерацией выполните: node ${displayPath(fileURLToPath(import.meta.url))} login\n`);
  }
  return 0;
}

async function loginCommand(args, via) {
  if (args.length) throw new CliError(2, USAGE);
  const { mode } = resolveMode(via);
  if (mode === 'codex') {
    print('Режим codex: вход выполняется в самом Codex CLI — выполните в терминале codex login и войдите через подписку ChatGPT (проверка: codex login status).');
    return 0;
  }
  return forward(process.execPath, [webScript, 'login'], NO_NODE);
}

async function generateCommand(args, via, chat, images) {
  if (args.length < 2) throw new CliError(2, USAGE);
  const { mode, source } = resolveMode(via);
  if (mode === 'codex' && chat) {
    throw new CliError(2, `image-bridge: --chat работает только в режиме web, а сейчас режим codex (${source}). `
      + 'В режиме codex правку делают новым вызовом с прошлой картинкой в --image; продолжить разговор ChatGPT можно с --via web.');
  }
  checkImages(images);
  if (mode === 'web') return forward(process.execPath, [webScript, ...args], NO_NODE);

  const bash = findBash();
  if (!bash) throw new CliError(127, NO_BASH);
  return forward(bash, [displayPath(codexScript), ...args], NO_BASH);
}

async function main() {
  try {
    const { via, rest, chat, images } = parseArgs(process.argv.slice(2));
    if (rest[0] === 'mode') return modeCommand(rest.slice(1), via);
    if (rest[0] === 'login') return await loginCommand(rest.slice(1), via);
    return await generateCommand(rest, via, chat, images);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      return error.code;
    }
    process.stderr.write(`image-bridge: ${error.message}\n`);
    return 1;
  }
}

process.exitCode = await main();
