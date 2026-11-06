import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { applyBackfill, parseBackfillPlan, prepareBackfill, type BackfillDeps, type BackfillPlan } from '../src/backfill.js';
import type { Llm, ToolSpec } from '../src/openai.js';
import { INDEX_TITLE, MAIN_CATEGORY, NAVIGATION_PREFIX, navigationGroupsFromText, parseMarker } from '../src/render.js';
import { NAVIGATION_MARKER } from '../src/navigation.js';
import { Store, type State } from '../src/state.js';
import { WikiError, type EditOptions, type WikiApi, type WikiPage } from '../src/wiki.js';

const URL = 'https://wiki.example/api.php';
const original = (id = 1): string => `原文  \r\n== 標題 ==\n* [[其他|連結]] 與 <code>x</code>\n\n[[Category:${MAIN_CATEGORY}]]\n<!-- nekowiki ${JSON.stringify({ topics: [id], start: '2026-10-01 00:00:00', end: '2026-10-01 01:00:00', messages: 10, type: '工具' })} -->`;

class FakeWiki implements WikiApi {
  pages = new Map<string, WikiPage>();
  edits: { title: string; text: string; options: EditOptions }[] = [];
  failures = new Set<string>();
  logins = 0;
  revision = 100;
  categoryCalls = 0;
  failCategoryCall = Infinity;
  login(): Promise<void> { this.logins += 1; return Promise.resolve(); }
  getPage(title: string): Promise<WikiPage | undefined> { return Promise.resolve(this.pages.get(title)); }
  categoryMembers(): Promise<string[]> {
    this.categoryCalls += 1;
    if (this.categoryCalls === this.failCategoryCall) return Promise.reject(new Error('category unavailable'));
    return Promise.resolve([...this.pages.values()].filter((page) => page.text.includes(`[[Category:${MAIN_CATEGORY}]]`)).map((page) => page.title));
  }
  edit(title: string, text: string, _summary: string, options: EditOptions = {}): Promise<number> {
    this.edits.push({ title, text, options });
    if (this.failures.has(title)) return Promise.reject(new Error('unavailable'));
    const current = this.pages.get(title);
    if ((options.createOnly && current) || (options.baseRevId !== undefined && options.baseRevId !== current?.revid)) return Promise.reject(new WikiError('editconflict'));
    this.revision += 1;
    this.pages.set(title, { title, text, revid: this.revision, user: 'bot' });
    return Promise.resolve(this.revision);
  }
  add(title: string, text = original()): void { this.pages.set(title, { title, text, revid: ++this.revision, user: 'author' }); }
}

class FakeLlm implements Llm {
  inputs: { title: string; text: string; knownNavigationGroups: string[]; truncated: boolean }[] = [];
  results: unknown[] = [{ navigationGroups: ['Tailscale'] }];
  callTool(_system: string, tool: ToolSpec, content: string): Promise<unknown> {
    assert.equal(tool.name, 'suggest_navigation_groups');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.ok(content.length <= 20_000);
    this.inputs.push(JSON.parse(content) as typeof this.inputs[number]);
    return Promise.resolve(this.results.shift() ?? { navigationGroups: ['Tailscale'] });
  }
}

let dir: string;
let wiki: FakeWiki;
let llm: FakeLlm;
let store: Store;
let deps: BackfillDeps;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nekowiki-backfill-'));
  wiki = new FakeWiki();
  llm = new FakeLlm();
  store = new Store(dir);
  await store.init();
  deps = { wiki, llm, store, print: () => {} };
});
afterEach(async () => { await rm(dir, { recursive: true }); });

function planFor(title: string, navigationGroups = ['Tailscale']): BackfillPlan {
  const page = wiki.pages.get(title);
  assert.ok(page);
  return { version: 1, wikiUrl: URL, createdAt: new Date().toISOString(), pages: [{ title, baseRevid: page.revid, originalText: page.text, navigationGroups }] };
}

test('prepare excludes unmarked/index/already navigated articles, reads all groups before limit, and writes nothing', async () => {
  wiki.add('A');
  wiki.add('B', `${original(2)}\n{{NekoWiki導覽/Claude Code}}`);
  wiki.add('Manual', `人工頁面\n[[Category:${MAIN_CATEGORY}]]\n{{NekoWiki導覽/Manual Group}}`);
  wiki.add(INDEX_TITLE);
  const before = await store.loadState();
  const { plan, report } = await prepareBackfill(deps, URL, 1);
  assert.deepEqual(report, { ok: 1, failed: 0, skipped: 2 });
  assert.deepEqual(plan.pages.map((page) => page.title), ['A']);
  assert.ok(llm.inputs[0]?.knownNavigationGroups.includes('Claude Code'));
  assert.ok(llm.inputs[0]?.knownNavigationGroups.includes('Manual Group'));
  assert.equal(wiki.logins, 0);
  assert.deepEqual(wiki.edits, []);
  assert.deepEqual(await store.loadState(), before);
});

test('prepare reuses pending state, draft metadata and prior suggestions and announces bounded input', async () => {
  await store.saveState({ topics: { 99: null }, pages: {}, navigationGroups: ['Pending Group'] });
  await store.saveDraft({ id: 9, chatId: 'chat', topicIds: [9], mode: 'create', page: 'Draft', summary: '', type: '', startAt: '', endAt: '', messageCount: 1, flags: [], createdAt: '', navigationGroups: ['Draft Group'] }, '{{NekoWiki導覽/Draft Text}}');
  wiki.add('A', `${'long article '.repeat(4000)}${original()}`);
  wiki.add('B', original(2));
  llm.results = [{ navigationGroups: ['New Subject'] }, { navigationGroups: ['New Subject'] }];
  const { plan } = await prepareBackfill(deps, URL, Infinity);
  assert.equal(plan.pages.length, 2);
  assert.equal(llm.inputs[0]?.truncated, true);
  for (const group of ['Pending Group', 'Draft Group', 'Draft Text']) assert.ok(llm.inputs[0]?.knownNavigationGroups.includes(group));
  assert.ok(llm.inputs[1]?.knownNavigationGroups.includes('New Subject'));
  assert.deepEqual((await store.loadState()).topics, { 99: null });
});

test('apply preserves every original byte and marker, uses base revision, and never invokes the model', async () => {
  wiki.add('A');
  const plan = planFor('A');
  deps.llm = { callTool: () => { throw new Error('apply called LLM'); } };
  const page = plan.pages[0];
  assert.ok(page);
  assert.deepEqual(await applyBackfill(deps, plan, URL), { ok: 1, failed: 0, skipped: 0 });
  const text = wiki.pages.get('A')?.text;
  assert.equal(text, `${page.originalText}\n\n{{NekoWiki導覽/Tailscale}}\n`);
  assert.deepEqual(parseMarker(text ?? ''), parseMarker(page.originalText));
  assert.deepEqual(wiki.edits.find((edit) => edit.title === 'A')?.options, { baseRevId: page.baseRevid });
});

test('conflicts, removed category membership and lost markers are skipped without overwriting articles', async () => {
  for (const title of ['Conflict', 'Removed', 'Unmarked']) wiki.add(title);
  const plan = planFor('Conflict');
  plan.pages.push(...planFor('Removed').pages, ...planFor('Unmarked').pages);
  wiki.add('Conflict', `${original()} human edit`);
  wiki.add('Removed', original().replace(`[[Category:${MAIN_CATEGORY}]]`, ''));
  wiki.add('Unmarked', `manual\n[[Category:${MAIN_CATEGORY}]]`);
  assert.deepEqual(await applyBackfill(deps, plan, URL), { ok: 0, failed: 0, skipped: 3 });
  assert.equal(wiki.edits.length, 0);
});

test('partial article and template failures retry with published membership only and no duplicate invocations', async () => {
  wiki.add('A');
  wiki.add('B', original(2));
  const plan = planFor('A');
  plan.pages.push(...planFor('B').pages);
  wiki.failures.add('B');
  wiki.failures.add(`${NAVIGATION_PREFIX}Tailscale`);
  assert.deepEqual(await applyBackfill(deps, plan, URL), { ok: 1, failed: 2, skipped: 0 });
  const firstState = await store.loadState();
  assert.deepEqual(firstState.pages.A?.navigationGroups, ['Tailscale']);
  assert.deepEqual(firstState.pages.B?.navigationGroups, []);
  assert.ok(!wiki.edits.find((edit) => edit.title.startsWith(NAVIGATION_PREFIX))?.text.includes('[[B]]'));
  wiki.failures.clear();
  assert.deepEqual(await applyBackfill(deps, plan, URL), { ok: 2, failed: 0, skipped: 0 });
  assert.equal(wiki.edits.filter((edit) => edit.title === 'A').length, 1);
  assert.deepEqual(navigationGroupsFromText(wiki.pages.get('A')?.text ?? ''), ['Tailscale']);
  assert.equal((wiki.pages.get('A')?.text.match(/\{\{NekoWiki導覽\/Tailscale\}\}/g) ?? []).length, 1);
  assert.ok(wiki.pages.get(`${NAVIGATION_PREFIX}Tailscale`)?.text.includes('[[B]]'));
});

test('refresh includes wiki members absent from local state, preserves rejected topics and cleans removed groups', async () => {
  wiki.add('A');
  wiki.add('Unknown', `${original(2)}\n{{NekoWiki導覽/Tailscale}}`);
  await store.saveState({ topics: { 2: null, 90: null }, pages: {}, navigationGroups: ['Old Group'] });
  await applyBackfill(deps, planFor('A'), URL);
  const template = wiki.pages.get(`${NAVIGATION_PREFIX}Tailscale`)?.text;
  assert.ok(template?.includes('[[A]]'));
  assert.ok(template?.includes('[[Unknown]]'));
  assert.ok(wiki.pages.get(`${NAVIGATION_PREFIX}Old Group`)?.text.startsWith(NAVIGATION_MARKER));
  const state = await store.loadState();
  assert.equal(state.topics['2'], null);
  assert.equal(state.topics['90'], null);
  assert.deepEqual(state.navigationGroups, ['Tailscale']);
});

test('both revision-only changes and text-only mismatches refuse the approved edit', async () => {
  wiki.add('Revision');
  wiki.add('Text');
  const plan = planFor('Revision');
  plan.pages.push(...planFor('Text').pages);
  const revision = wiki.pages.get('Revision');
  const text = wiki.pages.get('Text');
  assert.ok(revision && text);
  wiki.pages.set('Revision', { ...revision, revid: revision.revid + 100 });
  wiki.pages.set('Text', { ...text, text: `${text.text} changed` });
  assert.deepEqual(await applyBackfill(deps, plan, URL), { ok: 0, failed: 0, skipped: 2 });
  assert.equal(wiki.edits.length, 0);
});

test('empty groups skip rather than recover an unchanged original as a successful edit', async () => {
  wiki.add('A');
  assert.deepEqual(await applyBackfill(deps, planFor('A', []), URL), { ok: 0, failed: 0, skipped: 1 });
  assert.equal(wiki.edits.length, 0);
});

test('wrong targets and malformed plans reject before login or any state/wiki writes', async () => {
  wiki.add('A');
  const valid = planFor('A');
  const page = valid.pages[0];
  assert.ok(page);
  let saves = 0;
  store.saveState = () => { saves += 1; return Promise.resolve(); };
  await assert.rejects(applyBackfill(deps, valid, 'https://other.example/api.php'));
  for (const patch of [
    { baseRevid: 0 }, { baseRevid: 1.5 }, { originalText: 'no marker' },
    { navigationGroups: ['A', 'B', 'C', 'D'] }, { navigationGroups: ['Tailscale', 'Tailscale'] },
    { navigationGroups: ['{{unsafe}}'] }, { navigationGroups: ['not_canonical'] },
    { originalText: `${original()}\n{{NekoWiki導覽/Existing}}` },
  ]) {
    const malformed = { ...valid, pages: [{ ...page, ...patch }] };
    assert.throws(() => parseBackfillPlan(malformed));
    await assert.rejects(applyBackfill(deps, malformed, URL));
  }
  assert.throws(() => parseBackfillPlan({ ...valid, pages: [page, page] }));
  assert.equal(saves, 0);
  assert.equal(wiki.logins, 0);
  assert.equal(wiki.edits.length, 0);
});

test('state persistence failure aborts immediately and exact-text recovery resumes without re-editing', async () => {
  wiki.add('A');
  wiki.add('B', original(2));
  const plan = planFor('A');
  plan.pages.push(...planFor('B').pages);
  const save = store.saveState.bind(store);
  let calls = 0;
  store.saveState = (state: State) => {
    calls += 1;
    if (calls === 2) return Promise.reject(new Error('disk full'));
    return save(state);
  };
  await assert.rejects(applyBackfill(deps, plan, URL), /disk full/);
  assert.deepEqual(wiki.edits.map((edit) => edit.title), ['A']);
  store.saveState = save;
  assert.deepEqual(await applyBackfill(deps, plan, URL), { ok: 2, failed: 0, skipped: 0 });
  assert.equal(wiki.edits.filter((edit) => edit.title === 'A').length, 1);
});

test('initial state failure prevents wiki mutations and failed authoritative refresh prevents template reconciliation', async () => {
  wiki.add('A');
  const plan = planFor('A');
  const save = store.saveState.bind(store);
  store.saveState = () => Promise.reject(new Error('read-only state'));
  await assert.rejects(applyBackfill(deps, plan, URL), /read-only state/);
  assert.equal(wiki.logins, 0);
  assert.equal(wiki.edits.length, 0);
  store.saveState = save;
  wiki.failCategoryCall = 2;
  await assert.rejects(applyBackfill(deps, plan, URL), /category unavailable/);
  assert.deepEqual(wiki.edits.map((edit) => edit.title), ['A']);
});

test('backfill includes long collision titles and moved article paths in shared navigation', async () => {
  const collision = `${'A'.repeat(120)}（225）`;
  const moved = 'Tailscale/ACL';
  wiki.add(collision);
  wiki.add(moved, original(2));
  const { plan } = await prepareBackfill(deps, URL, Infinity);
  assert.deepEqual(await applyBackfill(deps, plan, URL), { ok: 2, failed: 0, skipped: 0 });
  const template = wiki.pages.get(`${NAVIGATION_PREFIX}Tailscale`)?.text;
  assert.ok(template?.includes(`[[${collision}]]`));
  assert.ok(template?.includes(`[[${moved}]]`));
});
