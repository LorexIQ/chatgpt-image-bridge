#!/usr/bin/env bash
# Тесты для bin/codex-image. Вместо codex подставляется заглушка в PATH —
# настоящий codex CLI не вызывается, лимиты не тратятся, вход не нужен.
#
# Запуск: bash tests/codex-image.test.sh

set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wrapper="$repo/plugins/codex-image-bridge/skills/generate-image/bin/codex-image"

T="$(mktemp -d "${TMPDIR:-/tmp}/codex-image-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/tmp" "$T/codex-home" "$T/out"

# --- заглушка codex ------------------------------------------------------------
# STUB_MODE: generated (по умолчанию) — кладёт PNG туда же, куда настоящий
#              image_generation: $CODEX_HOME/generated_images/<session>/exec-*.png
#            workdir — подделывает out.png только в рабочей папке (без инструмента)
#            none    — ничего не создаёт
#            sleep   — запускает нативный дочерний процесс и зависает
cat >"$T/bin/codex" <<'EOF'
#!/usr/bin/env bash
if [[ " $* " == *" mcp list --json "* ]]; then
  # Серверы из конфига; плагинный виден только при включённых плагинах.
  printf '[\r\n  {\r\n    "name": "alpha",\r\n    "enabled": true,\r\n    "transport": {\r\n      "env": {\r\n        "name": "nested"\r\n      }\r\n    }\r\n  },\r\n  {\r\n    "name": "beta-2",\r\n    "enabled": false\r\n  }'
  [[ " $* " == *" --disable plugins "* ]] || printf ',\r\n  {\r\n    "name": "plugin_srv",\r\n    "enabled": true\r\n  }'
  printf '\r\n]\r\n'
  exit 0
fi
if [[ " $* " == *" features list "* ]]; then
  # Часть реальных фич; `goals` в этой «версии» нарочно отсутствует.
  printf '%-40s %-18s %s\r\n' \
    apps stable true  code_mode_host stable true  image_generation stable true  plugins stable true \
    multi_agent stable true  shell_tool stable true  view_image stable true \
    enable_request_compression stable true  secret_auth_storage stable true
  exit 0
fi
: >"$STUB_ARGS"
for a in "$@"; do printf '%s\0' "$a" >>"$STUB_ARGS"; done
while [[ $# -gt 0 ]]; do case "$1" in -C) dir="$2"; shift 2 ;; *) shift ;; esac; done
session="01a0test-0000-0000-0000-$RANDOM$RANDOM"
echo "session id: $session"
case "${STUB_MODE:-generated}" in
  generated)
    mkdir -p "$CODEX_HOME/generated_images/$session"
    printf 'GENERATED' >"$CODEX_HOME/generated_images/$session/exec-1.png"
    printf 'MODEL-COPY' >"$dir/out.png" ;;
  workdir) printf 'FABRICATED' >"$dir/out.png" ;;
  none) ;;
  sleep)
    if command -v ping.exe >/dev/null 2>&1; then
      ping.exe -n 60 127.0.0.1 >/dev/null & child=$!
      cat "/proc/$child/winpid" >"$STUB_CHILD"
    else
      sleep 60 & child=$!
      echo "$child" >"$STUB_CHILD"
    fi
    wait ;;
esac
EOF
chmod +x "$T/bin/codex"

export PATH="$T/bin:$PATH" CODEX_HOME="$T/codex-home" TMPDIR="$T/tmp" HOME="$T/home"
export STUB_ARGS="$T/args" STUB_CHILD="$T/child"

if [[ "$(command -v codex)" != "$T/bin/codex" ]]; then
  echo "СТОП: заглушка codex не первая в PATH (найдено: $(command -v codex))" >&2
  exit 1
fi

# --- помощники -----------------------------------------------------------------
pass=0 fail=0
ok()  { pass=$((pass + 1)); echo "  ok   $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL $1"; [[ -n "${2:-}" ]] && echo "       $2"; }

run() { # запускает обёртку, сохраняет stdout/stderr/код выхода
  "$wrapper" "$@" >"$T/stdout" 2>"$T/stderr"
  code=$?
}

leftovers() { ls -A "$T/tmp"; }

native() { # путь в том виде, в каком его должна печатать обёртка
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi
}

reset() { rm -rf "$T/tmp"/* "$T/tmp"/.[!.]* "$T/codex-home"/* "$T/out"/* "$T/args" "$T/child" 2>/dev/null; }

codex_args() { # аргументы последнего вызова codex exec в виде <a><b><c>
  args=(); [[ -e "$STUB_ARGS" ]] && while IFS= read -r -d '' a; do args+=("$a"); done <"$STUB_ARGS"
  joined="$(printf '<%s>' ${args[@]+"${args[@]}"})"
}

# --- разбор --size ---------------------------------------------------------------
echo "--size: проверка аргумента"
reset; run "cat" "$T/out/a.png" --size
[[ $code -eq 2 && "$(cat "$T/stderr")" == *"для --size нужно значение"* ]] \
  && ok "--size без значения: код 2 и понятное сообщение" \
  || bad "--size без значения" "exit=$code stderr=$(cat "$T/stderr")"

reset; run "cat" "$T/out/a.png" --size big
[[ $code -eq 2 && "$(cat "$T/stderr")" == *"WxH"* && ! -e "$STUB_ARGS" ]] \
  && ok "--size в неверном формате: код 2 до вызова codex" \
  || bad "--size в неверном формате" "exit=$code stderr=$(cat "$T/stderr")"

# --- уборка временных файлов -----------------------------------------------------
echo "уборка временных файлов"
reset; STUB_MODE=generated run "cat" "$T/out/a.png"
[[ $code -eq 0 && -z "$(leftovers)" ]] \
  && ok "после успеха в TMPDIR ничего не остаётся" \
  || bad "уборка после успеха" "exit=$code leftovers=$(leftovers) stderr=$(cat "$T/stderr")"

reset; STUB_MODE=none run "cat" "$T/out/a.png"
left="$(leftovers)"
[[ $code -eq 1 && "$left" == *.log && "$(echo "$left" | wc -l)" -eq 1 ]] \
  && ok "после ошибки рабочая папка удалена, остаётся только лог из сообщения" \
  || bad "уборка после ошибки" "exit=$code leftovers=$left"

reset
STUB_MODE=sleep "$wrapper" "cat" "$T/out/a.png" >/dev/null 2>&1 &
wpid=$!
for _ in $(seq 50); do [[ -s "$STUB_CHILD" ]] && break; sleep 0.1; done
kill -TERM "$wpid"
for _ in $(seq 50); do kill -0 "$wpid" 2>/dev/null || break; sleep 0.1; done
wait "$wpid" 2>/dev/null; tcode=$?
sleep 0.5
child="$(cat "$STUB_CHILD" 2>/dev/null)"
if command -v tasklist >/dev/null 2>&1; then
  alive="$(tasklist //FI "PID eq $child" //NH 2>/dev/null | grep -ci ping)"
else
  alive="$(kill -0 "$child" 2>/dev/null && echo 1 || echo 0)"
fi
[[ -n "$child" && $tcode -ne 0 && -z "$(leftovers)" && "$alive" == 0 ]] \
  && ok "SIGTERM убивает дерево процессов codex и удаляет временные файлы" \
  || bad "уборка по SIGTERM" "exit=$tcode child=$child alive=$alive leftovers=$(leftovers)"
[[ "$alive" != 0 && -n "$child" ]] && { taskkill //F //PID "$child" >/dev/null 2>&1 || kill "$child" 2>/dev/null; }

# --- формат выводимого пути --------------------------------------------------------
echo "формат выводимого пути"
reset; STUB_MODE=generated run "cat" "$T/out/a.png"
[[ $code -eq 0 && "$(cat "$T/stdout")" == "$(native "$T/out/a.png")" ]] \
  && ok "путь к результату в нативном виде ($(cat "$T/stdout"))" \
  || bad "нативный путь" "exit=$code stdout=$(cat "$T/stdout") want=$(native "$T/out/a.png")"

# --- картинка только от image_generation -------------------------------------------
echo "источник картинки"
reset; STUB_MODE=workdir run "cat" "$T/out/a.png"
[[ $code -eq 1 && ! -e "$T/out/a.png" && "$(cat "$T/stderr")" == *"image_generation"* ]] \
  && ok "отклоняет PNG, созданный не через image_generation" \
  || bad "поддельный PNG принят" "exit=$code stderr=$(cat "$T/stderr")"

reset; STUB_MODE=generated run "cat" "$T/out/a.png"
[[ $code -eq 0 && "$(cat "$T/out/a.png" 2>/dev/null)" == "GENERATED" ]] \
  && ok "копирует картинку, сохранённую image_generation" \
  || bad "копирование картинки" "exit=$code content=$(cat "$T/out/a.png" 2>/dev/null)"

# --- исходные и референсные картинки -----------------------------------------------
echo "--image"
reset; printf 'REF' >"$T/out/ref one.png"
STUB_MODE=generated run "edit it" "$T/out/a.png" --image "$T/out/ref one.png"
codex_args
n=${#args[@]}
[[ $code -eq 0 && $n -ge 2 && "${args[$((n - 2))]}" == "-i" && "${args[$((n - 1))]}" == "$(native "$T/out/ref one.png")" \
   && "${args[$((n - 3))]}" == *"edit it"* && "${args[$((n - 3))]}" == *"referenced_image_paths"* \
   && "${args[$((n - 3))]}" == *"$(native "$T/out/ref one.png")"* ]] \
  && ok "передаёт --image в codex как -i <нативный путь> после промпта и в referenced_image_paths" \
  || bad "передача --image" "exit=$code args=${args[*]:-} stderr=$(cat "$T/stderr")"

reset; run "edit it" "$T/out/a.png" --image "$T/out/missing.png"
[[ $code -eq 2 && ! -e "$STUB_ARGS" && "$(cat "$T/stderr")" == *"картинка не найдена"*"missing.png"* ]] \
  && ok "несуществующий --image: код 2 до вызова codex" \
  || bad "несуществующий --image" "exit=$code stderr=$(cat "$T/stderr")"

# --- без MCP-серверов и плагинов ---------------------------------------------------
echo "codex запускается без MCP-серверов и плагинов"
reset; STUB_MODE=generated run "cat" "$T/out/a.png"
codex_args
[[ $code -eq 0 && "$joined" == *"<--disable><plugins>"* ]] \
  && ok "передаёт --disable plugins" \
  || bad "--disable plugins" "exit=$code args=$joined"
[[ "$joined" == *"<-c><mcp_servers.alpha.enabled=false>"* && "$joined" == *"<-c><mcp_servers.beta-2.enabled=false>"* ]] \
  && ok "отключает каждый MCP-сервер из конфига по имени" \
  || bad "отключение MCP-серверов" "args=$joined"
[[ "$joined" != *"nested"* && "$joined" != *"plugin_srv"* ]] \
  && ok "не трогает вложенные ключи \"name\" и серверы плагинов" \
  || bad "отключены лишние имена" "args=$joined"

# --- всё остальное, что не нужно для картинки --------------------------------------
echo "облегчённый запуск: лишние фичи, контекст и скиллы выключены"
reset
mkdir -p "$CODEX_HOME/skills/one" "$CODEX_HOME/skills/.system/two" "$HOME/.agents/skills/three" "$HOME/.agents/skills/bad"
printf -- '---\r\nname: skill-one\r\ndescription: x\r\n---\r\n' >"$CODEX_HOME/skills/one/SKILL.md"
printf -- '---\nname: "skill-two"\n---\n' >"$CODEX_HOME/skills/.system/two/SKILL.md"
printf -- '---\nname: skill_three\n---\n' >"$HOME/.agents/skills/three/SKILL.md"
printf -- '---\nname: bad"} evil\n---\n' >"$HOME/.agents/skills/bad/SKILL.md"
STUB_MODE=generated run "cat" "$T/out/a.png"
codex_args
[[ $code -eq 0 && "$joined" == *"<--disable><apps>"* && "$joined" == *"<--disable><multi_agent>"* \
   && "$joined" == *"<--disable><shell_tool>"* && "$joined" == *"<--disable><view_image>"* ]] \
  && ok "выключает ненужные фичи" \
  || bad "выключение фич" "exit=$code args=$joined stderr=$(cat "$T/stderr")"
[[ "$joined" != *"<--disable><goals>"* ]] \
  && ok "пропускает фичи, которых нет в этой версии codex (иначе codex падает)" \
  || bad "передана неизвестная фича" "args=$joined"
[[ "$joined" != *"<image_generation>"* && "$joined" != *"<code_mode_host>"* \
   && "$joined" != *"<enable_request_compression>"* && "$joined" != *"<secret_auth_storage>"* ]] \
  && ok "оставляет image_generation, code mode, сжатие и хранилище авторизации" \
  || bad "выключена нужная фича" "args=$joined"
[[ "$joined" == *'<-c><web_search="disabled">'* && "$joined" == *'<-c><notify=[]>'* \
   && "$joined" == *'<-c><project_doc_max_bytes=0>'* && "$joined" == *'<-c><memories.use_memories=false>'* \
   && "$joined" == *'<-c><skills.bundled.enabled=false>'* ]] \
  && ok "выключает web search, хук notify, AGENTS.md, память, встроенные скиллы" \
  || bad "оверрайды конфига" "args=$joined"
[[ "$joined" == *'<-c><skills.config=[{name="skill-one", enabled=false}, {name="skill-two", enabled=false}, {name="skill_three", enabled=false}]>'* ]] \
  && ok "отключает пользовательские и системные скиллы по имени, пропуская небезопасные имена" \
  || bad "skills.config" "args=$joined"

echo
echo "пройдено: $pass, упало: $fail"
[[ $fail -eq 0 ]]
