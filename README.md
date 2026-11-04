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
| `wiki.url` / `username` / `password` | 發佈目標，網址須以 `/` 結尾。讀取既有頁面不需登入，發佈與還原才需要 |
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
| `--publish` | 發佈所有草稿，並更新「條目索引」頁 |
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

## 運作方式

1. **篩選**：把新主題連同 wiki 上已發佈條目的摘要送給模型。它挑出有實質內容的主題（技術知識、設定經驗、資安與產業事件、決策比較、專案構想；排除閒聊與活動聯絡），把同一件事的主題合併，並判斷是新建條目還是併入既有條目。主題清單過長時自動分批。
2. **整理**：用原始訊息（發言者以 `s1`、`s2` 代號取代）重寫條目；併入既有條目時，模型會拿到現有頁面全文並輸出完整的更新版。
3. **清理**：模型輸出的 wikitext 會過濾樣板、魔術字、非 `<code>` 的 HTML、未知的內部連結、邀請／會議／短網址連結、Email 與電話；其餘外部網址保留，但列入草稿 `flags` 供審核。
4. **草稿**：存成 `<id>.wiki`（可編輯）與 `<id>.json`（目標頁面、模式、審核提示等）。
5. **發佈**：新頁面使用 `createonly`，不會覆蓋同名頁面（撞名時標題加上主題 id）；更新頁面時若版本已被他人修改就略過，除非加 `--force`。發佈後重新產生「條目索引」。

頁面內容包含摘要、依主題而定的章節、待查證、相關條目、資料來源（時間、訊息數、可信度）與分類。頁面不含 chat id 與 topic id（wiki 匿名可讀），它們只存在於隱藏的 `<!-- nekowiki {...} -->` 標記與 `state/`。

## 狀態檔

| 檔案 | 用途 |
|---|---|
| `state/state.json` | 主題 → 已發佈頁面（`null` 表示判定不收錄），以及各頁面的來源資訊 |
| `state/plan.json` | 已篩選但尚未產生草稿的分組；中斷後接續，不再重篩 |
| `state/drafts/` | 待審核與發佈的草稿 |
| `state/run.lock` | 寫入類操作的互斥鎖；持有者的 PID 已不存在時自動回收 |

`state.json` 遺失時可用 `--rebuild-state` 還原。判定不收錄的主題無法還原，會重新篩選（只花 API 費用，不會重複發佈）。

## 限制

- 同一輪的草稿彼此看不到對方，同一輪內跨聊天室的重複主題不會合併；發佈後下一輪才會併入。
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
