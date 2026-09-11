# codex-image-bridge

Маркетплейс для [Claude Code](https://code.claude.com) с плагином, который даёт агенту генерацию и редактирование изображений. Картинки создаёт встроенный инструмент `image_generation` из [Codex CLI](https://github.com/openai/codex), авторизованного через подписку ChatGPT, — **API-ключ OpenAI не нужен, поштучной оплаты нет.**

Внутри — один скилл `generate-image` и bash-скрипт `codex-image`. Скрипт самодостаточен, так что его может вызывать и любой другой агент, умеющий запускать shell-команды.

Проект — переработанный форк [oakplank/gpt-image-bridge](https://github.com/oakplank/gpt-image-bridge), подробности в разделе [«Отличия от оригинала»](#отличия-от-оригинала).

## Как это работает

```
агент ──bash──▶ codex-image ──codex exec──▶ image_generation (Codex, ChatGPT)
                     │                                │
 Read PNG ◀── копия в нужный ◀── generated_images/ ◀──┘
              путь              <session id>/
```

1. Скрипт запускает `codex exec` во временной папке в облегчённом режиме — без плагинов, MCP-серверов, скиллов и прочей обвязки, которая не нужна для картинки.
2. Codex вызывает инструмент `image_generation` и сохраняет результат в `$CODEX_HOME/generated_images/<session id>/`.
3. Скрипт находит session id в логе codex, копирует оттуда картинку в запрошенный путь и печатает этот путь.
4. Агент открывает PNG и проверяет результат.

Codex не работает с итоговым путём, поэтому песочница его не блокирует, а путаница путей Windows/POSIX исключена.

## Требования

- [Codex CLI](https://github.com/openai/codex): `npm install -g @openai/codex` (на macOS также `brew install codex`).
- Вход в codex через подписку ChatGPT: `codex login`.
- bash: на macOS и Linux есть из коробки, на Windows — Git Bash (им же пользуется Claude Code) или WSL.

Проверка:

```bash
codex login status                           # Logged in using ChatGPT
codex features list | grep image_generation  # image_generation  stable  true
```

## Установка

### Claude Code через маркетплейс

В сессии Claude Code:

```
/plugin marketplace add LorexIQ/codex-image-bridge
/plugin install codex-image-bridge@codex-image-bridge
```

Или из терминала:

```bash
claude plugin marketplace add LorexIQ/codex-image-bridge
claude plugin install codex-image-bridge@codex-image-bridge
```

После перезапуска сессии Claude сам будет использовать скилл, когда вы попросите картинку. Вызвать его явно — `/codex-image-bridge:generate-image`.

### Claude Code без маркетплейса

Скопируйте папку скилла в личные скиллы:

```bash
git clone https://github.com/LorexIQ/codex-image-bridge.git
cp -R codex-image-bridge/plugins/codex-image-bridge/skills/generate-image ~/.claude/skills/
```

Путь к скрипту в SKILL.md задан через `${CLAUDE_SKILL_DIR}`, поэтому скилл работает из любого места установки. Не ставьте его одновременно двумя способами.

### Другие агенты

Скрипт `plugins/codex-image-bridge/skills/generate-image/bin/codex-image` не зависит ни от чего, кроме bash и codex. Сообщите агенту о нём в его файле инструкций (`AGENTS.md`, `GEMINI.md`, `.cursorrules` и т. п.):

```
Чтобы сгенерировать картинку, выполни: bash <путь>/codex-image "<подробный промпт>" <абсолютный-путь.png> [--size WxH] [--image <файл>]
Генерация занимает несколько минут — ставь большой таймаут. После вызова открой PNG и проверь результат.
```

Полная версия инструкций — в [SKILL.md](./plugins/codex-image-bridge/skills/generate-image/SKILL.md).

## Использование

Скрипт можно вызвать и напрямую:

```bash
bash plugins/codex-image-bridge/skills/generate-image/bin/codex-image \
  "фотореалистичная колибри перед красным каньоном в золотой час, малая глубина резкости, журнальное качество" \
  /tmp/hummingbird.png
```

Параметры:

- `--size WxH` — желаемый размер, например `--size 1536x1024`. Без него размер выбирает модель.
- `--image <файл>` — исходная картинка для редактирования или референс. Можно указать несколько раз. Картинка прикладывается к запросу и передаётся инструменту как `referenced_image_paths`.

Коды выхода:

| Код | Что значит | Вывод |
| --- | --- | --- |
| 0 | Картинка готова | stdout: абсолютный путь (на Windows в виде `C:/...`) |
| 1 | Codex завершился с ошибкой или инструмент не сохранил картинку | stderr: последние 30 строк лога и путь к полному логу |
| 2 | Ошибка аргументов | stderr: сообщение об ошибке |
| 127 | codex не найден в PATH | stderr: как установить |

Временные файлы удаляются при любом завершении, в том числе по Ctrl+C и таймауту: скрипт останавливает codex вместе с дочерними процессами. После ошибки остаётся только лог, на который указывает сообщение.

## Облегчённый запуск codex

Для генерации картинки агентная обвязка codex не нужна, а каждая её часть стоит времени на старте или токенов на каждом вызове. Скрипт выключает:

- **фичи:** плагины, apps, browser и computer use, мультиагентность, shell и `unified_exec`, `view_image`, sleep, hooks, goals, guardian, personality, бесконечные переподключения и другие;
- **конфиг:** web search, команду `notify`, `AGENTS.md`, память, аналитику, feedback, историю, проверку обновлений, встроенные скиллы;
- **по имени:** каждый MCP-сервер из конфига codex (по `codex mcp list --json`) и каждый скилл из `~/.codex/skills` и `~/.agents/skills`.

Остаются включёнными `image_generation`, `code_mode_host` (инструмент картинок доступен только через code mode), сжатие запросов и хранилище авторизации. Модель, reasoning effort и настройки песочницы берутся из вашего конфига codex.

`--disable` получает только фичи, которые есть в `codex features list` установленной версии: неизвестное имя codex считает ошибкой.

Замер на codex-cli 0.154 (запрос перехватывался локальным сервером, до OpenAI не доходил):

| | Обычный запуск | Облегчённый |
| --- | --- | --- |
| Размер запроса к модели | 86 КБ | 47 КБ |
| Время до первого запроса | 2,1–3,9 с | 1,0–1,9 с |
| Процессы MCP и плагинов | запускаются | нет |

## Ограничения

- **Время.** Генерация обычно занимает несколько минут; при вызове из агента ставьте таймаут побольше или запускайте в фоне.
- **Лимиты.** Вызовы расходуют лимиты Codex в вашем плане ChatGPT — те же, что и обычная работа в Codex.
- **Зависимость от устройства codex.** Скрипт полагается на `session id` в логе и папку `generated_images`. Если новая версия codex это изменит, вызов завершится ошибкой с логом, а не вернёт непроверенную картинку.
- **Условия использования.** `codex exec` — штатный неинтерактивный режим, но автоматизация подписки регулируется условиями OpenAI.

## Тесты

```bash
bash tests/codex-image.test.sh
```

Тесты подменяют codex заглушкой: лимиты не тратятся, вход не нужен.

## Отличия от оригинала

По сравнению с [oakplank/gpt-image-bridge](https://github.com/oakplank/gpt-image-bridge):

- упаковано в маркетплейс Claude Code, путь к скрипту — через `${CLAUDE_SKILL_DIR}`;
- картинка берётся только из `generated_images` — PNG, нарисованный моделью в обход инструмента, не принимается;
- добавлен `--image` для редактирования и референсов;
- облегчённый запуск codex без MCP, плагинов, скиллов и лишних инструментов;
- уборка временных файлов и остановка дерева процессов codex при ошибке, Ctrl+C и таймауте;
- проверка `--size`, пути в формате Windows на выходе;
- тесты на заглушке codex;
- документация и сообщения на русском.

## Лицензия

MIT — см. [LICENSE](./LICENSE). Исходный проект — © 2026 Jacob ([oakplank](https://github.com/oakplank)).
