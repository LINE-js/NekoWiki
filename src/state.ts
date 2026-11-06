import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './guards.js';
import { normalizeNavigationGroups } from './render.js';
import type { Group } from './triage.js';

export interface PageInfo {
  revid: number;
  topicIds: number[];
  summary: string;
  type: string;
  startAt: string;
  endAt: string;
  messageCount: number;
  navigationGroups?: string[];
}

export interface State {
  /** topic id → page it was published to, or null when triage judged it not worth an entry. */
  topics: Record<string, string | null>;
  /** page title → provenance of every published entry. */
  pages: Record<string, PageInfo>;
  /** Groups whose shared templates still need reconciliation, including removed memberships. */
  navigationGroups?: string[];
}

/** chat ID → groups triaged but not yet drafted. */
export type Plan = Record<string, Group[]>;

export interface DraftMeta {
  /** First topic ID; also the file stem. */
  id: number;
  chatId: string;
  topicIds: number[];
  mode: 'create' | 'update';
  /** Target page title. */
  page: string;
  /** Revision the update was written against; unset for new pages. */
  baseRevid?: number;
  summary: string;
  type: string;
  startAt: string;
  endAt: string;
  messageCount: number;
  navigationGroups?: string[];
  /** Reviewer notes from sanitizing and model self-assessment. */
  flags: string[];
  createdAt: string;
}

export interface Draft extends DraftMeta {
  /** Wikitext, read from the `.wiki` file so it can be edited before publishing. */
  text: string;
}

const isNumberArray = (value: unknown): value is number[] => Array.isArray(value) && value.every((item) => Number.isSafeInteger(item));
const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, content);
  await rename(temp, path);
}

function parsePage(value: unknown): PageInfo | undefined {
  if (!isRecord(value) || typeof value.revid !== 'number' || !isNumberArray(value.topicIds) || typeof value.summary !== 'string'
    || typeof value.type !== 'string' || typeof value.startAt !== 'string' || typeof value.endAt !== 'string'
    || typeof value.messageCount !== 'number') return undefined;
  return {
    revid: value.revid, topicIds: value.topicIds, summary: value.summary, type: value.type,
    startAt: value.startAt, endAt: value.endAt, messageCount: value.messageCount,
    ...(Array.isArray(value.navigationGroups) ? { navigationGroups: normalizeNavigationGroups(value.navigationGroups) } : {}),
  };
}

function parseTopics(value: unknown): Record<string, string | null> {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter(
    (entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === 'string')) : {};
}

/** Files under the state directory: `state.json`, `plan.json` and `drafts/<id>.{json,wiki}`. */
export class Store {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(join(this.#dir, 'drafts'), { recursive: true });
  }

  async loadState(): Promise<State> {
    const raw = await readJson(join(this.#dir, 'state.json'));
    if (!isRecord(raw)) return { topics: {}, pages: {} };
    // Earlier versions stored the topic map directly.
    if (!('topics' in raw) && !('pages' in raw)) return { topics: parseTopics(raw), pages: {} };
    const pages: Record<string, PageInfo> = {};
    if (isRecord(raw.pages)) {
      for (const [title, value] of Object.entries(raw.pages)) {
        const page = parsePage(value);
        if (page) pages[title] = page;
      }
    }
    const navigationGroups = Array.isArray(raw.navigationGroups)
      ? [...new Set(raw.navigationGroups.flatMap((group: unknown) => normalizeNavigationGroups([group])))] : [];
    return { topics: parseTopics(raw.topics), pages, ...(navigationGroups.length > 0 ? { navigationGroups } : {}) };
  }

  saveState(state: State): Promise<void> {
    return writeAtomic(join(this.#dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  }

  async loadPlan(): Promise<Plan> {
    const raw = await readJson(join(this.#dir, 'plan.json'));
    if (!isRecord(raw)) return {};
    return Object.fromEntries(Object.entries(raw).map(([chatId, groups]) => [chatId, Array.isArray(groups)
      ? groups.flatMap((group: unknown): Group[] => isRecord(group) && typeof group.title === 'string' && isNumberArray(group.topicIds)
        ? [{ title: group.title, topicIds: group.topicIds, ...(typeof group.mergeInto === 'string' ? { mergeInto: group.mergeInto } : {}) }]
        : [])
      : []]));
  }

  savePlan(plan: Plan): Promise<void> {
    return writeAtomic(join(this.#dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  }

  async saveDraft(meta: DraftMeta, text: string): Promise<void> {
    const stem = join(this.#dir, 'drafts', String(meta.id));
    await writeFile(`${stem}.wiki`, text);
    await writeAtomic(`${stem}.json`, `${JSON.stringify(meta, null, 2)}\n`);
  }

  async listDrafts(): Promise<Draft[]> {
    let names: string[];
    try {
      names = await readdir(join(this.#dir, 'drafts'));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const drafts: Draft[] = [];
    for (const name of names.filter((item) => item.endsWith('.json')).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))) {
      const raw = await readJson(join(this.#dir, 'drafts', name));
      if (!isRecord(raw) || typeof raw.id !== 'number' || typeof raw.chatId !== 'string' || !isNumberArray(raw.topicIds)
        || (raw.mode !== 'create' && raw.mode !== 'update') || typeof raw.page !== 'string' || typeof raw.summary !== 'string'
        || typeof raw.type !== 'string' || typeof raw.startAt !== 'string' || typeof raw.endAt !== 'string'
        || typeof raw.messageCount !== 'number' || !Array.isArray(raw.flags) || typeof raw.createdAt !== 'string') continue;
      const text = await readFile(join(this.#dir, 'drafts', `${raw.id}.wiki`), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      drafts.push({
        id: raw.id, chatId: raw.chatId, topicIds: raw.topicIds, mode: raw.mode, page: raw.page,
        ...(typeof raw.baseRevid === 'number' ? { baseRevid: raw.baseRevid } : {}),
        summary: raw.summary, type: raw.type, startAt: raw.startAt, endAt: raw.endAt, messageCount: raw.messageCount,
        ...(Array.isArray(raw.navigationGroups) ? { navigationGroups: normalizeNavigationGroups(raw.navigationGroups) } : {}),
        flags: raw.flags.filter((flag): flag is string => typeof flag === 'string'), createdAt: raw.createdAt, text,
      });
    }
    return drafts;
  }

  async deleteDraft(id: number): Promise<void> {
    const stem = join(this.#dir, 'drafts', String(id));
    await rm(`${stem}.json`, { force: true });
    await rm(`${stem}.wiki`, { force: true });
  }
}
