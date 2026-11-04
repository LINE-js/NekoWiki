import { buildInput, compose } from './compose.js';
import type { ChatLogReader } from './db.js';
import type { Llm } from './openai.js';
import { INDEX_TITLE, MAIN_CATEGORY, leadSummary, pageTitle, parseMarker, renderIndex, renderPage, type PageMeta } from './render.js';
import type { PageInfo, State, Store } from './state.js';
import { triage, type ExistingPage, type Group } from './triage.js';
import { WikiError, type WikiApi, type WikiPage } from './wiki.js';

export interface Deps {
  log: Pick<ChatLogReader, 'topics' | 'topic' | 'messages' | 'latestTopicEnd'>;
  llm: Llm;
  /** Reads work without login; publishing and rebuilding need `login()` first. */
  wiki: WikiApi | undefined;
  store: Store;
  chats: readonly string[];
  settleMinutes: number;
  print: (line: string) => void;
}

export interface Report {
  ok: number;
  failed: number;
  skipped: number;
}

export interface DraftOptions {
  chat?: string;
  topic?: number;
  limit: number;
  force: boolean;
  /** False for a dry run: print the result, write nothing. */
  persist: boolean;
}

const KNOWN_PAGES_LIMIT = 300;

const toMs = (local: string): number => Date.parse(`${local.replace(' ', 'T')}Z`);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function existingPages(state: State): ExistingPage[] {
  return Object.entries(state.pages).map(([page, info]) => ({ page, summary: info.summary }));
}

/** Compose, sanitize and (unless dry-run) store one draft for a group of topics. */
async function produce(d: Deps, state: State, group: Group, chatId: string, persist: boolean): Promise<void> {
  const topics = group.topicIds.flatMap((id) => d.log.topic(id) ?? []);
  const messages = d.log.messages(group.topicIds);
  const id = group.topicIds[0] ?? 0;

  let target = group.mergeInto;
  let current: WikiPage | undefined;
  if (target !== undefined && d.wiki) {
    current = await d.wiki.getPage(target);
    if (!current) target = undefined;
  }
  const known = Object.keys(state.pages).filter((title) => title !== target);
  const input = buildInput(group.title, topics, messages, {
    knownPages: known.slice(-KNOWN_PAGES_LIMIT),
    ...(current ? { currentPage: current.text } : {}),
  });
  const entry = await compose(d.llm, input);

  // What the page already covers: its marker, our records, and legacy pages that have neither marker nor page record.
  const marker = current ? parseMarker(current.text) : undefined;
  const info = target === undefined ? undefined : state.pages[target];
  const previousIds = new Set([
    ...(marker?.topicIds ?? []), ...(info?.topicIds ?? []),
    ...Object.entries(state.topics).filter(([, page]) => page === target && target !== undefined).map(([topicId]) => Number(topicId)),
  ]);
  const previous = marker ?? info;
  const covered = group.topicIds.every((topicId) => previousIds.has(topicId));
  const meta: PageMeta = {
    topicIds: [...new Set([...previousIds, ...group.topicIds])].sort((a, b) => a - b),
    startAt: previous && previous.startAt < input.startAt ? previous.startAt : input.startAt,
    endAt: previous && previous.endAt > input.endAt ? previous.endAt : input.endAt,
    messageCount: previous
      ? (covered ? Math.max(previous.messageCount, input.messageCount) : previous.messageCount + input.messageCount)
      : input.messageCount,
    type: entry.type || previous?.type || '',
  };
  const page = target ?? pageTitle(entry.title, `主題 ${id}`);
  const rendered = renderPage(entry, meta, new Set(known), page);
  const flags = target === undefined ? rendered.flags : ['更新既有條目', ...rendered.flags];

  if (!persist) {
    d.print(`===== ${page}（${target === undefined ? '新增' : '更新'}，主題 ${group.topicIds.join(', ')}）=====\n${rendered.text}`);
    if (flags.length > 0) d.print(`審核提示：${flags.join('；')}`);
    return;
  }
  await d.store.saveDraft({
    id, chatId, topicIds: meta.topicIds, mode: target === undefined ? 'create' : 'update', page,
    ...(current ? { baseRevid: current.revid } : {}),
    summary: leadSummary(rendered.text), type: meta.type, startAt: meta.startAt, endAt: meta.endAt,
    messageCount: meta.messageCount, flags, createdAt: new Date().toISOString(),
  }, rendered.text);
  d.print(`草稿 ${id}：${page}（${target === undefined ? '新增' : '更新'}）${flags.length > 0 ? `，審核提示：${flags.join('；')}` : ''}`);
}

/**
 * Stage 1: triage new topics and write drafts (or print them on a dry run). A failing group is reported and skipped;
 * its topics stay in the plan so the next run resumes without another triage request.
 */
export async function runDraft(d: Deps, options: DraftOptions): Promise<Report> {
  const report: Report = { ok: 0, failed: 0, skipped: 0 };
  const state = await d.store.loadState();
  const plan = await d.store.loadPlan();
  const drafted = new Set((await d.store.listDrafts()).flatMap((draft) => draft.topicIds));

  const attempt = async (group: Group, chatId: string): Promise<boolean> => {
    try {
      await produce(d, state, group, chatId, options.persist);
      group.topicIds.forEach((id) => drafted.add(id));
      report.ok += 1;
      return true;
    } catch (error) {
      report.failed += 1;
      d.print(`失敗（主題 ${group.topicIds.join(', ')}）：${message(error)}`);
      return false;
    }
  };

  if (options.topic !== undefined) {
    const topic = d.log.topic(options.topic);
    if (!topic) throw new Error(`找不到主題 ${options.topic}。`);
    const published = state.topics[String(topic.id)];
    if ((published || drafted.has(topic.id)) && !options.force) {
      d.print(`主題 ${topic.id} 已${published ? `發佈為「${published}」` : '有草稿'}，加 --force 重做。`);
      report.skipped += 1;
      return report;
    }
    await attempt({ title: topic.title, topicIds: [topic.id], ...(published ? { mergeInto: published } : {}) }, topic.chatId);
    return report;
  }

  const latest = d.log.latestTopicEnd();
  const cutoff = latest === undefined ? -Infinity : toMs(latest) - d.settleMinutes * 60_000;
  const chats = options.chat === undefined ? d.chats : [options.chat];
  for (const chatId of chats) {
    const done = (id: number): boolean => String(id) in state.topics || drafted.has(id);
    // A saved plan means an earlier run triaged this chat but did not finish: resume without another triage request.
    let groups = (plan[chatId] ?? []).flatMap((group): Group[] => {
      const topicIds = group.topicIds.filter((id) => !done(id));
      return topicIds.length > 0 ? [{ ...group, topicIds }] : [];
    });
    if (groups.length > 0) {
      d.print(`${chatId}：接續上次未完成的 ${groups.length} 組條目`);
    } else {
      const pending = d.log.topics(chatId).filter((topic) => !done(topic.id) && toMs(topic.endAt) <= cutoff).slice(0, options.limit);
      d.print(`${chatId}：${pending.length} 個待處理主題`);
      if (pending.length === 0) continue;
      try {
        groups = await triage(d.llm, pending, existingPages(state));
      } catch (error) {
        report.failed += 1;
        d.print(`篩選失敗：${message(error)}`);
        continue;
      }
      if (options.persist) {
        const kept = new Set(groups.flatMap((group) => group.topicIds));
        for (const topic of pending) if (!kept.has(topic.id)) state.topics[String(topic.id)] = null;
        await d.store.saveState(state);
        plan[chatId] = groups;
        await d.store.savePlan(plan);
      }
    }
    for (const group of groups) {
      if (await attempt(group, chatId) && options.persist) {
        plan[chatId] = (plan[chatId] ?? []).filter((item) => item.topicIds[0] !== group.topicIds[0]);
        await d.store.savePlan(plan);
      }
    }
    if (options.persist && (plan[chatId] ?? []).length === 0) {
      delete plan[chatId];
      await d.store.savePlan(plan);
    }
  }
  return report;
}

/** Stage 2: publish every stored draft. Updates refuse to overwrite a page that changed since the draft was written. */
export async function runPublish(d: Deps, options: { force: boolean }): Promise<Report> {
  const report: Report = { ok: 0, failed: 0, skipped: 0 };
  if (!d.wiki) throw new Error('發佈需要 config.yaml 的 wiki 設定。');
  const drafts = await d.store.listDrafts();
  if (drafts.length === 0) {
    d.print('沒有待發佈的草稿。');
    return report;
  }
  await d.wiki.login();
  const state = await d.store.loadState();
  for (const draft of drafts) {
    try {
      const summary = `NekoWiki 自動整理（主題 ${draft.topicIds.join(', ')}）`;
      let title = draft.page;
      let revid: number;
      if (draft.mode === 'update') {
        const current = await d.wiki.getPage(draft.page);
        if (!current) throw new Error(`目標頁面「${draft.page}」已不存在。`);
        if (current.revid !== draft.baseRevid && !options.force) {
          d.print(`略過草稿 ${draft.id}：「${draft.page}」在草稿產生後被「${current.user}」修改過，請重新產生草稿，或加 --force 覆寫。`);
          report.skipped += 1;
          continue;
        }
        revid = await d.wiki.edit(draft.page, draft.text, summary, { baseRevId: current.revid });
      } else {
        try {
          revid = await d.wiki.edit(title, draft.text, summary, { createOnly: true });
        } catch (error) {
          if (!(error instanceof WikiError) || error.code !== 'articleexists') throw error;
          title = `${title}（${draft.id}）`;
          revid = await d.wiki.edit(title, draft.text, summary, { createOnly: true });
        }
      }
      for (const id of draft.topicIds) state.topics[String(id)] = title;
      state.pages[title] = {
        revid, topicIds: draft.topicIds, summary: leadSummary(draft.text), type: draft.type,
        startAt: draft.startAt, endAt: draft.endAt, messageCount: draft.messageCount,
      };
      await d.store.saveState(state);
      await d.store.deleteDraft(draft.id);
      report.ok += 1;
      d.print(`已發佈：${title}（主題 ${draft.topicIds.join(', ')}）`);
    } catch (error) {
      report.failed += 1;
      d.print(`失敗（草稿 ${draft.id}）：${message(error)}`);
    }
  }
  if (report.ok > 0) {
    try {
      await d.wiki.edit(INDEX_TITLE, renderIndex(state.pages), 'NekoWiki 更新索引');
      d.print(`已更新「${INDEX_TITLE}」`);
    } catch (error) {
      d.print(`索引更新失敗：${message(error)}`);
    }
  }
  return report;
}

/** Rebuild `state.json` from the markers on the wiki's auto-generated pages, e.g. after the state file was lost. */
export async function rebuildState(d: Deps): Promise<Report> {
  const report: Report = { ok: 0, failed: 0, skipped: 0 };
  if (!d.wiki) throw new Error('還原需要 config.yaml 的 wiki 設定。');
  const state = await d.store.loadState();
  const titles = (await d.wiki.categoryMembers(MAIN_CATEGORY)).filter((title) => title !== INDEX_TITLE);
  const present = new Set(titles);
  const pages: Record<string, PageInfo> = {};
  for (const title of titles) {
    const page = await d.wiki.getPage(title);
    const meta = page ? parseMarker(page.text) : undefined;
    if (!page || !meta) {
      d.print(`略過「${title}」：沒有來源標記，無法還原其主題對應。`);
      report.skipped += 1;
      continue;
    }
    pages[title] = {
      revid: page.revid, topicIds: meta.topicIds, summary: leadSummary(page.text), type: meta.type,
      startAt: meta.startAt, endAt: meta.endAt, messageCount: meta.messageCount,
    };
    for (const id of meta.topicIds) state.topics[String(id)] = title;
    report.ok += 1;
  }
  // Topics recorded against pages that no longer exist are processed again.
  for (const [id, title] of Object.entries(state.topics)) if (title !== null && !present.has(title)) delete state.topics[id];
  state.pages = pages;
  await d.store.saveState(state);
  d.print(`已還原 ${report.ok} 個頁面的記錄。`);
  return report;
}

/** Drop a draft and mark its topics as not worth an entry, so they are not triaged again. */
export async function discardDraft(d: Deps, id: number): Promise<void> {
  const draft = (await d.store.listDrafts()).find((item) => item.id === id);
  if (!draft) throw new Error(`找不到草稿 ${id}。`);
  const state = await d.store.loadState();
  for (const topicId of draft.topicIds) {
    if (state.topics[String(topicId)] === undefined) state.topics[String(topicId)] = null;
  }
  await d.store.saveState(state);
  await d.store.deleteDraft(id);
  d.print(`已捨棄草稿 ${id}。`);
}
