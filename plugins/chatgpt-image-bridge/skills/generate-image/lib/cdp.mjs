// Мини-клиент Chrome DevTools Protocol поверх WebSocket, встроенного в Node 22.
// Работает в «плоском» режиме: одно соединение с браузером, команды вкладке
// адресуются через sessionId из Target.attachToTarget.

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`не удалось подключиться к DevTools: ${wsUrl}`)), { once: true });
  });
  return new Connection(ws);
}

class Connection {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #closed = false;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    ws.addEventListener('close', () => {
      this.#closed = true;
      for (const { reject, method } of this.#pending.values()) {
        reject(new Error(`соединение с браузером закрыто во время ${method}`));
      }
      this.#pending.clear();
    });
  }

  get closed() {
    return this.#closed;
  }

  send(method, params = {}, sessionId) {
    if (this.#closed) {
      return Promise.reject(new Error(`соединение с браузером закрыто, ${method} не отправлен`));
    }
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(message));
    });
  }

  // Подписка на события. handler получает { method, params, sessionId }.
  on(handler) {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  session(sessionId) {
    return {
      send: (method, params) => this.send(method, params, sessionId),
      on: (handler) => this.on((event) => {
        if (event.sessionId === sessionId) handler(event);
      }),
    };
  }

  close() {
    if (!this.#closed) this.#ws.close();
  }

  #onMessage(data) {
    const message = JSON.parse(typeof data === 'string' ? data : data.toString());
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    for (const handler of this.#listeners) handler(message);
  }
}

// Открывает новую вкладку и возвращает сессию для неё.
export async function openPage(connection, url = 'about:blank') {
  const { targetId } = await connection.send('Target.createTarget', { url });
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  const page = connection.session(sessionId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  return { targetId, page };
}

// Выполняет выражение в странице и возвращает значение. Исключение внутри
// страницы превращается в ошибку здесь.
export async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    const text = exceptionDetails.exception?.description ?? exceptionDetails.text;
    throw new Error(`ошибка в странице: ${text}`);
  }
  return result.value;
}
