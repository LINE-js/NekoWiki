import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildInput, interpretEntry } from '../src/compose.js';
import type { Topic } from '../src/db.js';
import { acquireLock } from '../src/lock.js';
import { OpenAI, OpenAIError, type OpenAIFetch } from '../src/openai.js';
import { leadSummary, pageTitle, parseMarker, renderIndex, renderPage, timeRange } from '../src/render.js';
import { retry } from '../src/retry.js';
import { sanitizeWikitext } from '../src/sanitize.js';
import { chunkTopics, interpretGroups } from '../src/triage.js';

const topic = (id: number, title = `t${id}`): Topic => ({
  id, chatId: 'mchat', hour: '2026-10-26 06', title, points: ['p'], startAt: '2026-10-26 06:00:00', endAt: '2026-10-26 06:30:00',
});

test('interpretGroups drops unknown ids, never reuses a topic and only keeps mergeInto naming an existing page', () => {
  const groups = interpretGroups({
    groups: [
      { title: 'A', mergeInto: 'Old page', topicIds: [1, 2, 99, 2] },
      { title: 'B', mergeInto: 'Nope', topicIds: [2, 3] },
      { title: 'C', mergeInto: '', topicIds: [98] },
      { title: ' ', mergeInto: '', topicIds: [1] },
    ],
  }, [topic(1), topic(2), topic(3)], new Set(['Old page']));
  assert.deepEqual(groups, [
    { title: 'A', topicIds: [1, 2], mergeInto: 'Old page' },
    { title: 'B', topicIds: [3] },
  ]);
});

test('chunkTopics keeps order, loses nothing and respects the budget', () => {
  const topics = Array.from({ length: 20 }, (_, index) => topic(index + 1, 'x'.repeat(40)));
  const chunks = chunkTopics(topics, 600);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat().map((item) => item.id), topics.map((item) => item.id));
  for (const chunk of chunks) {
    const stubs = chunk.map((item) => ({ id: item.id, hour: item.hour, title: item.title, point: item.points[0] }));
    assert.ok(JSON.stringify(stubs).length <= 600);
  }
});

test('sanitizeWikitext removes structure-changing markup and private details but keeps known links', () => {
  const { text, flags } = sanitizeWikitext(
    "{{Template}} 看 [[Known page|這篇]]、[[Category:X]]、[[Secret]]。<script>x</script><code>cmd</code> "
    + 'https://discord.gg/abc 與 https://example.org/doc。聯絡 a@b.com 或 0912-345-678。__TOC__\n== 標題 ==',
    new Set(['Known page']),
  );
  assert.ok(!text.includes('{{') && !text.includes('<script>') && !text.includes('discord.gg'));
  assert.ok(!text.includes('a@b.com') && !text.includes('0912') && !text.includes('__TOC__') && !text.includes('[[Category'));
  assert.ok(text.includes('[[Known page|這篇]]') && text.includes('<code>cmd</code>') && text.includes('https://example.org/doc'));
  assert.ok(text.includes("'''標題'''") && !text.includes('[[Secret]]') && text.includes('Secret'));
  assert.ok(flags.includes('含外部網址：example.org') && flags.includes('移除 Email'));
});

test('buildInput hides sender ids behind stable per-entry labels', () => {
  const input = buildInput('T', [topic(1)], [
    { sentAt: '2026-10-26 06:53:33', senderId: 'pAAA', text: 'one' },
    { sentAt: '2026-10-26 07:19:33', senderId: 'pBBB', text: 'two' },
    { sentAt: '2026-10-26 07:19:52', senderId: 'pAAA', text: 'three' },
  ]);
  assert.ok(!input.json.includes('pAAA') && !input.json.includes('pBBB'));
  assert.deepEqual(JSON.parse(input.json).messages.map((m: { speaker: string }) => m.speaker), ['s1', 's2', 's1']);
  assert.equal(input.messageCount, 3);
  assert.equal(input.startAt, '2026-10-26 06:53:33');
  assert.equal(input.endAt, '2026-10-26 07:19:52');
});

test('timeRange repeats the date only across days', () => {
  assert.equal(timeRange('2026-10-26 06:53:33', '2026-10-26 07:22:42'), '2026-10-26 06:53 ~ 07:22');
  assert.equal(timeRange('2026-10-26 23:50:00', '2026-10-27 00:10:00'), '2026-10-26 23:50 ~ 2026-10-27 00:10');
});

test('pageTitle strips characters MediaWiki forbids and falls back when nothing survives', () => {
  assert.equal(pageTitle('Tailscale SSH: 安全/疑慮 [重要]', 'x'), 'Tailscale SSH 安全 疑慮 重要');
  assert.equal(pageTitle('#<>', '主題 5'), '主題 5');
});

test('interpretEntry rejects entries without a usable summary or confidence', () => {
  assert.equal(interpretEntry({ title: 'a', summary: ' ', confidence: '中' }), undefined);
  assert.equal(interpretEntry({ title: 'a', summary: 's', confidence: 'x' }), undefined);
});

const ENTRY = interpretEntry({
  title: 'Tailscale SSH 安全疑慮', type: '事件 / 資安', tags: ['Tailscale', 'a|b'], confidence: '低',
  confidenceNote: '群組成員轉述', summary: '摘要內容 {{bad}}',
  sections: [{ heading: '建議 [x]', body: '* 刪除裝置 [[Other]]' }], todo: ['確認 CVE'], related: ['Other', 'Unknown', 'Self'],
});

test('renderPage sanitizes, limits related entries to known pages, hides IDs and round-trips its marker', () => {
  assert.ok(ENTRY);
  const meta = { topicIds: [225, 305], startAt: '2026-10-26 06:53:33', endAt: '2026-10-26 07:22:42', messageCount: 6, type: '事件 / 資安' };
  const { text, flags } = renderPage(ENTRY, meta, new Set(['Other']), 'Self');
  assert.equal(text.split('\n<!--')[0], `摘要內容

== 建議 x ==
* 刪除裝置 [[Other]]

== 待查證 ==
* 確認 CVE

== 相關條目 ==
* [[Other]]

== 資料來源 ==
* 討論時間：2026-10-26 06:53 ~ 07:22
* 訊息數：6
* 可信度：低（群組成員轉述）
* 來源：聊天室討論，由 AI 自動整理，未經獨立核實。

[[Category:事件]]
[[Category:資安]]
[[Category:Tailscale]]
[[Category:a b]]
[[Category:NekoWiki 自動整理]]`);
  assert.ok(flags.includes('移除樣板 {{…}}') && flags.includes('模型自評可信度低'));
  assert.deepEqual(parseMarker(text), meta);
  assert.equal(leadSummary(text), '摘要內容');
  assert.equal(parseMarker('<!-- nekowiki {broken} -->'), undefined);
});

test('renderIndex groups by the first type segment', () => {
  const info = (type: string) => ({ type, summary: '摘要' });
  const text = renderIndex({ B: info('資安 / 事件'), A: info('資安'), C: info('') });
  assert.match(text, /== 資安 ==\n\* \[\[A\]\]：摘要\n\* \[\[B\]\]：摘要/);
  assert.match(text, /== 其他 ==\n\* \[\[C\]\]：摘要/);
});

test('retry retries only errors flagged retryable and backs off exponentially', async () => {
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => { delays.push(ms); return Promise.resolve(); };
  let calls = 0;
  const result = await retry(() => {
    calls += 1;
    return calls < 3 ? Promise.reject(Object.assign(new Error('x'), { retryable: true })) : Promise.resolve('ok');
  }, sleep);
  assert.equal(result, 'ok');
  assert.deepEqual(delays, [1000, 2000]);
  calls = 0;
  await assert.rejects(retry(() => { calls += 1; return Promise.reject(new Error('fatal')); }, sleep), /fatal/);
  assert.equal(calls, 1);
});

test('OpenAI client retries 429, returns the function arguments and accumulates usage', async () => {
  const statuses = [429, 200];
  const fetchImpl: OpenAIFetch = () => {
    const status = statuses.shift() ?? 500;
    return Promise.resolve({
      ok: status === 200, status,
      json: () => Promise.resolve({
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [{ type: 'function_call', name: 'f', arguments: '{"a":1}' }],
      }),
    });
  };
  const client = new OpenAI({ apiKey: 'k', model: 'm', maxOutputTokens: 9, timeoutMs: 1000 }, fetchImpl, () => Promise.resolve());
  assert.deepEqual(await client.callTool('s', { name: 'f', description: 'd', parameters: {} }, 'c'), { a: 1 });
  assert.deepEqual(client.usage, { requests: 1, inputTokens: 10, outputTokens: 5 });
  const refusing = new OpenAI({ apiKey: 'k', model: 'm', maxOutputTokens: 9, timeoutMs: 1000 }, () => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve({ output: [{ type: 'message', content: [{ type: 'refusal' }] }] }),
  }));
  await assert.rejects(refusing.callTool('s', { name: 'f', description: 'd', parameters: {} }, 'c'), (error: unknown) =>
    error instanceof OpenAIError && error.code === 'REFUSED');
});

test('acquireLock is exclusive, released on request, and reclaims a dead owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nekowiki-'));
  const path = join(dir, 'run.lock');
  try {
    const release = await acquireLock(path);
    await assert.rejects(acquireLock(path), /已有另一個執行中的程序/);
    await release();
    await writeFile(path, '2147483646\n');
    await (await acquireLock(path))();
  } finally {
    await rm(dir, { recursive: true });
  }
});
