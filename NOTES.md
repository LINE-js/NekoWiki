# NekoWiki

從 NekoBrief 的 `chatlog.db` 提煉可 wiki 化的知識，發佈到 https://wiki.yustellar.dev/（MediaWiki）。

## 流程
1. `--sync`：把 `syncFrom`（NekoBrief 的資料庫）複製成本目錄的 `chatlog.db`（`VACUUM INTO`，可安全複製寫入中的 WAL 資料庫）。
2. `--draft`：對 `config.yaml` `chats` 內的每個聊天室篩選新主題（略過最新主題前 `settleMinutes` 分鐘內仍在進行的）、
   合併同一件事、決定新建或併入既有條目，整理並清理後存成 `state/drafts/<id>.wiki`（可人工編輯）與 `<id>.json`（中繼資料與審核提示）。
3. 檢視草稿；不要的用 `--discard <id>`。
4. `--publish`：發佈所有草稿，更新「條目索引」。更新既有頁面時，若頁面在草稿之後被改過就略過，除非加 `--force`。
- 不加模式旗標為 dry-run：只印出結果，不寫入任何東西。
- `--rebuild-state`：`state.json` 遺失時，從頁面內隱藏的 `<!-- nekowiki {...} -->` 標記還原。
- 被篩掉的主題記為 `null`，遺失後會重新篩選（只花費用，不會重複發佈）。

## 狀態與鎖
- `state/state.json`：主題 → 頁面、頁面的來源資訊。`state/plan.json`：已篩選但未產生草稿的分組（中斷後接續，不再重篩）。
- `state/run.lock`：寫入類操作的互斥鎖，過期（PID 不存在）會自動回收。

## 安全
- 發佈的頁面不含 chat id 與 topic id（wiki 匿名可讀）；它們只在隱藏標記與 `state/` 內。
- 模型輸出的 wikitext 會被清理：樣板、魔術字、非 `<code>` 的 HTML、未知內部連結、邀請／會議／短網址連結、Email、電話。
  其餘外部網址保留但會列入草稿的審核提示。
- 帳號密碼在 `config.yaml`（已被 .gitignore 排除，權限 600）。

## 尚未做
- 跨聊天室同一輪內互相合併：同一輪草稿彼此看不到對方，需先發佈再跑下一輪才會併入。
- 首頁（預設頁）尚未改為導覽頁。
