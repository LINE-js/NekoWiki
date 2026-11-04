import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import { ChatLogReader } from '../src/db.js';
import type { Llm, ToolSpec } from '../src/openai.js';
import { discardDraft, rebuildState, runDraft, runPublish, type Deps } from '../src/pipeline.js';
import { INDEX_TITLE, parseMarker } from '../src/render.js';
import { Store } from '../src/state.js';
import type { Group } from '../src/triage.js';
import { WikiError, type EditOptions, type WikiApi, type WikiPage } from '../src/wiki.js';

const CHAT = 'mchat0123456789';

class FakeLlm implements Llm {
  groups: Group[] = [];
  triageCalls = 0;
  failEntry = false;
  entryTitle = 'Entry A';
  composeInputs: Record<string, unknown>[] = [];

  callTool(_system: string, tool: ToolSpec, content: string): Promise<unknown> {
    if (tool.name === 'record_groups') {
      this.triageCalls += 1;
      return Promise.resolve({ groups: this.groups.map((group) => ({ mergeInto: '', ...group })) });
    }
    if (this.failEntry) return Promise.reject(new Error('model down'));
    this.composeInputs.push(JSON.parse(content) as Record<string, unknown>);
    return Promise.resolve({
      title: this.entryTitle, type: '事件', tags: ['t'], confidence: '中', confidenceNote: '轉述',
      summary: `摘要 ${this.entryTitle}`, sections: [{ heading: '內容', body: '* 重點' }], todo: [], related: [],
    });
  }
}

class FakeWiki implements WikiApi {
  pages = new Map<string, { text: string; revid: number; user: string }>();
  revid = 100;
  loggedIn = false;

  login(): Promise<void> { this.loggedIn = true; return Promise.resolve(); }

  getPage(title: string): Promise<WikiPage | undefined> {
    const page = this.pages.get(title);
    return Promise.resolve(page && { title, ...page });
  }

  categoryMembers(category: string): Promise<string[]> {
    return Promise.resolve([...this.pages].filter(([, page]) => page.text.includes(`[[Category:${category}]]`)).map(([title]) => title));
  }

  edit(title: string, text: string, _summary: string, options: EditOptions = {}): Promise<number> {
    const existing = this.pages.get(title);
    if (options.createOnly && existing) return Promise.reject(new WikiError('articleexists'));
    if (options.baseRevId !== undefined && existing && existing.revid !== options.baseRevId) return Promise.reject(new WikiError('editconflict'));
    this.revid += 1;
    this.pages.set(title, { text, revid: this.revid, user: 'YuMeow' });
    return Promise.resolve(this.revid);
  }

  /** Someone else edits the page. */
  humanEdit(title: string): void {
    const page = this.pages.get(title);
    assert.ok(page);
    this.revid += 1;
    this.pages.set(title, { text: `${page.text}human`, revid: this.revid, user: 'Human' });
  }
}

let dir: string;
let log: ChatLogReader;
let db: DatabaseSync;
let llm: FakeLlm;
let wiki: FakeWiki;
let store: Store;
let printed: string[];
let deps: Deps;

function addTopic(id: number, end: string): void {
  db.prepare('INSERT INTO topics VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, CHAT, end.slice(0, 13), `title ${id}`, '["point"]', end, end);
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL, ?)').run(end, CHAT, `sender${id}`, `message ${id}`, `m${id}`, id);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nekowiki-pipeline-'));
  db = new DatabaseSync(join(dir, 'chatlog.db'));
  db.exec(`CREATE TABLE topics (id INTEGER PRIMARY KEY, chat_id TEXT, hour TEXT, title TEXT, points TEXT, start_at TEXT, end_at TEXT);
    CREATE TABLE messages (sent_at TEXT, chat_id TEXT, sender_id TEXT, text TEXT, message_id TEXT, summary_id INTEGER, topic_id INTEGER)`);
  addTopic(1, '2026-10-26 06:10:00');
  addTopic(2, '2026-10-26 06:20:00');
  addTopic(3, '2026-10-26 06:30:00');
  addTopic(4, '2026-10-26 07:00:00');
  addTopic(5, '2026-10-26 20:00:00'); // newest: defines "now", and is still settling
  db.close();
  log = new ChatLogReader(join(dir, 'chatlog.db'));
  llm = new FakeLlm();
  wiki = new FakeWiki();
  store = new Store(join(dir, 'state'));
  await store.init();
  printed = [];
  deps = { log, llm, wiki, store, chats: [CHAT], settleMinutes: 120, print: (line) => printed.push(line) };
});

afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true });
});

const draftOptions = { limit: Infinity, force: false, persist: true };

test('draft stores reviewed-able files, marks rejected topics, skips settling topics and clears the plan', async () => {
  llm.groups = [{ title: 'G', topicIds: [1, 2] }];
  const report = await runDraft(deps, draftOptions);
  assert.deepEqual(report, { ok: 1, failed: 0, skipped: 0 });
  const [draft] = await store.listDrafts();
  assert.ok(draft);
  assert.deepEqual([draft.id, draft.mode, draft.page, draft.topicIds], [1, 'create', 'Entry A', [1, 2]]);
  assert.deepEqual(parseMarker(draft.text)?.topicIds, [1, 2]);
  const state = await store.loadState();
  // 3 and 4 were left out by triage; 5 is inside the settle window and untouched.
  assert.deepEqual(state.topics, { 3: null, 4: null });
  assert.deepEqual(await store.loadPlan(), {});
});

test('a dry run prints the entry and writes nothing', async () => {
  llm.groups = [{ title: 'G', topicIds: [1] }];
  await runDraft(deps, { ...draftOptions, persist: false });
  assert.ok(printed.some((line) => line.includes('===== Entry A')));
  assert.deepEqual(await store.listDrafts(), []);
  assert.deepEqual(await store.loadState(), { topics: {}, pages: {} });
});

test('a failed group does not stop the run and the next run resumes it without triaging again', async () => {
  llm.groups = [{ title: 'G1', topicIds: [1] }, { title: 'G2', topicIds: [2] }];
  llm.failEntry = true;
  assert.deepEqual(await runDraft(deps, draftOptions), { ok: 0, failed: 2, skipped: 0 });
  assert.equal((await store.loadPlan())[CHAT]?.length, 2);
  llm.failEntry = false;
  llm.groups = [];
  assert.deepEqual(await runDraft(deps, draftOptions), { ok: 2, failed: 0, skipped: 0 });
  assert.equal(llm.triageCalls, 1);
  assert.equal((await store.listDrafts()).length, 2);
  assert.deepEqual(await store.loadPlan(), {});
});

test('publish creates pages, avoids clobbering a same-titled page, records state and writes the index', async () => {
  wiki.pages.set('Entry A', { text: 'unrelated', revid: 1, user: 'Human' });
  llm.groups = [{ title: 'G', topicIds: [1] }];
  await runDraft(deps, draftOptions);
  assert.deepEqual(await runPublish(deps, { force: false }), { ok: 1, failed: 0, skipped: 0 });
  assert.equal(wiki.pages.get('Entry A')?.text, 'unrelated');
  const state = await store.loadState();
  assert.equal(state.topics['1'], 'Entry A（1）');
  assert.equal(state.pages['Entry A（1）']?.topicIds[0], 1);
  assert.ok(wiki.pages.get(INDEX_TITLE)?.text.includes('[[Entry A（1）]]'));
  assert.deepEqual(await store.listDrafts(), []);
});

async function publishFirst(): Promise<void> {
  llm.groups = [{ title: 'G', topicIds: [1, 2] }];
  await runDraft(deps, draftOptions);
  await runPublish(deps, { force: false });
  // Triage rejected topics 3 and 4 above; make them pending again for the follow-up run.
  const state = await store.loadState();
  delete state.topics['3'];
  delete state.topics['4'];
  await store.saveState(state);
}

test('a later group merges into an existing page: the model sees the page and provenance accumulates', async () => {
  await publishFirst();
  llm.groups = [{ title: 'G', topicIds: [3], mergeInto: 'Entry A' }];
  await runDraft(deps, draftOptions);
  const update = llm.composeInputs.at(-1);
  assert.ok(typeof update?.currentPage === 'string' && update.currentPage.includes('摘要 Entry A'));
  const [draft] = await store.listDrafts();
  assert.equal(draft?.mode, 'update');
  assert.equal(draft?.baseRevid, wiki.pages.get('Entry A')?.revid);
  await runPublish(deps, { force: false });
  const meta = parseMarker(wiki.pages.get('Entry A')?.text ?? '');
  assert.deepEqual(meta?.topicIds, [1, 2, 3]);
  assert.equal(meta?.messageCount, 3);
  assert.equal((await store.loadState()).topics['3'], 'Entry A');
});

test('publishing an update refuses a page edited since the draft unless forced', async () => {
  await publishFirst();
  llm.groups = [{ title: 'G', topicIds: [3], mergeInto: 'Entry A' }];
  await runDraft(deps, draftOptions);
  wiki.humanEdit('Entry A');
  assert.deepEqual(await runPublish(deps, { force: false }), { ok: 0, failed: 0, skipped: 1 });
  assert.ok(wiki.pages.get('Entry A')?.text.endsWith('human'));
  assert.equal((await store.listDrafts()).length, 1);
  assert.deepEqual(await runPublish(deps, { force: true }), { ok: 1, failed: 0, skipped: 0 });
  assert.ok(!wiki.pages.get('Entry A')?.text.endsWith('human'));
});

test('rebuildState restores topic and page records from wiki markers and skips unmarked pages', async () => {
  await publishFirst();
  wiki.pages.set('Legacy', { text: '無標記\n[[Category:NekoWiki 自動整理]]', revid: 5, user: 'YuMeow' });
  await rm(join(dir, 'state', 'state.json'));
  const report = await rebuildState(deps);
  assert.deepEqual(report, { ok: 1, failed: 0, skipped: 1 });
  const state = await store.loadState();
  assert.deepEqual([state.topics['1'], state.topics['2']], ['Entry A', 'Entry A']);
  assert.deepEqual(state.pages['Entry A']?.topicIds, [1, 2]);
  assert.equal(state.pages['Entry A']?.revid, wiki.pages.get('Entry A')?.revid);
});

test('discarding a draft removes it and keeps its topics from being triaged again', async () => {
  llm.groups = [{ title: 'G', topicIds: [1] }];
  await runDraft(deps, draftOptions);
  await discardDraft(deps, 1);
  assert.deepEqual(await store.listDrafts(), []);
  assert.equal((await store.loadState()).topics['1'], null);
  llm.groups = [];
  await runDraft(deps, draftOptions);
  assert.equal(llm.triageCalls, 1); // nothing was left to triage the second time
  assert.equal((await store.loadState()).topics['1'], null);
  assert.deepEqual(await store.listDrafts(), []);
});
