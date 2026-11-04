#!/usr/bin/env bash
# NekoWiki 排程執行腳本（適用於 cron）。
#
# 用法：scripts/run.sh [步驟…]
#   步驟：sync（同步資料庫）、draft（產生草稿）、publish（發佈草稿）
#   不指定時為「sync draft」：只產生草稿，不發佈，留待人工審核。
#   加上 publish 即完全自動，草稿不經審核直接發佈。
#
# 環境變數：
#   NODE_BIN  指定 node 路徑（cron 的 PATH 很精簡，預設會自動尋找）
#
# cron 範例（每小時第 10 分鐘，只產生草稿）：
#   10 * * * * /path/to/NekoWiki/scripts/run.sh
# 完全自動：
#   10 * * * * /path/to/NekoWiki/scripts/run.sh sync draft publish
#
# 輸出追加到 state/cron.log；任一步驟失敗，結束碼為 1。

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/state/cron.log"
LOG_MAX_BYTES=1048576

usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

steps=("$@")
[ "${#steps[@]}" -eq 0 ] && steps=(sync draft)
for step in "${steps[@]}"; do
  case "$step" in
    sync | draft | publish) ;;
    -h | --help) usage; exit 0 ;;
    *) echo "未知的步驟：$step" >&2; usage >&2; exit 2 ;;
  esac
done

find_node() {
  if [ -n "${NODE_BIN:-}" ]; then echo "$NODE_BIN"; return; fi
  command -v node && return
  local candidate
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] && echo "$candidate" && return
  done
  return 1
}

NODE="$(find_node)" || { echo "找不到 node，請設定 NODE_BIN。" >&2; exit 1; }
export PATH="$(dirname "$NODE"):$PATH"

mkdir -p "$ROOT/state"
# 日誌過大時保留一份舊檔。
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt "$LOG_MAX_BYTES" ]; then mv -f "$LOG" "$LOG.1"; fi
exec >>"$LOG" 2>&1

cd "$ROOT" || exit 1
echo "===== $(date '+%Y-%m-%d %H:%M:%S') 開始：${steps[*]} ====="

status=0
if ! "$NODE" "$ROOT/node_modules/typescript/bin/tsc" -p tsconfig.json; then
  echo "編譯失敗，中止。"
  exit 1
fi

for step in "${steps[@]}"; do
  case "$step" in
    sync) flag=(--sync) ;;
    draft) flag=(--draft) ;;
    publish) flag=(--publish) ;;
  esac
  echo "--- $step ---"
  if ! "$NODE" "$ROOT/dist/src/main.js" "${flag[@]}"; then
    echo "步驟 $step 失敗。"
    status=1
    # 資料庫同步失敗時，後續步驟只會處理舊資料，直接中止。
    [ "$step" = sync ] && break
  fi
done

echo "===== $(date '+%Y-%m-%d %H:%M:%S') 結束（結束碼 $status）====="
exit "$status"
