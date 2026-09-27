// Тесты для image-bridge — единой точки входа, которая выбирает режим и
// передаёт вызов codex-image или chatgpt-image. Настоящие codex и chatgpt.com
// не вызываются: режим codex работает с заглушкой codex в PATH, режим web —
// с локальным макетом chatgpt.com (tests/fixtures/fake-chatgpt.html) в Chrome
// без окна. Лимиты не тратятся, вход не нужен.
//
// Запуск: node --test tests/image-bridge.test.mjs

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'plugins', 'chatgpt-image-bridge', 'skills', 'generate-image', 'bin', 'image-bridge.mjs');
const fixture = fs.readFileSync(path.join(repo, 'tests', 'fixtures', 'fake-chatgpt.html'));
// Картинка 1×1, которую макет «сгенерировал».
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// Картинка из прошлого сообщения разговора (file_old) — другой пиксель.
const OLD_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const VALID_PROJECT = 'https://chatgpt.com/g/g-p-test/project';

let server;
let baseUrl;
let recorded = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-bridge-test-'));

// --- заглушка codex -----------------------------------------------------------
// Кладёт картинку туда же, куда настоящий image_generation, и записывает
// аргументы вызова codex exec. С STUB_SLEEP вместо этого зависает, записав
// свой pid в STUB_STARTED.
const stubDir = path.join(tmp, 'stub-bin');
fs.mkdirSync(stubDir);
fs.writeFileSync(path.join(stubDir, 'codex'), `#!/usr/bin/env bash
case " $* " in
  *" features list "*|*" mcp list "*) exit 0 ;;
esac
for a in "$@"; do printf '%s\\0' "$a"; done >"$STUB_ARGS"
session="bridge-test-$$"
echo "session id: $session"
if [[ -n "\${STUB_SLEEP:-}" ]]; then
  echo "$$" >"$STUB_STARTED"
  exec sleep "$STUB_SLEEP"
fi
mkdir -p "$CODEX_HOME/generated_images/$session"
printf 'GENERATED' >"$CODEX_HOME/generated_images/$session/exec-1.png"
`, { mode: 0o755 });

// PATH без настоящего codex: из него убраны все папки, где он есть, а
// заглушка стоит первой. Иначе ошибка в тесте могла бы потратить лимиты.
const CODEX_NAMES = ['codex', 'codex.exe', 'codex.cmd', 'codex.bat', 'codex.ps1'];
const safePath = [stubDir, ...(process.env.PATH ?? '').split(path.delimiter)
  .filter((dir) => dir && !CODEX_NAMES.some((name) => fs.existsSync(path.join(dir, name))))].join(path.delimiter);

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/record') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { recorded.push(JSON.parse(body)); res.end(); });
    } else if (req.url.startsWith('/backend-api/estuary/content')) {
      res.writeHead(200, { 'content-type': 'image/png' }).end(req.url.includes('id=file_old') ? OLD_PNG : PNG);
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

// Окружение без настроек пользователя, которые влияют на режим, codex или
// поиск bash. На Windows имя PATH бывает любым регистром — заменяем все.
function testEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CHATGPT_IMAGE_|CODEX_IMAGE_|CODEX_HOME$|CLAUDE_CODE_GIT_BASH_PATH$)/i.test(key)) continue;
    if (/^path$/i.test(key) && 'PATH' in extra) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

let homes = 0;
const newHome = () => path.join(tmp, `home-${homes++}`);

function run(args, { env = {}, home = newHome() } = {}) {
  recorded = [];
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: testEnv({ CHATGPT_IMAGE_HOME: home, ...env }), timeout: 90_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, lines: stdout.split(/\r?\n/).filter(Boolean), stderr, home });
    });
  });
}

function writeConfig(home, config) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}
const readConfig = (home) => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));

const out = (name) => path.join(tmp, name);
// codex-image вызывают из bash, пути ему привычнее с прямыми слешами.
const slashes = (p) => p.replaceAll('\\', '/');
// Путь в виде Git Bash (/c/Users/...), как его передаёт агент на Windows.
const gitBashPath = (p) => (process.platform === 'win32' ? slashes(p).replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : p);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const conversation = () => `${new URL(baseUrl).origin}/c/fake-conversation`;

// Окружение для режима codex с заглушкой: свои CODEX_HOME, TMPDIR и HOME.
let codexRuns = 0;
function codexEnv(extra = {}) {
  const dir = path.join(tmp, `codex-${codexRuns++}`);
  for (const sub of ['codex-home', 'tmp', 'home']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return {
    dir,
    args: path.join(dir, 'args'),
    tmpdir: path.join(dir, 'tmp'),
    env: {
      PATH: safePath,
      CODEX_HOME: slashes(path.join(dir, 'codex-home')),
      TMPDIR: slashes(path.join(dir, 'tmp')),
      HOME: slashes(path.join(dir, 'home')),
      STUB_ARGS: slashes(path.join(dir, 'args')),
      ...extra,
    },
  };
}
const stubArgs = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\0').slice(0, -1) : null);

// После выхода браузер должен быть остановлен, а замок профиля снят.
async function assertCleanedUp(home) {
  assert.equal(fs.existsSync(path.join(home, 'lock')), false, 'замок профиля не снят');
  const portFile = path.join(home, 'profile', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) return;
  const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
  await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`), 'браузер остался запущен');
}

// --- режим: выбор и переключение ---------------------------------------------

test('без аргументов — подсказка и код 2', async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /использование: image-bridge/);
});

test('по умолчанию режим web, config.json не создаётся', async () => {
  const r = await run(['mode']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'web (по умолчанию)\n');
  assert.equal(fs.existsSync(path.join(r.home, 'config.json')), false);
});

test('mode codex сохраняет режим в config.json и не трогает projectUrl', async () => {
  const home = newHome();
  writeConfig(home, { projectUrl: VALID_PROJECT });

  let r = await run(['mode', 'codex'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'codex (config.json)\n');
  assert.deepEqual(readConfig(home), { projectUrl: VALID_PROJECT, mode: 'codex' });

  r = await run(['mode'], { home });
  assert.equal(r.stdout, 'codex (config.json)\n');

  r = await run(['mode', 'web'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'web (config.json)\n');
  assert.deepEqual(readConfig(home), { projectUrl: VALID_PROJECT, mode: 'web' });
  // Профиля нет — подсказка про вход.
  assert.match(r.stderr, /профиль браузера ещё не настроен.*image-bridge\.mjs login/);
});

test('mode создаёт папку и config.json, если их нет', async () => {
  const home = path.join(newHome(), 'nested');
  const r = await run(['mode', 'codex'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readConfig(home), { mode: 'codex' });
});

test('CHATGPT_IMAGE_MODE важнее config.json', async () => {
  const home = newHome();
  writeConfig(home, { mode: 'codex' });
  let r = await run(['mode'], { home, env: { CHATGPT_IMAGE_MODE: 'web' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'web (CHATGPT_IMAGE_MODE)\n');

  // Переключение сохраняется, но предупреждает, что переменная сильнее.
  r = await run(['mode', 'codex'], { home, env: { CHATGPT_IMAGE_MODE: 'web' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /CHATGPT_IMAGE_MODE=web/);
});

test('неверный режим — код 2 с названием источника', async () => {
  const badConfig = newHome();
  writeConfig(badConfig, { mode: 'gpu', projectUrl: VALID_PROJECT });
  const cases = [
    [['mode'], { home: badConfig }, /"mode" в .*config\.json должен быть "codex" или "web", получено: "gpu"/],
    [['кот', out('a.png')], { home: badConfig }, /"mode" в .*config\.json/],
    [['кот', out('a.png')], { env: { CHATGPT_IMAGE_MODE: 'gpu' } }, /CHATGPT_IMAGE_MODE должен быть codex или web, получено: gpu/],
    [['mode'], { env: { CHATGPT_IMAGE_MODE: 'Codex' } }, /CHATGPT_IMAGE_MODE/],
    [['кот', out('a.png'), '--via', 'gpu'], {}, /--via должен быть codex или web, получено: gpu/],
    [['кот', out('a.png'), '--via'], {}, /для --via нужно значение/],
    [['login', '--via', 'gpu'], {}, /--via должен быть/],
    [['mode', 'xyz'], { home: badConfig }, /режим должен быть codex или web, получено: xyz/],
    [['mode', 'codex', 'web'], {}, /использование/],
    [['mode', '--via', 'codex'], {}, /--via не используется с mode/],
    [['login', 'web'], {}, /использование/],
  ];
  for (const [args, options, message] of cases) {
    const r = await run(args, options);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message);
    assert.equal(r.stdout, '');
  }
  // Неверный mode xyz не испортил файл.
  assert.deepEqual(readConfig(badConfig), { mode: 'gpu', projectUrl: VALID_PROJECT });
});

test('битый config.json — код 2, файл не перезаписывается', async () => {
  for (const content of ['{ "projectUrl": ', '["codex"]']) {
    const home = newHome();
    writeConfig(home, content);
    const r = await run(['mode', 'codex'], { home });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /config\.json/);
    assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), content);
  }
});

// --- режим codex -------------------------------------------------------------

test('codex: картинка от заглушки, путь в stdout, аргументы доходят без изменений', async () => {
  const home = newHome();
  writeConfig(home, { mode: 'codex' });
  const reference = out('reference.png');
  fs.writeFileSync(reference, PNG);
  const target = out('codex.png');
  const prompt = 'рыжий кот "в шляпе" на подоконнике';
  const stub = codexEnv();

  const r = await run([prompt, slashes(target), '--size', '1024x1024', '--image', slashes(reference)], { home, env: stub.env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.lines.length, 1, r.stdout);
  assert.ok(samePath(r.lines[0], target), r.stdout);
  assert.equal(fs.readFileSync(target, 'utf8'), 'GENERATED');

  const args = stubArgs(stub.args);
  assert.ok(args, 'codex exec не вызывался');
  const fullPrompt = args.at(-3);
  assert.equal(args.at(-2), '-i');
  assert.ok(samePath(args.at(-1), reference), args.at(-1));
  assert.match(fullPrompt, /PROMPT: рыжий кот "в шляпе" на подоконнике/);
  assert.match(fullPrompt, /SIZE: 1024x1024/);
  assert.deepEqual(fs.readdirSync(stub.tmpdir), [], 'временные файлы codex-image не убраны');
});

test('codex: --via codex важнее config.json, код ошибки codex-image возвращается как есть', async () => {
  const home = newHome();
  writeConfig(home, { mode: 'web' });
  const stub = codexEnv();
  const r = await run(['кот', slashes(out('a.png')), '--via', 'codex', '--size', 'big'], { home, env: stub.env });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^codex-image: --size должен быть в формате WxH/);
  assert.equal(stubArgs(stub.args), null, 'codex вызывался');

  const missing = await run(['кот', slashes(path.join(tmp, 'нет-папки', 'a.png')), '--via', 'codex'], { home, env: stub.env });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /codex-image: папка для результата не существует/);
});

test('codex: --chat — код 2, codex не вызывается', async () => {
  const home = newHome();
  writeConfig(home, { mode: 'codex' });
  const stub = codexEnv();
  for (const extra of [[], ['--via', 'codex']]) {
    const r = await run(['кот', slashes(out('a.png')), '--chat', 'https://chatgpt.com/c/abc', ...extra], { home, env: stub.env });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--chat работает только в режиме web/);
  }
  assert.equal(stubArgs(stub.args), null, 'codex вызывался');
});

test('--image принимает только картинки: другой файл — код 2 до передачи в любой режим', async () => {
  const key = out('id_ed25519');
  fs.writeFileSync(key, '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----\n');
  const reference = out('bridge-reference.png');
  fs.writeFileSync(reference, PNG);
  const home = newHome();
  writeConfig(home, { mode: 'codex' });
  const stub = codexEnv();
  const onlyImages = /^image-bridge: --image принимает только картинки PNG, JPEG, WebP или GIF: .*id_ed25519/;

  // codex: настоящая картинка первой — проверяется каждый --image. Заглушка
  // codex не вызывается.
  let r = await run(['кот', slashes(out('a.png')), '--image', gitBashPath(reference), '--image', gitBashPath(key)], { home, env: stub.env });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, onlyImages);
  assert.equal(stubArgs(stub.args), null, 'codex вызывался');

  // Несуществующий файл диспетчер тоже не передаёт.
  r = await run(['кот', slashes(out('a.png')), '--image', slashes(out('нет.png'))], { home, env: stub.env });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /^image-bridge: картинка не найдена: .*нет\.png/);
  assert.equal(stubArgs(stub.args), null, 'codex вызывался');

  // web: сообщение от диспетчера, а не от chatgpt-image; до макета ничего не дошло.
  r = await run(['кот', out('a.png'), '--image', key], { env: { CHATGPT_IMAGE_URL: `${baseUrl}?mode=ok`, CHATGPT_IMAGE_HEADLESS: '1' } });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, onlyImages);
  assert.equal(recorded.length, 0, 'промпт ушёл в макет ChatGPT');
  assert.equal(fs.existsSync(r.home), false, 'chatgpt-image запускался');

  // А картинка, в том числе GIF и путь в виде Git Bash, доходит до codex.
  const gif = out('bridge-reference.gif');
  fs.writeFileSync(gif, Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
  r = await run(['кот', slashes(out('bridge-gif.png')), '--image', gitBashPath(gif)], { home, env: stub.env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(samePath(stubArgs(stub.args).at(-1), gif), stubArgs(stub.args).at(-1));
});

test('codex: нет bash — код 127 с подсказкой', async () => {
  const empty = path.join(tmp, 'empty-path');
  fs.mkdirSync(empty, { recursive: true });
  const r = await run(['кот', slashes(out('a.png')), '--via', 'codex'], { env: { PATH: empty } });
  assert.equal(r.code, 127);
  assert.match(r.stderr, /для режима codex нужен bash/);
});

test('login в режиме codex подсказывает codex login и ничего не запускает', async () => {
  const r = await run(['login', '--via', 'codex'], { env: { PATH: safePath } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /codex login/);
});

test('codex: SIGTERM доходит до codex-image — он останавливает codex и убирает за собой', { skip: process.platform === 'win32' && 'на Windows сигналы не пересылаются: Ctrl+C скрипт получает сам' }, async () => {
  const home = newHome();
  writeConfig(home, { mode: 'codex' });
  const started = path.join(tmp, 'stub-started');
  const stub = codexEnv({ STUB_SLEEP: '30', STUB_STARTED: started });
  const child = spawn(process.execPath, [cli, 'кот', out('sigterm.png')], { env: testEnv({ CHATGPT_IMAGE_HOME: home, ...stub.env }), stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  // Заглушка пишет свой pid и превращается в sleep — ждём, пока pid записан.
  const readPid = () => (fs.existsSync(started) ? Number(fs.readFileSync(started, 'utf8').trim()) : 0);
  let codexPid = 0;
  try {
    for (let i = 0; i < 100 && !readPid(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    codexPid = readPid();
    assert.ok(codexPid > 0, 'заглушка codex не запустилась');
    // Сигнал получает только диспетчер — дальше его должен передать он.
    child.kill('SIGTERM');
    assert.equal(await exited, 143);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => process.kill(codexPid, 0), 'заглушка codex осталась запущена');
    assert.deepEqual(fs.readdirSync(stub.tmpdir), [], 'временные файлы codex-image не убраны');
  } finally {
    for (const pid of [child.pid, codexPid]) {
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        // уже завершён
      }
    }
  }
});

// --- режим web ---------------------------------------------------------------

test('web: по умолчанию картинка с макета, путь и chat: проходят через диспетчер', async () => {
  const target = out('web.png');
  const r = await run(['рыжий кот на подоконнике', target, '--size', '1536x1024'], { env: { CHATGPT_IMAGE_URL: `${baseUrl}?mode=ok`, CHATGPT_IMAGE_HEADLESS: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.lines.length, 2, r.stdout);
  assert.ok(samePath(r.lines[0], target), r.stdout);
  assert.equal(r.lines[1], `chat: ${conversation()}`);
  assert.deepEqual(fs.readFileSync(target), PNG);
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].prompt, /Aspect ratio 3:2/);
  await assertCleanedUp(r.home);
});

test('web: --via web важнее config.json, --chat доходит до chatgpt-image', async () => {
  const home = newHome();
  writeConfig(home, { mode: 'codex', projectUrl: VALID_PROJECT });
  const target = out('web-chat.png');
  const r = await run(['сделай кота чёрным', target, '--via', 'web', '--chat', conversation()], {
    home,
    env: { CHATGPT_IMAGE_URL: `${baseUrl}?mode=ok`, CHATGPT_IMAGE_HEADLESS: '1', PATH: safePath },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(samePath(r.lines[0], target), r.stdout);
  assert.equal(r.lines[1], `chat: ${conversation()}`);
  assert.deepEqual(fs.readFileSync(target), PNG, 'вернулась картинка из прошлого сообщения');
  assert.match(recorded[0].prompt, /Changes: сделай кота чёрным$/);
  await assertCleanedUp(home);
});

test('web: коды выхода chatgpt-image возвращаются как есть', async () => {
  let r = await run(['кот', out('a.png'), '--size', '12']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^chatgpt-image: --size должен быть в формате WxH/);

  // Без профиля — код 3. Несуществующий браузер — страховка: даже при ошибке
  // скрипт не откроет настоящий chatgpt.com.
  const noBrowser = { CHATGPT_IMAGE_BROWSER: path.join(tmp, 'нет-браузера.exe') };
  r = await run(['кот', out('a.png')], { env: noBrowser });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /профиль браузера ещё не настроен/);

  // login передаётся chatgpt-image: без браузера он выходит с кодом 127, не открывая окно.
  r = await run(['login'], { env: noBrowser });
  assert.equal(r.code, 127);
  assert.match(r.stderr, /CHATGPT_IMAGE_BROWSER/);
});

test('web: ключ mode в config.json не мешает chatgpt-image читать projectUrl', async () => {
  const noBrowser = { CHATGPT_IMAGE_BROWSER: path.join(tmp, 'нет-браузера.exe') };
  const home = newHome();
  writeConfig(home, { mode: 'web', projectUrl: VALID_PROJECT });
  // projectUrl принят, дальше — проверка профиля (код 3), а не ошибка config.json (код 2).
  let r = await run(['кот', out('a.png')], { home, env: noBrowser });
  assert.equal(r.code, 3, r.stderr);

  // А неверный projectUrl рядом с mode chatgpt-image по-прежнему замечает.
  const bad = newHome();
  writeConfig(bad, { mode: 'web', projectUrl: 'https://example.com/' });
  r = await run(['кот', out('a.png')], { home: bad, env: noBrowser });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /projectUrl/);
});
