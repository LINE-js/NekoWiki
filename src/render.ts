import type { Entry } from './compose.js';
import { isRecord } from './guards.js';
import { plainText, sanitizeWikitext } from './sanitize.js';

/** Everything that identifies a page's provenance; stored in a hidden marker so state can be rebuilt from the wiki. */
export interface PageMeta {
  topicIds: number[];
  startAt: string;
  endAt: string;
  messageCount: number;
  /** Category-like type of the entry, e.g. `事件 / 資安`. */
  type: string;
  navigationGroups?: string[];
}

export const MAIN_CATEGORY = 'NekoWiki 自動整理';
export const INDEX_TITLE = '條目索引';
export const NAVIGATION_PREFIX = 'Template:NekoWiki導覽/';

/** `2026-10-26 06:53 ~ 07:22`, repeating the date only when the entry spans days. */
export function timeRange(startAt: string, endAt: string): string {
  const start = startAt.slice(0, 16);
  const end = endAt.slice(0, 16);
  return start.slice(0, 10) === end.slice(0, 10) ? `${start} ~ ${end.slice(11)}` : `${start} ~ ${end}`;
}

/** Characters MediaWiki forbids in page titles, plus `/` and `:` which would create subpages or namespaces. */
const TITLE_FORBIDDEN = /[#<>[\]|{}/:\u0000-\u001f]/g;

export function pageTitle(title: string, fallback: string): string {
  const clean = title.replace(TITLE_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean === '' ? fallback : clean;
}

/** Canonical subjects, never repaired from markup or private/contact information into a different subject. */
export function normalizeNavigationGroups(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const groups = new Set<string>();
  for (const value of input) {
    if (typeof value !== 'string' || /[#<>[\]|{}/:=@\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value)) continue;
    const name = value.normalize('NFC').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (name === '' || name.length > 120) continue;
    const clean = sanitizeWikitext(value, new Set());
    if (clean.flags.length > 0 || clean.text !== value.trim()) continue;
    groups.add(name);
    if (groups.size === 3) break;
  }
  return [...groups];
}

/** Read reviewed invocations, not marker metadata or template-like prose in comments/nowiki blocks. */
export function navigationGroupsFromText(text: string): string[] {
  const visible = text.replace(/<!--[\s\S]*?(?:-->|$)|<nowiki\b(?![^>]*\/\s*>)[^>]*>[\s\S]*?(?:<\/nowiki\s*>|$)/gi, '');
  const groups: string[] = [];
  for (const match of visible.matchAll(/(?<!\{)\{\{NekoWiki導覽\/([^{}\r\n]+)\}\}(?!\})/g)) {
    const name = match[1];
    if (name !== undefined && normalizeNavigationGroups([name])[0] === name) groups.push(name);
  }
  return normalizeNavigationGroups(groups);
}

/** Standalone vanilla MediaWiki table: no site-local modules, stylesheets or helper templates. */
export function renderNavigation(group: string, titles: readonly string[]): string {
  const name = normalizeNavigationGroups([group])[0];
  if (name === undefined) return '';
  const safeTitles = [...new Set(titles)].filter((title) => {
    // Published titles may have collision suffixes or moved subpage paths; do not apply the creation-time length cap.
    if (title.trim() === '' || /[#<>[\]|{}:\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(title)) return false;
    const clean = sanitizeWikitext(title, new Set());
    return clean.flags.length === 0 && clean.text === title;
  }).sort((a, b) => a.localeCompare(b, 'zh-Hant') || (a < b ? -1 : a > b ? 1 : 0));
  return [
    '{| class="wikitable" style="width:100%;"',
    `! ${name}相關條目`,
    '|-',
    `| ${safeTitles.map((title) => `[[${title}]]`).join(' · ')}`,
    '|}',
    '',
  ].join('\n');
}

/** Category names derived from the entry's type and tags. */
function categories(entry: Entry): string[] {
  const names = [...entry.type.split('/'), ...entry.tags, MAIN_CATEGORY]
    .map((name) => pageTitle(name, ''))
    .filter((name) => name !== '');
  return [...new Set(names)];
}

const MARKER = /<!-- nekowiki (\{.*?\}) -->/;

function marker(meta: PageMeta): string {
  const json = JSON.stringify({
    topics: meta.topicIds, start: meta.startAt, end: meta.endAt, messages: meta.messageCount, type: meta.type,
    ...(meta.navigationGroups === undefined ? {} : { navigationGroups: normalizeNavigationGroups(meta.navigationGroups) }),
  }).replaceAll('--', '\\u002d\\u002d');
  return `<!-- nekowiki ${json} -->`;
}

export function parseMarker(text: string): PageMeta | undefined {
  const match = MARKER.exec(text);
  if (!match?.[1]) return undefined;
  try {
    const raw: unknown = JSON.parse(match[1]);
    if (isRecord(raw) && Array.isArray(raw.topics) && raw.topics.every((id) => Number.isSafeInteger(id))
      && typeof raw.start === 'string' && typeof raw.end === 'string'
      && typeof raw.messages === 'number' && typeof raw.type === 'string') {
      return {
        topicIds: raw.topics as number[], startAt: raw.start, endAt: raw.end, messageCount: raw.messages, type: raw.type,
        ...(raw.navigationGroups === undefined ? {} : { navigationGroups: normalizeNavigationGroups(raw.navigationGroups) }),
      };
    }
  } catch {
    // Fall through: a damaged marker is the same as no marker.
  }
  return undefined;
}

/** First paragraph of a page as plain text, for listings. */
export function leadSummary(text: string): string {
  const body = text.replace(MARKER, '').trim();
  const lead = body.split(/\n\s*\n|\n==/)[0] ?? '';
  return lead.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'{2,}/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export interface Rendered {
  text: string;
  flags: string[];
}

/**
 * Wikitext of one entry. Every model-written field is sanitized; links are limited to `known` pages. Chat and topic IDs
 * stay out of the visible page (the wiki is publicly readable) and live only in the hidden marker.
 */
export function renderPage(entry: Entry, meta: PageMeta, known: ReadonlySet<string>, self: string): Rendered {
  const flags = new Set<string>();
  const clean = (input: string): string => {
    const result = sanitizeWikitext(input, new Set([...known, self]));
    result.flags.forEach((flag) => flags.add(flag));
    return result.text;
  };
  const confidence = clean(entry.confidenceNote ? `${entry.confidence}（${entry.confidenceNote}）` : entry.confidence);
  if (entry.confidence === '低') flags.add('模型自評可信度低');
  const navigationGroups = normalizeNavigationGroups(entry.navigationGroups ?? meta.navigationGroups);

  const lines = [clean(entry.summary)];
  for (const section of entry.sections) {
    const heading = plainText(section.heading);
    if (heading !== '') lines.push('', `== ${heading} ==`, clean(section.body));
  }
  if (entry.todo.length > 0) lines.push('', '== 待查證 ==', ...entry.todo.map((item) => `* ${clean(item)}`));
  const related = [...new Set(entry.related)].filter((name) => known.has(name) && name !== self);
  if (related.length > 0) lines.push('', '== 相關條目 ==', ...related.map((name) => `* [[${name}]]`));
  lines.push(
    '',
    '== 資料來源 ==',
    `* 討論時間：${timeRange(meta.startAt, meta.endAt)}`,
    `* 訊息數：${meta.messageCount}`,
    `* 可信度：${confidence}`,
    '* 來源：聊天室討論，由 AI 自動整理，未經獨立核實。',
    '',
    ...navigationGroups.map((group) => `{{NekoWiki導覽/${group}}}`),
    ...(navigationGroups.length === 0 ? [] : ['']),
    ...categories(entry).map((name) => `[[Category:${name}]]`),
    marker({
      ...meta,
      ...(entry.navigationGroups === undefined && meta.navigationGroups === undefined ? {} : { navigationGroups }),
    }),
  );
  return { text: `${lines.join('\n')}\n`, flags: [...flags] };
}

export interface IndexEntry {
  summary: string;
  type: string;
}

/** Generated list of every published entry, grouped by the first segment of its type. */
export function renderIndex(pages: Readonly<Record<string, IndexEntry>>): string {
  const groups = new Map<string, string[]>();
  for (const [title, info] of Object.entries(pages).sort(([a], [b]) => a.localeCompare(b, 'zh-Hant'))) {
    const group = pageTitle(info.type.split('/')[0] ?? '', '') || '其他';
    const line = `* [[${title}]]${info.summary ? `：${plainText(info.summary)}` : ''}`;
    groups.set(group, [...(groups.get(group) ?? []), line]);
  }
  const lines = ['本頁由 NekoWiki 自動產生，列出所有自動整理的條目，請勿手動編輯。'];
  for (const [group, items] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'zh-Hant'))) lines.push('', `== ${group} ==`, ...items);
  return `${lines.join('\n')}\n`;
}
