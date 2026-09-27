---
description: Показать или переключить режим генерации картинок
argument-hint: "[codex|web]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/generate-image/bin/image-bridge.mjs mode*), Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/generate-image/bin/image-bridge.mjs" mode*)
---

<!--
Использование: /chatgpt-image-bridge:image-mode — показать режим,
               /chatgpt-image-bridge:image-mode codex|web — переключить.
Режим хранится в ~/.chatgpt-image/config.json (ключ "mode").
-->

Выполни через Bash одну команду:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/generate-image/bin/image-bridge.mjs" mode $ARGUMENTS
```

Без аргумента она печатает текущий режим и откуда он взят, с аргументом `codex` или `web` — переключает режим и печатает новый.

Сообщи результат пользователю одной строкой, например «Режим генерации картинок: codex (config.json)». Больше ничего не запускай — ни вход, ни генерацию.

- Код 2 — неверный режим или битый `config.json`: перескажи сообщение и напомни, что допустимы `codex` и `web`.
- Если в stderr есть предупреждение, добавь его коротко. Например, при переключении на web без настроенного профиля браузера — что перед первой генерацией нужно один раз войти в ChatGPT командой `node "${CLAUDE_PLUGIN_ROOT}/skills/generate-image/bin/image-bridge.mjs" login`.
