import { NAVIGATION_PREFIX, normalizeNavigationGroups, renderNavigation } from './render.js';
import type { State } from './state.js';
import type { WikiApi } from './wiki.js';

export const NAVIGATION_MARKER = '<!-- NekoWiki navigation template -->';

/** Keep removed groups until their empty templates have been successfully written. */
export function trackNavigation(state: State): void {
  const groups = [...new Set([
    ...(state.navigationGroups ?? []),
    ...Object.values(state.pages).flatMap((page) => page.navigationGroups ?? []),
  ].flatMap((group) => normalizeNavigationGroups([group])))];
  if (groups.length > 0) state.navigationGroups = groups;
  else delete state.navigationGroups;
}

/** Uses published state only; callers persist the remaining cleanup queue even after failures. */
export async function reconcileNavigation(wiki: WikiApi, state: State, print: (line: string) => void): Promise<number> {
  trackNavigation(state);
  const pending: string[] = [];
  let failed = 0;
  for (const group of state.navigationGroups ?? []) {
    const titles = Object.entries(state.pages)
      .filter(([, page]) => page.navigationGroups?.includes(group))
      .map(([title]) => title);
    const title = `${NAVIGATION_PREFIX}${group}`;
    try {
      const current = await wiki.getPage(title);
      if (current && !current.text.startsWith(`${NAVIGATION_MARKER}\n`)) {
        throw new Error(`「${title}」沒有 NekoWiki 導覽擁有權標記，拒絕覆寫。`);
      }
      const text = `${NAVIGATION_MARKER}\n${renderNavigation(group, titles)}`;
      if (current?.text !== text) {
        await wiki.edit(title, text, 'NekoWiki 更新共用導覽', current ? { baseRevId: current.revid } : { createOnly: true });
        print(`已更新「${title}」`);
      }
      if (titles.length > 0) pending.push(group);
    } catch (error) {
      pending.push(group);
      failed += 1;
      print(`導覽更新失敗（${title}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (pending.length > 0) state.navigationGroups = pending;
  else delete state.navigationGroups;
  return failed;
}
