// Тесты для chatgpt-image. Вместо chatgpt.com — локальный макет страницы
// (tests/fixtures/fake-chatgpt.html), браузер — настоящий Chrome без окна.
// Лимиты ChatGPT не тратятся, вход не нужен.
//
// Запуск: node --test tests/chatgpt-image.test.mjs

import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(repo, 'plugins', 'chatgpt-image-bridge', 'skills', 'generate-image');
const cli = path.join(skill, 'bin', 'chatgpt-image.mjs');
const chrome = await import(pathToFileURL(path.join(skill, 'lib', 'chrome.mjs')).href);
const chatgpt = await import(pathToFileURL(path.join(skill, 'lib', 'chatgpt.mjs')).href);
const fixture = fs.readFileSync(path.join(repo, 'tests', 'fixtures', 'fake-chatgpt.html'));
// Картинка 1×1, которую макет «сгенерировал».
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// Картинка из прошлого сообщения разговора (file_old) — другой пиксель.
const OLD_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

let server;
let baseUrl;
let recorded = [];
// Запросы картинок estuary: кто просил (host), и как — тегом img (dest image)
// или скачиванием через fetch (dest empty).
let estuary = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-image-test-'));

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/record') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { recorded.push(JSON.parse(body)); res.end(); });
    } else if (req.url.startsWith('/backend-api/estuary/content')) {
      estuary.push({ host: req.headers.host, dest: req.headers['sec-fetch-dest'] });
      // Картинки отдаются и чужому origin вместе с куками — как сервер, который
      // сам хочет, чтобы его картинку скачали. Иначе скачивание с другого
      // origin запретил бы браузер, и тест на него ничего бы не проверял.
      const cors = req.headers.origin ? { 'access-control-allow-origin': req.headers.origin, 'access-control-allow-credentials': 'true' } : {};
      res.writeHead(200, { 'content-type': 'image/png', ...cors }).end(req.url.includes('id=file_old') ? OLD_PNG : PNG);
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixture);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let runs = 0;
function run(args, { mode, env = {}, home = path.join(tmp, `home-${runs++}`) } = {}) {
  recorded = [];
  estuary = [];
  const fullEnv = { ...process.env, CHATGPT_IMAGE_HOME: home, CHATGPT_IMAGE_HEADLESS: '1', ...env };
  if (mode) fullEnv.CHATGPT_IMAGE_URL = `${baseUrl}?mode=${mode}`;
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: fullEnv, timeout: 90_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, lines: stdout.split(/\r?\n/).filter(Boolean), stderr, home });
    });
  });
}

const out = (name) => path.join(tmp, name);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// Разговор, в который макет переходит после отправки в новом чате.
const conversation = () => `${new URL(baseUrl).origin}/c/fake-conversation`;

// Диагностику ошибки (скриншот области чата и state.json) тест читает и
// удаляет: файлы, текст state.json и ширину скриншота из заголовка PNG.
function takeDiagnostics(stderr) {
  const dir = /скриншот области чата и состояние страницы: (.+)\)/.exec(stderr)?.[1];
  assert.ok(dir, stderr);
  try {
    const files = fs.readdirSync(dir).sort();
    const stateText = files.includes('state.json') ? fs.readFileSync(path.join(dir, 'state.json'), 'utf8') : '';
    const screenshot = files.includes('screenshot.png') ? fs.readFileSync(path.join(dir, 'screenshot.png')) : null;
    return { files, stateText, screenshotWidth: screenshot ? screenshot.readUInt32BE(16) : 0 };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// После выхода браузер должен быть остановлен, а замок профиля снят.
async function assertCleanedUp(home) {
  assert.equal(fs.existsSync(path.join(home, 'lock')), false, 'замок профиля не снят');
  const portFile = path.join(home, 'profile', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) return;
  const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
  await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`), 'браузер остался запущен');
}

// --- аргументы -------------------------------------------------------------

test('без аргументов — подсказка и код 2', async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /использование/);
});

test('ошибки аргументов — код 2', async () => {
  const cases = [
    [['кот', out('a.png'), '--size', '12'], /--size должен быть в формате WxH/],
    [['кот', out('a.png'), '--size'], /для --size нужно значение/],
    [['кот', out('a.png'), '--image'], /для --image нужен путь/],
    [['кот', out('a.png'), '--bogus'], /неизвестный аргумент/],
    [['кот', path.join(tmp, 'нет-такой-папки', 'a.png')], /папка для результата не существует/],
    [['кот', out('a.png'), '--image', out('нет.png')], /картинка не найдена/],
    [['   ', out('a.png')], /промпт пустой/],
    [['кот', out('a.png'), '--chat'], /для --chat нужен адрес разговора/],
    [['кот', out('a.png'), '--chat', 'https://chatgpt.com/'], /--chat должен быть адресом разговора/],
    [['кот', out('a.png'), '--chat', 'https://chatgpt.com/g/g-p-abc/project'], /--chat должен быть адресом разговора/],
    [['кот', out('a.png'), '--chat', 'https://example.com/c/abc'], /--chat должен быть адресом разговора/],
    [['кот', out('a.png'), '--chat', 'https://chatgpt.com/c/abc?model=gpt-4o'], /--chat должен быть адресом разговора/],
    [['кот', out('a.png'), '--chat', 'chatgpt.com/c/abc'], /--chat должен быть адресом разговора/],
  ];
  for (const [args, message] of cases) {
    const r = await run(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message);
  }
});

test('--image принимает только картинки: другой файл — код 2, браузер не запускается', async () => {
  const reference = out('good-reference.png');
  fs.writeFileSync(reference, PNG);
  const files = {
    'id_ed25519.png': '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----\n',
    'notes.txt': 'пароль от почты',
    'empty.png': '',
    'short.png': PNG.subarray(0, 4),
  };
  for (const [name, content] of Object.entries(files)) {
    const file = out(name);
    fs.writeFileSync(file, content);
    // Настоящая картинка первой: проверяется каждый --image, а не только первый.
    const r = await run(['кот', out('a.png'), '--image', reference, '--image', file], { mode: 'ok' });
    assert.equal(r.code, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /^chatgpt-image: --image принимает только картинки PNG, JPEG, WebP или GIF: /);
    assert.ok(r.stderr.includes(name), r.stderr);
    assert.equal(recorded.length, 0, 'промпт ушёл в ChatGPT');
    assert.equal(fs.existsSync(r.home), false, 'вызов дошёл до запуска браузера');
  }
});

test('формат картинки определяется по первым байтам', () => {
  const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  assert.equal(chatgpt.imageExtension(PNG), 'png');
  assert.equal(chatgpt.imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])), 'jpg');
  assert.equal(chatgpt.imageExtension(Buffer.from('RIFF\x24\0\0\0WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(chatgpt.imageExtension(GIF), 'gif');
  assert.equal(chatgpt.imageExtension(Buffer.from('GIF87a\x01\0\x01\0', 'latin1')), 'gif');
  assert.equal(chatgpt.imageExtension(Buffer.from('GIF88a\x01\0\x01\0', 'latin1')), '');
  assert.equal(chatgpt.imageExtension(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), '');
  assert.equal(chatgpt.imageExtension(Buffer.alloc(0)), '');

  const gifFile = out('reference.gif');
  fs.writeFileSync(gifFile, GIF);
  assert.equal(chatgpt.imageFileExtension(gifFile), 'gif');
  const textFile = out('reference.txt');
  fs.writeFileSync(textFile, 'не картинка');
  assert.equal(chatgpt.imageFileExtension(textFile), '');
});

test('некорректный CHATGPT_IMAGE_TIMEOUT — код 2', async () => {
  const r = await run(['кот', out('a.png')], { mode: 'ok', env: { CHATGPT_IMAGE_TIMEOUT: 'soon' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /CHATGPT_IMAGE_TIMEOUT/);
});

test('некорректный projectUrl в config.json — код 2', async () => {
  const home = path.join(tmp, 'home-config');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ projectUrl: 'https://example.com/' }));
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [cli, 'кот', out('a.png')], { env: { ...process.env, CHATGPT_IMAGE_HOME: home } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stderr });
    });
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /projectUrl/);
});

test('профиль не настроен — код 3 и подсказка про login', async () => {
  const r = await run(['кот', out('a.png')]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /chatgpt-image login/);
});

test('адрес разговора: без query и hash, не разговор — пустая строка', () => {
  assert.equal(chatgpt.conversationUrl('https://chatgpt.com/c/68d7-ab12?model=gpt-4o#x'), 'https://chatgpt.com/c/68d7-ab12');
  assert.equal(chatgpt.conversationUrl('https://chatgpt.com/g/g-p-abc-images/c/68d7-ab12/'), 'https://chatgpt.com/g/g-p-abc-images/c/68d7-ab12');
  assert.equal(chatgpt.conversationUrl('https://chatgpt.com/'), '');
  assert.equal(chatgpt.conversationUrl('https://chatgpt.com/g/g-p-abc-images/project'), '');
  assert.equal(chatgpt.conversationUrl('about:blank'), '');
});

test('браузер не найден — код 127', async () => {
  const r = await run(['кот', out('a.png')], { mode: 'ok', env: { CHATGPT_IMAGE_BROWSER: path.join(tmp, 'нет-браузера.exe') } });
  assert.equal(r.code, 127);
  assert.match(r.stderr, /CHATGPT_IMAGE_BROWSER/);
});

// --- генерация на макете ---------------------------------------------------

test('генерирует картинку, печатает путь и адрес разговора, убирает за собой', async () => {
  const target = out('ok.png');
  const r = await run(['рыжий кот на подоконнике', target, '--size', '1536x1024'], { mode: 'ok' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.lines.length, 2, r.stdout);
  assert.ok(samePath(r.lines[0], target), r.stdout);
  // Адрес без ?mode=ok: query скрипт отрезает.
  assert.equal(r.lines[1], `chat: ${conversation()}`);
  assert.deepEqual(fs.readFileSync(target), PNG);

  assert.equal(recorded.length, 1);
  assert.match(recorded[0].prompt, /image generation tool/);
  assert.match(recorded[0].prompt, /Aspect ratio 3:2 \(about 1536x1024 px\)/);
  assert.match(recorded[0].prompt, /Prompt: рыжий кот на подоконнике/);
  await assertCleanedUp(r.home);
});

test('прикладывает референсы через --image и ждёт их загрузки', async () => {
  const reference = out('reference.png');
  fs.writeFileSync(reference, PNG);
  const r = await run(['перекрась в синий', out('edit.png'), '--image', reference], { mode: 'ok' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(recorded[0].files, ['reference.png']);
  assert.match(recorded[0].prompt, /Use the attached image as the prompt describes/);
});

test('исправляет расширение под фактический формат', async () => {
  const r = await run(['кот', out('photo.jpg')], { mode: 'ok' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(samePath(r.lines[0], out('photo.png')), r.stdout);
  assert.equal(fs.existsSync(out('photo.jpg')), false);
});

test('--chat продолжает разговор: новая картинка, а не старая, без повторных референсов', async () => {
  const target = out('follow-up.png');
  // Старые сообщения макет рисует через 800 мс после загрузки, а ответ на
  // новое — с задержкой: если посчитать ответы раньше истории, скрипт
  // вернул бы file_old.
  const r = await run(['сделай кота чёрным', target, '--chat', conversation()], { mode: 'ok' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(samePath(r.lines[0], target), r.stdout);
  assert.equal(r.lines[1], `chat: ${conversation()}`);
  assert.deepEqual(fs.readFileSync(target), PNG, 'вернулась картинка из прошлого сообщения');

  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].files, []);
  assert.match(recorded[0].prompt, /^Create a new version of the previous image with your image generation tool/);
  assert.match(recorded[0].prompt, /Do not ask clarifying questions/);
  assert.match(recorded[0].prompt, /Changes: сделай кота чёрным$/);
  await assertCleanedUp(r.home);
});

test('ответ без картинки — код 1, текст ответа и диагностика без данных сессии', async () => {
  const r = await run(['кот', out('refusal.png')], { mode: 'refusal' });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /ответил без картинки: Я не могу создать такое изображение/);
  const diagnostics = takeDiagnostics(r.stderr);
  assert.deepEqual(diagnostics.files, ['screenshot.png', 'state.json']);
  assert.ok(!diagnostics.files.some((name) => name.endsWith('.html')), 'HTML страницы сохранён');

  // Только состояние страницы — без HTML, скриптов, токена, email и боковой
  // панели. Адрес — без query.
  const state = JSON.parse(diagnostics.stateText);
  assert.deepEqual(state, {
    url: conversation(),
    title: 'ChatGPT',
    composer: true,
    loginButton: false,
    authPage: false,
    challenge: false,
    stopButton: false,
    assistantTurns: 1,
    lastAssistantText: 'Я не могу создать такое изображение.',
  });
  assert.doesNotMatch(diagnostics.stateText, /<script/i);
  assert.doesNotMatch(diagnostics.stateText, /eyJ/);
  assert.doesNotMatch(diagnostics.stateText, /user@example\.com|Секретный чат/);

  // Скриншот — только область чата: без боковой панели шириной 260 px.
  assert.ok(diagnostics.screenshotWidth > 0 && diagnostics.screenshotWidth <= 1280 - 260, `ширина скриншота ${diagnostics.screenshotWidth}`);
  await assertCleanedUp(r.home);
});

test('картинку с другого origin не скачивает — ждёт до таймаута, код 1', async () => {
  const target = out('foreign.png');
  const r = await run(['кот', target], { mode: 'foreign', env: { CHATGPT_IMAGE_TIMEOUT: '6' } });
  assert.equal(r.code, 1, `${r.stdout}${r.stderr}`);
  const diagnostics = takeDiagnostics(r.stderr);
  assert.match(r.stderr, /не появилась за 6 секунд/);
  assert.equal(fs.existsSync(target), false);
  // Картинка на странице загрузилась с localhost — то есть отсеял её именно
  // origin, а не ошибка загрузки. Но скачать её скрипт не пытался.
  const port = new URL(baseUrl).port;
  assert.ok(estuary.some((request) => request.host === `localhost:${port}` && request.dest === 'image'), JSON.stringify(estuary));
  assert.deepEqual(estuary.filter((request) => request.dest !== 'image'), [], 'картинку скачивали');
  assert.equal(JSON.parse(diagnostics.stateText).url, conversation());
  await assertCleanedUp(r.home);
});

test('страница ушла с chatgpt.com — картинку с её origin не скачивает, код 1', async () => {
  const target = out('moved.png');
  const r = await run(['кот', target], { mode: 'moved' });
  assert.equal(r.code, 1, `${r.stdout}${r.stderr}`);
  const diagnostics = takeDiagnostics(r.stderr);
  assert.match(r.stderr, /картинка лежит не на chatgpt\.com \(http:\/\/localhost:\d+\), скачивать её не стал/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(recorded.length, 1, 'промпт не дошёл до страницы на localhost');
  assert.deepEqual(estuary.filter((request) => request.dest !== 'image'), [], 'картинку скачивали');
  assert.match(JSON.parse(diagnostics.stateText).url, /^http:\/\/localhost:\d+\/c\/fake-conversation$/);
  await assertCleanedUp(r.home);
});

test('нет входа в ChatGPT — код 3', async () => {
  const r = await run(['кот', out('login.png')], { mode: 'login' });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /chatgpt-image login/);
  await assertCleanedUp(r.home);
});

test('следующий вызов закрывает браузер, брошенный убитым вызовом', async () => {
  // Что остаётся после вызова, убитого без обработчиков выхода: браузер на
  // профиле и замок с pid завершившегося процесса. Сам вызов тут не убиваем:
  // на Windows Node завершает запущенный им браузер вместе с собой (job
  // object libuv), и сироты бы не было — поэтому браузер запускает тест.
  const home = path.join(tmp, 'home-orphan');
  const orphan = await chrome.launchBrowser({ executable: chrome.findBrowser(), profileDir: path.join(home, 'profile'), mode: 'headless' });
  try {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(path.join(home, 'lock'), JSON.stringify({ pid: deadPid, mode: 'generate' }));
    const orphanVersion = `http://127.0.0.1:${new URL(orphan.wsUrl).port}/json/version`;
    await fetch(orphanVersion); // браузер-сирота жив

    const r = await run(['кот', out('after-orphan.png')], { mode: 'ok', home });
    assert.equal(r.code, 0, r.stderr);
    await assert.rejects(fetch(orphanVersion), 'браузер-сирота не закрыт');
    await assertCleanedUp(home);
  } finally {
    orphan.kill();
  }
});

test('таймаут — код 1, браузер остановлен', async () => {
  const r = await run(['кот', out('hang.png')], { mode: 'hang', env: { CHATGPT_IMAGE_TIMEOUT: '5' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /не появилась за 5 секунд/);
  takeDiagnostics(r.stderr);
  await assertCleanedUp(r.home);
});
