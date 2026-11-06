import { open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyBackfill, parseBackfillPlan, prepareBackfill } from './backfill.js';
import { ConfigError, loadConfig } from './config.js';
import { acquireLock } from './lock.js';
import { OpenAI } from './openai.js';
import { Store } from './state.js';
import { WikiClient } from './wiki.js';

const USAGE = `用法：scripts/backfill-navigation.sh [--apply] [選項]
預設：讀取既有文章，呼叫 OpenAI 建議群組並產生審核清單；不修改 wiki。
  --apply           套用已審核清單，只補導覽並更新共用模板，不呼叫 OpenAI
  --config <path>   設定檔（預設 config.yaml）
  --plan <path>     審核清單（預設 <stateDir>/navigation-backfill.json）
  --limit <n>       最多為 n 篇文章建議群組（僅產生清單時使用）
  --help, -h        顯示說明
審核：只修改 pages[].navigationGroups；空陣列或移除該筆代表不處理。
請勿修改 title、baseRevid、originalText 或 wikiUrl，它們用於防止覆蓋。
既有清單不會被覆寫；新一批請用 --plan 指定另一個檔案。
頁面版本已變更會跳過；發生失敗可重跑相同 --apply，不會重複加模板。
相對路徑以專案根目錄為準。輸出直接顯示於終端機。
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean' },
      config: { type: 'string', default: 'config.yaml' },
      plan: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) { console.log(USAGE); return; }
  if (values.apply && values.limit !== undefined) throw new ConfigError('--apply 不支援 --limit；請先從清單移除不想處理的項目。');
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (values.limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new ConfigError('--limit 必須是正整數。');
  const config = await loadConfig(values.config);
  if (!config.wiki) throw new ConfigError('回填需要 config.yaml 的 wiki 設定。');
  const planPath = values.plan === undefined ? join(config.stateDir, 'navigation-backfill.json') : resolve(values.plan);
  const store = new Store(config.stateDir);
  await store.init();
  const release = await acquireLock(join(config.stateDir, 'run.lock'));
  try {
    const llm = new OpenAI(config.openai);
    const deps = { wiki: new WikiClient(config.wiki), llm, store, print: (line: string) => console.log(line) };
    console.log(`目標 wiki：${config.wiki.url}`);
    let report;
    if (values.apply) {
      const plan = parseBackfillPlan(JSON.parse(await readFile(planPath, 'utf8')) as unknown);
      report = await applyBackfill(deps, plan, config.wiki.url);
    } else {
      // Reserve before paid requests, so an existing reviewed plan is never overwritten.
      const file = await open(planPath, 'wx', 0o600).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          throw new Error(`清單已存在：${planPath}。請審核後 --apply，或用 --plan 指定新檔案。`);
        }
        throw error;
      });
      let saved = false;
      try {
        const prepared = await prepareBackfill(deps, config.wiki.url, limit);
        await file.writeFile(`${JSON.stringify(prepared.plan, null, 2)}\n`);
        saved = true;
        report = prepared.report;
        console.log(`審核清單：${planPath}`);
        console.log('尚未修改 wiki；請審核 navigationGroups，再用相同 --plan 加 --apply 套用。');
      } finally {
        await file.close();
        if (!saved) await rm(planPath, { force: true });
      }
    }
    console.log(`完成：成功 ${report.ok}，失敗 ${report.failed}，略過 ${report.skipped}`);
    if (llm.usage.requests > 0) {
      console.log(`OpenAI：${llm.usage.requests} 次請求，輸入 ${llm.usage.inputTokens} tokens，輸出 ${llm.usage.outputTokens} tokens`);
    }
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    await release();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
