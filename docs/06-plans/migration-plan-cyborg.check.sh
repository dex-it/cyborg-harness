#!/usr/bin/env bash
# Сверка плана переезда Cyborg (migration-plan-cyborg.md) с кодом ai-cyborg и с документами этого репозитория.
#
# Запуск из корня cyborg-harness:
#   docs/06-plans/migration-plan-cyborg.check.sh <путь к клону ai-cyborg>
# Клон читается, ничего в нём не меняется. Нужны bash, grep, sed, sort, comm; git - только чтобы назвать коммит.
#
# Что проверяется:
#   1. Каналы IPC: список `ipcMain.handle`/`ipcMain.on` в src/main/main.ts совпадает по именам и видам с таблицей 4.2 плана;
#      набор каналов preload.ts (`ipcRenderer.invoke`/`send`) совпадает с набором main.ts.
#   2. События окну: имена `webContents.send(...)` в main.ts и `emit('session:...')` в sessions.ts совпадают с таблицей 4.3.
#   3. Члены `window.cyborg`: ключи объекта `api` в preload.ts.
#   4. Числа раздела 8 плана (диалоги, ключи localStorage, требования) - те, что снимаются командой.
#   5. Ссылки плана на этот репозиторий: каждый FR-CH/NFR-CH есть заголовком в docs/03-requirements/*/srs.md, каждый ADR-CH
#      есть файлом в docs/04-architecture/adr/, документов sad2.md и ADR-CH-0006 в плане нет (вне блока старых ссылок).
# Выход 0 - всё сошлось, 1 - есть расхождение (названо построчно), 2 - неверный вызов.

set -u
export LC_ALL=C

CYBORG="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS="$(cd "$HERE/../.." && pwd)"
PLAN="$HERE/migration-plan-cyborg.md"

if [ -z "$CYBORG" ] || [ ! -f "$CYBORG/src/main/main.ts" ] || [ ! -f "$CYBORG/src/main/preload.ts" ]; then
  echo "Использование: $0 <путь к клону ai-cyborg (нужны src/main/main.ts и src/main/preload.ts)>" >&2
  exit 2
fi
[ -f "$PLAN" ] || { echo "Нет файла плана: $PLAN" >&2; exit 2; }

# Числа, на которые опирается план (раздел 8 и 4); менять только вместе с планом.
EXPECT_HANDLE=52
EXPECT_ON=9
EXPECT_EVENTS=16
EXPECT_MEMBERS=64
EXPECT_DIALOGS=6
EXPECT_PREFS=10
EXPECT_NATIVE_DIALOGS=21
EXPECT_TESTS=964

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAIL=0
MAIN="$CYBORG/src/main/main.ts"
PRELOAD="$CYBORG/src/main/preload.ts"
SESSIONS="$CYBORG/src/main/sessions.ts"

bad() { echo "РАСХОЖДЕНИЕ: $*"; FAIL=1; }
ok() { echo "ok: $*"; }
same() { # same <что> <ожидалось> <получено>
  if [ "$2" = "$3" ]; then ok "$1 = $3"; else bad "$1: в плане $2, в коде $3"; fi
}

if command -v git >/dev/null 2>&1 && git -C "$CYBORG" rev-parse --short HEAD >/dev/null 2>&1; then
  echo "ai-cyborg: $(git -C "$CYBORG" rev-parse --short HEAD) ($(git -C "$CYBORG" log -1 --format=%cd --date=short))"
fi

# 1. Каналы.
grep -oE "ipcMain\.(handle|on)\('[^']+'" "$MAIN" | sed -E "s/ipcMain\.(handle|on)\('([^']+)'/\2 \1/" | sort -u > "$TMP/main-channels"
HANDLE="$(grep -c ' handle$' "$TMP/main-channels")"
ON="$(grep -c ' on$' "$TMP/main-channels")"
same "ipcMain.handle в main.ts" "$EXPECT_HANDLE" "$HANDLE"
same "ipcMain.on в main.ts" "$EXPECT_ON" "$ON"
same "ipcMain в других файлах src (число файлов)" 1 "$(grep -rl 'ipcMain' "$CYBORG/src" | wc -l | tr -d ' ')"

# Таблица 4.2 плана: строка вида | `канал` | handle | ... |
sed -n '/^### 4\.2\./,/^### 4\.3\./p' "$PLAN" \
  | grep -E '^\| `[a-z]+:[A-Za-z]+` \| (handle|on) \|' \
  | sed -E 's/^\| `([^`]+)` \| (handle|on) \|.*/\1 \2/' | sort -u > "$TMP/plan-channels"
if diff -u "$TMP/plan-channels" "$TMP/main-channels" > "$TMP/channels.diff"; then
  ok "таблица 4.2 плана и main.ts: $(wc -l < "$TMP/main-channels" | tr -d ' ') каналов совпали по именам и видам"
else
  bad "таблица 4.2 плана и main.ts (минус - только в плане, плюс - только в коде):"
  sed '1,2d' "$TMP/channels.diff" | grep -E '^[+-]' | sed 's/^/    /'
fi

{ grep -oE "ipcRenderer\.(invoke|send)\('[^']+'" "$PRELOAD" | sed -E "s/.*\('([^']+)'/\1/"; } | sort -u > "$TMP/preload-channels"
cut -d' ' -f1 "$TMP/main-channels" | sort -u > "$TMP/main-names"
if diff -u "$TMP/main-names" "$TMP/preload-channels" > "$TMP/preload.diff"; then
  ok "preload.ts и main.ts: один набор из $(wc -l < "$TMP/main-names" | tr -d ' ') каналов"
else
  bad "preload.ts и main.ts (минус - только в main, плюс - только в preload):"
  sed '1,2d' "$TMP/preload.diff" | grep -E '^[+-]' | sed 's/^/    /'
fi

# 2. События окну.
{
  grep -oE "webContents\.send\('[^']+'" "$MAIN" | sed -E "s/.*\('([^']+)'/\1/"
  grep -oE "emit\('session:[a-z]+'" "$SESSIONS" | sed -E "s/.*\('([^']+)'/\1/"
} | sort -u > "$TMP/main-events"
sed -n '/^### 4\.3\./,/^### 4\.4\./p' "$PLAN" \
  | grep -E '^\| `[a-z]+:[a-z-]+`' | sed -E 's/^\| `([^`]+)`.*/\1/' | sort -u > "$TMP/plan-events"
if diff -u "$TMP/plan-events" "$TMP/main-events" > "$TMP/events.diff"; then
  ok "таблица 4.3 плана и код: $(wc -l < "$TMP/main-events" | tr -d ' ') событий совпали"
else
  bad "события (минус - только в плане, плюс - только в коде):"
  sed '1,2d' "$TMP/events.diff" | grep -E '^[+-]' | sed 's/^/    /'
fi
same "событий окну" "$EXPECT_EVENTS" "$(wc -l < "$TMP/main-events" | tr -d ' ')"

# 3. Члены window.cyborg: ключи объекта api в preload.ts (платформа, функции каналов, pathForFile, on).
MEMBERS="$(awk '/^const api = \{/{f=1;next} /^\};/{f=0} f' "$PRELOAD" | grep -cE '^  [A-Za-z]+:')"
same "членов window.cyborg" "$EXPECT_MEMBERS" "$MEMBERS"
PRELOAD_CH="$(wc -l < "$TMP/preload-channels" | tr -d ' ')"
same "членов, привязанных к каналам (все члены минус platform, pathForFile, on)" "$((EXPECT_MEMBERS - 3))" "$PRELOAD_CH"

# 4. Числа раздела 8.
same "диалогов <dialog> в index.html" "$EXPECT_DIALOGS" "$(grep -c '<dialog' "$CYBORG/src/renderer/index.html")"
grep -ohE "'cyborg\.[A-Za-z.]+'" "$CYBORG"/src/renderer/*.ts | sort -u > "$TMP/prefs"
same "постоянных ключей localStorage cyborg.*" "$EXPECT_PREFS" "$(wc -l < "$TMP/prefs" | tr -d ' ')"
for family in 'cyborg\.extensions\.\$\{key\}' 'cyborg\.search\.\$\{key\}' 'cyborg\.tasks\.labels:\$\{id\}'; do
  if grep -qE "$family" "$CYBORG"/src/renderer/*.ts; then ok "семейство ключей $family есть в renderer"; else bad "семейство ключей $family не найдено в renderer"; fi
done
same "мест вызова alert/confirm в src/renderer" "$EXPECT_NATIVE_DIALOGS" "$(cat "$CYBORG"/src/renderer/*.ts | grep -cE '(^|[^A-Za-z.])(alert|confirm)\(')"
same "статических it(/test( в test/ и src/main/*.test.ts" "$EXPECT_TESTS" "$(cat "$CYBORG"/test/*.ts "$CYBORG"/src/main/*.test.ts | grep -cE '^\s*(it|test)\(')"
REQ="$(cat "$CYBORG"/docs/01-product/*/srs.md 2>/dev/null | grep -cE '^### N?FR-[0-9]+')"
echo "справочно: требований в docs/01-product/*/srs.md ai-cyborg: $REQ (в плане - раздел 8)"

# 5. Ссылки плана на этот репозиторий. Блок старых ссылок (приложение) в проверку не входит.
sed '/<!-- old-refs:begin -->/,/<!-- old-refs:end -->/d' "$PLAN" > "$TMP/plan-live.md"
BADREF=0
for id in $(grep -oE 'N?FR-CH-[0-9]+' "$TMP/plan-live.md" | sort -u); do
  if ! grep -qE "^### $id( |$)" "$HARNESS"/docs/03-requirements/*/srs.md; then bad "ссылка $id: заголовка нет в docs/03-requirements/*/srs.md"; BADREF=1; fi
done
for id in $(grep -oE 'ADR-CH-[0-9]+' "$TMP/plan-live.md" | sort -u); do
  if ! ls "$HARNESS"/docs/04-architecture/adr/"$id"-*.md >/dev/null 2>&1; then bad "ссылка $id: файла нет в docs/04-architecture/adr/"; BADREF=1; fi
done
for gone in 'sad2\.md' 'ADR-CH-0006' 'ADR-CH-0010' '03-migration/srs' 'src/plugins/'; do
  if grep -nE "$gone" "$TMP/plan-live.md" >/dev/null; then bad "в плане осталась ссылка на отсутствующее: $gone"; grep -nE "$gone" "$TMP/plan-live.md" | cut -c1-140 | sed 's/^/    /'; BADREF=1; fi
done
[ "$BADREF" = 0 ] && ok "ссылки плана: FR-CH, NFR-CH и ADR-CH существуют, отсутствующих документов нет"

if [ "$FAIL" = 0 ]; then echo "ИТОГ: сверка сошлась"; else echo "ИТОГ: есть расхождения"; fi
exit "$FAIL"
