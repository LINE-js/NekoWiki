#!/usr/bin/env bash
# 批次為既有文章補上導覽；預設只產生審核清單，--apply 才寫入 wiki。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

find_node() {
  if [ -n "${NODE_BIN:-}" ]; then echo "$NODE_BIN"; return; fi
  command -v node && return
  local candidate
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "${HOME:-}"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] && echo "$candidate" && return
  done
  return 1
}

NODE="$(find_node)" || { echo "找不到 node，請設定 NODE_BIN。" >&2; exit 1; }
export PATH="$(dirname "$NODE"):${PATH:-/usr/bin:/bin}"
cd "$ROOT"
"$NODE" "$ROOT/node_modules/typescript/bin/tsc" -p tsconfig.json
exec "$NODE" "$ROOT/dist/src/backfill-main.js" "$@"
