import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.js';
import { ChatLogReader } from './db.js';
import { acquireLock } from './lock.js';
import { OpenAI } from './openai.js';
import { discardDraft, rebuildState, runDraft, runPublish, type Deps, type Report } from './pipeline.js';
import { Store } from './state.js';
import { syncDatabase } from './sync.js';
import { WikiClient } from './wiki.js';

const USAGE = `用法：node dist/src/main.js [模式] [選項]
模式（擇一；都不指定時為 dry-run：只印出結果，不寫入任何檔案或 wiki）：
  --draft            篩選、整理並把草稿存到 state/drafts/（<id>.wiki 可先人工編輯）
  --publish          發佈草稿、更新「條目索引」，並同步共用導覽模板（無草稿也會同步模板）
  --discard <id>     捨棄草稿，其主題標記為不收錄
  --rebuild-state    從 wiki 頁面的來源標記還原 state.json
  --sync             先把 config.yaml 的 syncFrom 資料庫複製成本目錄的 chatlog.db
選項：
  --config <path>    設定檔（預設 config.yaml）
  --chat <id>        只處理設定檔 chats 內的指定聊天室
  --topic <id>       跳過篩選，直接處理單一主題（已發佈則更新該頁）
  --limit <n>        每個聊天室最多送去篩選的待處理主題數
  --force            重做已有草稿或已發佈的主題；發佈時覆寫已被修改的頁面
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'config.yaml' },
      chat: { type: 'string' },
      topic: { type: 'string' },
      limit: { type: 'string' },
      draft: { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      discard: { type: 'string' },
      'rebuild-state': { type: 'boolean', default: false },
      sync: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) { process.stdout.write(USAGE); return; }
  const modes = [values.draft, values.publish, values.discard !== undefined, values['rebuild-state']].filter(Boolean).length;
  if (modes > 1) throw new ConfigError('--draft、--publish、--discard、--rebuild-state 只能擇一。');
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (!(limit > 0)) throw new ConfigError('--limit 必須是正整數。');
  const topic = values.topic === undefined ? undefined : Number(values.topic);
  if (topic !== undefined && !Number.isSafeInteger(topic)) throw new ConfigError('--topic 必須是整數。');
  const discardId = values.discard === undefined ? undefined : Number(values.discard);
  if (discardId !== undefined && !Number.isSafeInteger(discardId)) throw new ConfigError('--discard 必須是整數。');

  const config = await loadConfig(values.config);
  if (values.chat !== undefined && !config.chats.includes(values.chat)) throw new ConfigError('--chat 必須是 config.yaml chats 清單內的 ID。');

  const store = new Store(config.stateDir);
  await store.init();
  // Everything but a dry run writes state or the database, so only dry runs may run alongside another process.
  const writes = modes > 0 || values.sync;
  const release = writes ? await acquireLock(join(config.stateDir, 'run.lock')) : undefined;
  try {
    if (values.sync) {
      if (!config.syncFrom) throw new ConfigError('--sync 需要 config.yaml 的 syncFrom。');
      await syncDatabase(config.syncFrom, config.database);
      console.log(`已同步 ${config.syncFrom} → ${config.database}`);
      if (modes === 0 && !values.chat && topic === undefined) return;
    }

    const llm = new OpenAI(config.openai);
    const log = new ChatLogReader(config.database);
    try {
      const deps: Deps = {
        log, llm, store, chats: config.chats, settleMinutes: config.settleMinutes,
        wiki: config.wiki ? new WikiClient(config.wiki) : undefined,
        print: (line) => console.log(line),
      };
      let report: Report | undefined;
      if (discardId !== undefined) await discardDraft(deps, discardId);
      else if (values['rebuild-state']) report = await rebuildState(deps);
      else if (values.publish) report = await runPublish(deps, { force: values.force });
      else {
        report = await runDraft(deps, {
          ...(values.chat === undefined ? {} : { chat: values.chat }),
          ...(topic === undefined ? {} : { topic }),
          limit, force: values.force, persist: values.draft,
        });
      }
      if (report) {
        console.log(`完成：成功 ${report.ok}，失敗 ${report.failed}，略過 ${report.skipped}`);
        if (llm.usage.requests > 0) {
          console.log(`OpenAI：${llm.usage.requests} 次請求，輸入 ${llm.usage.inputTokens} tokens，輸出 ${llm.usage.outputTokens} tokens`);
        }
        if (report.failed > 0) process.exitCode = 1;
      }
    } finally {
      log.close();
    }
  } finally {
    await release?.();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
