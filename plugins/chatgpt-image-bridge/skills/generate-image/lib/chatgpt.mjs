// Всё, что зависит от устройства chatgpt.com: адреса, селекторы и шаги.
// Интерфейс ChatGPT меняется — править при этом нужно только этот файл.
// Селекторы опираются на id, data-testid и data-атрибуты, а не на aria-label:
// подписи локализованы и в русском интерфейсе другие.

import { evaluate, openPage } from './cdp.mjs';

export const CHAT_URL = 'https://chatgpt.com/';

// Адрес разговора: /c/<id>, а в проекте или GPT — /g/<id>/c/<id>.
const CONVERSATION_PATH = /^\/(?:g\/[^/]+\/)?c\/[\w-]+\/?$/;

// Адрес разговора без query и hash или '', если href — не разговор.
export function conversationUrl(href) {
  if (!URL.canParse(href)) return '';
  const url = new URL(href);
  return CONVERSATION_PATH.test(url.pathname) ? url.origin + url.pathname.replace(/\/$/, '') : '';
}

export class ChatGptError extends Error {
  constructor(message, { needsUser = false } = {}) {
    super(message);
    this.needsUser = needsUser;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Состояние страницы одним вызовом: что на ней сейчас видно.
const PAGE_STATE = `(() => {
  const title = document.title || '';
  const challenge = /just a moment|momento|подождите/i.test(title)
    || !!document.querySelector('#challenge-form, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"]');
  const composer = !!document.querySelector('#prompt-textarea');
  const loginButton = !!document.querySelector('[data-testid="login-button"]');
  const authPage = /(^|\\.)auth\\.openai\\.com$|(^|\\.)auth0\\.openai\\.com$/.test(location.hostname);
  return { url: location.href, title, challenge, composer, loginButton, authPage };
})()`;

async function pageState(page) {
  return evaluate(page, PAGE_STATE);
}

// Расширение прокси (у пользователя — ZeroOmega) подставляет логин прокси из
// своего service worker, а тот при старте браузера просыпается не сразу.
// Запрос, ушедший раньше, получает системное окно логина прокси, и в скрытом
// окне загрузка молча виснет. Поэтому до chatgpt.com стоим на about:blank,
// пока не запустятся service worker'ы расширений, плюс небольшой запас.
const EXTENSIONS_WAIT_MS = 5_000;
const EXTENSIONS_GRACE_MS = 1_500;
// Если переход всё же повис на логине прокси, повторяем его — как F5 руками:
// новый переход отменяет висящий запрос вместе с окном логина.
const COMMIT_TIMEOUT_MS = 8_000;
const NAVIGATE_ATTEMPTS = 3;

async function waitForExtensionWorkers(connection) {
  const deadline = Date.now() + EXTENSIONS_WAIT_MS;
  while (Date.now() < deadline) {
    const { targetInfos } = await connection.send('Target.getTargets');
    if (targetInfos.some((info) => info.type === 'service_worker' && info.url.startsWith('chrome-extension://'))) break;
    await sleep(200);
  }
  await sleep(EXTENSIONS_GRACE_MS);
}

// Page.navigate отвечает, когда переход зафиксирован; пока запрос ждёт логина
// прокси, ответа нет.
async function navigate(page, url) {
  for (let attempt = 1; attempt <= NAVIGATE_ATTEMPTS; attempt++) {
    const navigation = page.send('Page.navigate', { url });
    navigation.catch(() => {}); // отменённый переход завершится ошибкой позже
    const result = await Promise.race([navigation, sleep(COMMIT_TIMEOUT_MS).then(() => null)]);
    if (result && !result.errorText) return;
    if (result?.errorText && attempt === NAVIGATE_ATTEMPTS) {
      throw new ChatGptError(`не удалось открыть ${url}: ${result.errorText}`);
    }
  }
  throw new ChatGptError(`переход на ${url} не завершился — возможно, прокси требует логин, а расширение прокси не ответило.`);
}

export async function openChat(connection, url) {
  const { page } = await openPage(connection);
  await waitForExtensionWorkers(connection);
  await navigate(page, url);
  const deadline = Date.now() + 60_000;
  let state;
  while (Date.now() < deadline) {
    try {
      state = await pageState(page);
    } catch {
      state = null; // страница ещё грузится или перенаправляет
    }
    if (state) {
      if (state.authPage || state.loginButton) {
        throw new ChatGptError('в профиле браузера нет входа в ChatGPT. Выполните chatgpt-image login и войдите.', { needsUser: true });
      }
      if (state.composer) return { page };
    }
    await sleep(500);
  }
  if (state?.challenge) {
    throw new ChatGptError('chatgpt.com показывает проверку браузера. Выполните chatgpt-image login и пройдите её в открывшемся окне.', { needsUser: true });
  }
  throw new ChatGptError(`поле ввода ChatGPT не появилось за 60 секунд (страница: ${state?.url ?? 'не загрузилась'}).`);
}

// Окно входа открывается без DevTools, поэтому ждать расширение прокси через
// протокол нельзя: вместо этого окно стартует с локальной страницы, которая
// переходит на chatgpt.com с той же задержкой.
export function loginStartPage() {
  const delay = EXTENSIONS_GRACE_MS + 500;
  return `<!doctype html>
<meta charset="utf-8">
<title>chatgpt-image</title>
<style>body{font:16px system-ui,sans-serif;background:#212121;color:#ececec;display:grid;place-items:center;height:100vh;margin:0}</style>
<p>Жду, пока запустится расширение прокси, и открываю ChatGPT…</p>
<script>setTimeout(() => location.replace(${JSON.stringify(CHAT_URL)}), ${delay})</script>
`;
}

// Промпт для ChatGPT намеренно на английском: это инструкция модели, а не
// текст для пользователя. Одной строкой — Enter в поле ввода отправил бы его.
// followUp — продолжение разговора: промпт описывает только правки к прошлой
// картинке, и ChatGPT должен нарисовать её новую версию, а не ответить текстом.
export function buildPrompt(prompt, { size = '', imageCount = 0, followUp = false } = {}) {
  const parts = [followUp
    ? 'Create a new version of the previous image with your image generation tool, applying the changes below and keeping everything else the same. Do not ask clarifying questions.'
    : 'Create an image with your image generation tool. Do not ask clarifying questions.'];
  if (size) {
    const [w, h] = size.split('x').map(Number);
    const d = gcd(w, h);
    parts.push(`Aspect ratio ${w / d}:${h / d} (about ${w}x${h} px).`);
  }
  if (imageCount) parts.push(`Use the attached image${imageCount > 1 ? 's' : ''} as the prompt describes.`);
  parts.push(`${followUp ? 'Changes' : 'Prompt'}: ${prompt.replace(/\s+/g, ' ').trim()}`);
  return parts.join(' ');
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

const SEND_BUTTON = '[data-testid="send-button"], #composer-submit-button';
const STOP_BUTTON = '[data-testid="stop-button"]';
const ASSISTANT_TURN = 'section[data-turn="assistant"], [data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])';
// Готовая картинка: файл из estuary, уже загруженный. Во время генерации их
// в ответе нет — только текст прогресса. Один файл показан несколькими слоями
// (основной, плавное появление, размытый фон), поэтому src уникализируем.
const RESULT_STATE = `(() => {
  const turns = document.querySelectorAll(${JSON.stringify(ASSISTANT_TURN)});
  const last = turns[turns.length - 1];
  const images = last ? [...new Set([...last.querySelectorAll('img')]
    .filter((img) => /\\/backend-api\\/estuary\\/content\\?/.test(img.src) && img.complete && img.naturalWidth > 0)
    .map((img) => img.src))] : [];
  return {
    turns: turns.length,
    stop: !!document.querySelector(${JSON.stringify(STOP_BUTTON)}),
    images,
    text: last ? last.innerText.trim() : '',
  };
})()`;

// Сколько ответ без картинки должен не меняться после остановки генерации,
// чтобы считать его окончательным (отказ, уточняющий вопрос, лимит).
const TEXT_SETTLE_MS = 8_000;
const POLL_MS = 1_000;

// followUp — страница открыта на существующем разговоре, и промпт уходит в
// него продолжением. Возвращает { data, extension, chatUrl }, где chatUrl —
// адрес разговора с картинкой ('' — если адрес не похож на разговор).
export async function generateImage(page, { prompt, size, images, timeoutMs, followUp = false }) {
  const deadline = Date.now() + timeoutMs;
  const before = followUp ? await waitForHistory(page, deadline) : (await evaluate(page, RESULT_STATE)).turns;

  if (images.length) await attachImages(page, images, deadline);
  await typePrompt(page, buildPrompt(prompt, { size, imageCount: images.length, followUp }));
  await clickWhenEnabled(page, SEND_BUTTON, deadline, 'кнопка отправки не стала активной');

  let settledText = '';
  let settledSince = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    // После отправки адрес меняется на /c/<id>; если при этом страница
    // перезагрузится, один опрос может не выполниться — это не ошибка.
    const state = await evaluate(page, RESULT_STATE).catch(() => null);
    if (!state || state.turns <= before) continue;
    if (state.images.length && !state.stop) {
      const image = await downloadImage(page, state.images[0]);
      // Без адреса разговора картинка всё равно готова — это не ошибка.
      const href = await evaluate(page, 'location.href').catch(() => '');
      return { ...image, chatUrl: conversationUrl(href) };
    }
    if (!state.stop && !state.images.length && state.text) {
      if (state.text !== settledText) {
        settledText = state.text;
        settledSince = Date.now();
      } else if (Date.now() - settledSince >= TEXT_SETTLE_MS) {
        throw new ChatGptError(`ChatGPT ответил без картинки: ${state.text}`);
      }
    } else {
      settledText = '';
    }
  }
  throw new ChatGptError(`картинка не появилась за ${Math.round(timeoutMs / 1000)} секунд.`);
}

// В открытом разговоре поле ввода появляется раньше, чем старые сообщения.
// Если посчитать ответы сразу, прошлая картинка сойдёт за новую. Поэтому ждём,
// пока отрисуется хотя бы один ответ и их число перестанет меняться.
const HISTORY_SETTLE_MS = 1_500;
const HISTORY_TIMEOUT_MS = 60_000;

async function waitForHistory(page, deadline) {
  const start = Date.now();
  const limit = Math.min(deadline, start + HISTORY_TIMEOUT_MS);
  let turns = -1;
  let since = start;
  while (Date.now() < limit) {
    const current = (await evaluate(page, RESULT_STATE).catch(() => null))?.turns ?? -1;
    if (current !== turns) {
      turns = current;
      since = Date.now();
    } else if (turns > 0 && Date.now() - since >= HISTORY_SETTLE_MS) {
      return turns;
    }
    await sleep(250);
  }
  throw new ChatGptError(`старые сообщения разговора не загрузились за ${Math.round((limit - start) / 1000)} секунд — проверьте адрес в --chat.`);
}

async function typePrompt(page, text) {
  await evaluate(page, `document.querySelector('#prompt-textarea').focus()`);
  await page.send('Input.insertText', { text });
  const typed = await evaluate(page, `document.querySelector('#prompt-textarea').innerText.trim().length`);
  if (!typed) throw new ChatGptError('не удалось ввести промпт в поле ChatGPT.');
}

async function clickWhenEnabled(page, selector, deadline, failure) {
  while (Date.now() < deadline) {
    const clicked = await evaluate(page, `(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      button.click();
      return true;
    })()`);
    if (clicked) return;
    await sleep(300);
  }
  throw new ChatGptError(failure);
}

// Референсы уходят в скрытый input для картинок, как при выборе файла
// вручную; ждём, пока ChatGPT их загрузит и покажет миниатюры.
async function attachImages(page, files, deadline) {
  const { result } = await page.send('Runtime.evaluate', {
    expression: `document.querySelector('#upload-photos') || document.querySelector('input[type=file][accept*="image"]')`,
  });
  if (!result.objectId) throw new ChatGptError('не найдено поле загрузки картинок в ChatGPT.');
  await page.send('DOM.setFileInputFiles', { files, objectId: result.objectId });

  while (Date.now() < deadline) {
    const ready = await evaluate(page, `(() => {
      const form = document.querySelector('#prompt-textarea')?.closest('form');
      const thumbs = form ? form.querySelectorAll('img').length : 0;
      const send = document.querySelector(${JSON.stringify(SEND_BUTTON)});
      const busy = !send || send.disabled || send.getAttribute('aria-disabled') === 'true'
        || !!form?.querySelector('[role=progressbar], .animate-spin, circle[stroke-dasharray]');
      return thumbs >= ${files.length} && !busy;
    })()`);
    if (ready) return;
    await sleep(500);
  }
  throw new ChatGptError('референсные картинки не загрузились в ChatGPT.');
}

// Скачиваем изнутри страницы: запрос к тому же домену, куки подставятся сами.
async function downloadImage(page, src) {
  const payload = await evaluate(page, `(async () => {
    const response = await fetch(${JSON.stringify(src)}, { credentials: 'include' });
    if (!response.ok) return { error: 'HTTP ' + response.status };
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { data: btoa(binary) };
  })()`);
  if (payload.error) throw new ChatGptError(`не удалось скачать картинку: ${payload.error}`);
  const data = Buffer.from(payload.data, 'base64');
  const extension = imageExtension(data);
  if (!extension) throw new ChatGptError('скачанный файл не похож на картинку (не PNG, JPEG или WebP).');
  return { data, extension };
}

export function imageExtension(data) {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return '';
}

export function pageHtml(page) {
  return evaluate(page, 'document.documentElement.outerHTML');
}
