# NekoWiki

把 [NekoBrief](../NekoBrief) 紀錄的聊天室主題（`chatlog.db`）提煉成可 wiki 化的知識條目，發佈到 MediaWiki。

流程分兩階段：先產生草稿讓人審核，確認後才發佈。AI 只負責整理與草擬，不會未經審核就寫入 wiki。

## 需求

- Node.js ≥ 22.13（使用內建的 `node:sqlite`）
- NekoBrief 產生的 `chatlog.db`
- OpenAI API 金鑰（模型需支援 strict function calling，使用 Responses API）
- MediaWiki 站台與 bot 帳號（bot password），需有 `edit`、`createpage` 權限

## 安裝與設定

```sh
npm install
cp config.example.yaml config.yaml
chmod 600 config.yaml   # 含金鑰，權限不對程式會拒絕載入
```

編輯 `config.yaml`：

| 欄位 | 說明 |
|---|---|
| `chats` | 要處理的聊天室 ID 清單（對應 `chatlog.db` 的 `chat_id`） |
| `openai.apiKey` / `model` | 必填。`maxOutputTokens` 預設 16000（推理模型的思考 token 也算在內），`timeoutMs` 預設 180000 |
| `wiki.url` / `username` / `password` | 發佈目標，讀取既有頁面不需登入，發佈與還原才需要 |
| `stateDir` | 處理進度所在目錄，預設 `state` |
| `settleMinutes` | 比最新主題早不到這麼多分鐘的主題先不處理（NekoBrief 的主題可能還會延續），預設 120 |
| `syncFrom` | 選填，`--sync` 要複製的 NekoBrief 資料庫路徑 |

`config.yaml`、`chatlog.db`、`state/` 都已被 `.gitignore` 排除。

## 使用

```sh
npm run build
node dist/src/main.js [模式] [選項]
```

標準流程：

```sh
node dist/src/main.js --sync       # 1. 同步最新的 chatlog.db
node dist/src/main.js --draft      # 2. 篩選並產生草稿
# 3. 檢視 state/drafts/<id>.wiki 與 <id>.json，必要時直接編輯 .wiki
node dist/src/main.js --publish    # 4. 發佈草稿並更新「條目索引」
```

| 模式 | 說明 |
|---|---|
| （不指定） | dry-run：只印出結果，不寫入任何檔案或 wiki |
| `--draft` | 篩選、整理、清理，草稿存到 `state/drafts/` |
| `--publish` | 發佈所有草稿、更新「條目索引」，並同步共用導覽模板（沒有草稿也會同步模板） |
| `--discard <id>` | 捨棄草稿，其主題標記為不收錄 |
| `--rebuild-state` | 從 wiki 頁面的來源標記還原 `state.json` |
| `--sync` | 把 `syncFrom` 的資料庫複製成本目錄的 `chatlog.db`，可與其他模式併用 |

| 選項 | 說明 |
|---|---|
| `--config <path>` | 設定檔，預設 `config.yaml` |
| `--chat <id>` | 只處理 `chats` 內的指定聊天室 |
| `--topic <id>` | 跳過篩選，直接處理單一主題；已發佈的主題會更新原頁面 |
| `--limit <n>` | 每個聊天室最多送去篩選的待處理主題數 |
| `--force` | 重做已有草稿或已發佈的主題；發佈時覆寫在草稿之後被修改過的頁面 |

結束時會印出成功、失敗、略過的數量與 OpenAI 用量；有失敗時結束碼為 1。

## 排程（cron）

`scripts/run.sh` 依序執行指定的步驟，輸出追加到 `state/cron.log`（超過 1 MB 保留一份 `.1`），任一步失敗結束碼為 1。腳本會自行尋找 node（cron 的 `PATH` 很精簡，也可用 `NODE_BIN` 指定）並先編譯。

```sh
scripts/run.sh                      # 預設 sync draft：只產生草稿，留待人工審核
scripts/run.sh sync draft publish   # 完全自動：草稿不經審核直接發佈
```

```cron
10 * * * * /path/to/NekoWiki/scripts/run.sh
```

完全自動等於跳過審核，頁面內容來自私人聊天室，請先確認清理規則符合需求。同時只會有一個寫入類程序執行，鎖被占用時該次會失敗並記錄在日誌，下次排程再跑。

## 運作方式

1. **篩選**：把新主題連同 wiki 上已發佈條目的摘要送給模型。它挑出有實質內容的主題（技術知識、設定經驗、資安與產業事件、決策比較、專案構想；排除閒聊與活動聯絡），把同一件事的主題合併，並判斷是新建條目還是併入既有條目。主題清單過長時自動分批。
2. **整理**：用原始訊息（發言者以 `s1`、`s2` 代號取代）重寫條目；併入既有條目時，模型會拿到現有頁面全文並輸出完整的更新版。
3. **清理**：模型輸出的 wikitext 會過濾樣板、魔術字、非 `<code>` 的 HTML、未知的內部連結、邀請／會議／短網址連結、Email 與電話；其餘外部網址保留，但列入草稿 `flags` 供審核。
4. **草稿**：存成 `<id>.wiki`（可編輯）與 `<id>.json`（目標頁面、模式、審核提示等）。
5. **發佈**：新頁面使用 `createonly`，不會覆蓋同名頁面（撞名時標題加上主題 id）；更新頁面時若版本已被他人修改就略過，除非加 `--force`。發佈後重新產生「條目索引」。

頁面內容包含摘要、依主題而定的章節、待查證、相關條目、資料來源（時間、訊息數、可信度）與分類。頁面不含 chat id 與 topic id（wiki 匿名可讀），它們只存在於隱藏的 `<!-- nekowiki {...} -->` 標記與 `state/`。

### 相關主題導覽

產生草稿時，AI 會建議最多 3 個具體主題群組，優先沿用已發佈文章與待審草稿的群組名稱，並在文章底部加入例如 `{{NekoWiki導覽/Tailscale}}`。審核時可直接修改或移除 `.wiki` 中的引用；發佈以實際引用為準，不以隱藏標記中的舊群組為準。

發佈成功後，系統更新 `Template:NekoWiki導覽/<群組>`，列出同群組已成功發佈的條目。模板使用原生 wikitext 表格，不需額外安裝擴充套件。只管理具有 NekoWiki 擁有權標記的專用模板；遇到未標記的同名模板會拒絕覆寫。

模板更新失敗會回報失敗；重新執行 `--publish` 即可補做，即使沒有待發佈草稿也可以。文章移出群組後會同步移除舊導覽中的連結。既有文章可用下方的批次腳本補齊導覽，不必重新產生正文。

### 批次補齊既有文章

```sh
scripts/backfill-navigation.sh              # 讀取 wiki、呼叫 OpenAI，只產生審核清單
# 編輯 state/navigation-backfill.json 的 pages[].navigationGroups
scripts/backfill-navigation.sh --apply      # 套用審核結果；不呼叫 OpenAI
```

- 只處理「NekoWiki 自動整理」分類內、有來源標記且尚未有導覽的文章；不需 `chatlog.db`。原有正文、分類與來源標記逐字保留，只在底部追加導覽引用。
- 清單預設位於設定的 `stateDir/navigation-backfill.json`。每篇最多 3 個具體群組；可修改 `navigationGroups`，改成 `[]` 或移除該筆表示略過。其餘欄位保留原樣，供版本與內容核對。
- `--apply` 會重新讀取頁面；版本或內容已改變就跳過，不提供強制覆蓋。使用同一份清單重跑可補做失敗的文章／模板，不會重複加引用。
- 模板依 wiki 上已發佈文章的實際引用重建，不會把未發佈建議放進導覽。和排程共用 `state/run.lock`，避免同時寫入。
- 清單不會被覆寫；新一批或發生版本衝突後，使用新的 `--plan` 檔案重新產生、審核。產生清單每篇會呼叫 OpenAI；先用 `--limit 5` 小批試跑可控制用量。
- 支援 `--config`、`--plan`、`--limit`（僅產生清單）、`--help` 與 `NODE_BIN`。相對路徑以專案根目錄為準，會先編譯，輸出直接顯示於終端機；失敗結束碼為 1，版本衝突列為略過。

```sh
scripts/backfill-navigation.sh --limit 5 --plan state/navigation-batch-1.json
scripts/backfill-navigation.sh --apply --plan state/navigation-batch-1.json
```

## 狀態檔

| 檔案 | 用途 |
|---|---|
| `state/state.json` | 主題 → 已發佈頁面（`null` 表示判定不收錄），以及各頁面的來源資訊 |
| `state/plan.json` | 已篩選但尚未產生草稿的分組；中斷後接續，不再重篩 |
| `state/drafts/` | 待審核與發佈的草稿 |
| `state/run.lock` | 寫入類操作的互斥鎖；持有者的 PID 已不存在時自動回收 |

`state.json` 遺失時可用 `--rebuild-state` 還原。判定不收錄的主題無法還原，會重新篩選（只花 API 費用，不會重複發佈）。

## 限制

- 同一輪內跨聊天室的重複主題不會合併；發佈後下一輪才會併入。導覽群組名稱則會參考待審草稿。
- 內容來自聊天室成員的轉述，AI 整理後未經獨立核實，頁面上的可信度是模型的自評。
- 目前 wiki 首頁不會被修改。

## 開發

```sh
npm run typecheck
npm test
```

測試包含單元測試，以及以假模型與假 wiki 驅動的整合測試（草稿、接續、發佈、更新、還原）。

## 授權

Apache-2.0，見 [LICENSE](LICENSE)。
