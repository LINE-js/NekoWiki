import type { WikiConfig } from './config.js';
import { isRecord } from './guards.js';
import { isRetryableCode, retry } from './retry.js';

export class WikiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, detail = '') {
    super(`MediaWiki request failed: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'WikiError';
    this.code = code;
    this.retryable = isRetryableCode(code);
  }
}

export interface WikiPage {
  title: string;
  text: string;
  revid: number;
  /** Author of the latest revision. */
  user: string;
}

export interface EditOptions {
  /** Fail with `articleexists` instead of replacing an existing page. */
  createOnly?: boolean;
  /** Revision the new text was written against; the server rejects the edit if the page moved on. */
  baseRevId?: number;
}

/** What the pipeline needs from the wiki. */
export interface WikiApi {
  login(): Promise<void>;
  /** Undefined when the page does not exist. */
  getPage(title: string): Promise<WikiPage | undefined>;
  /** Titles of the main-namespace pages in a category. */
  categoryMembers(category: string): Promise<string[]>;
  /** Returns the resulting revision ID. */
  edit(title: string, text: string, summary: string, options?: EditOptions): Promise<number>;
}

export type WikiFetch = (url: string, init: {
  method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; headers: { getSetCookie(): string[] }; json(): Promise<unknown> }>;

const TIMEOUT_MS = 30_000;

/** Minimal MediaWiki Action API client: bot-password login, reads and page edits. */
export class WikiClient implements WikiApi {
  readonly #config: WikiConfig;
  readonly #fetch: WikiFetch;
  readonly #sleep: ((ms: number) => Promise<void>) | undefined;
  readonly #cookies = new Map<string, string>();
  #csrf: string | undefined;

  constructor(config: WikiConfig, fetchImpl: WikiFetch = fetch, sleep?: (ms: number) => Promise<void>) {
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
  }

  #request(method: 'GET' | 'POST', params: Record<string, string>): Promise<Record<string, unknown>> {
    return retry(() => this.#once(method, params), this.#sleep);
  }

  async #once(method: 'GET' | 'POST', params: Record<string, string>): Promise<Record<string, unknown>> {
    const all = new URLSearchParams({ ...params, format: 'json', formatversion: '2' });
    const url = `${this.#config.url}api.php`;
    const headers: Record<string, string> = {
      'user-agent': 'NekoWiki/1.0',
      cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    };
    if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
    let body: unknown;
    try {
      const response = await this.#fetch(method === 'GET' ? `${url}?${all}` : url, {
        method, headers, ...(method === 'POST' ? { body: all.toString() } : {}), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0] ?? '';
        const eq = pair.indexOf('=');
        if (eq > 0) this.#cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      if (!response.ok) throw new WikiError(`HTTP_${response.status}`);
      body = await response.json();
    } catch (error) {
      if (error instanceof WikiError) throw error;
      throw new WikiError('REQUEST_FAILED');
    }
    if (!isRecord(body)) throw new WikiError('INVALID_RESPONSE');
    if (isRecord(body.error)) throw new WikiError(String(body.error.code ?? 'ERROR'), String(body.error.info ?? ''));
    return body;
  }

  async #token(type: 'login' | 'csrf'): Promise<string> {
    const body = await this.#request('GET', { action: 'query', meta: 'tokens', type });
    const tokens = isRecord(body.query) && isRecord(body.query.tokens) ? body.query.tokens : undefined;
    const token = tokens?.[`${type}token`];
    if (typeof token !== 'string') throw new WikiError('INVALID_RESPONSE', 'token');
    return token;
  }

  async login(): Promise<void> {
    const body = await this.#request('POST', {
      action: 'login', lgname: this.#config.username, lgpassword: this.#config.password,
      lgtoken: await this.#token('login'),
    });
    const result = isRecord(body.login) ? body.login.result : undefined;
    if (result !== 'Success') throw new WikiError('LOGIN_FAILED', String(result));
    this.#csrf = await this.#token('csrf');
  }

  async getPage(title: string): Promise<WikiPage | undefined> {
    const body = await this.#request('GET', {
      action: 'query', prop: 'revisions', titles: title, rvprop: 'ids|user|content', rvslots: 'main',
    });
    const page = isRecord(body.query) && Array.isArray(body.query.pages) ? body.query.pages[0] : undefined;
    if (!isRecord(page) || page.missing === true) return undefined;
    const revision = Array.isArray(page.revisions) ? page.revisions[0] : undefined;
    const main = isRecord(revision) && isRecord(revision.slots) ? revision.slots.main : undefined;
    if (!isRecord(revision) || !isRecord(main) || typeof main.content !== 'string'
      || typeof revision.revid !== 'number' || typeof revision.user !== 'string') {
      throw new WikiError('INVALID_RESPONSE', 'revision');
    }
    return { title: typeof page.title === 'string' ? page.title : title, text: main.content, revid: revision.revid, user: revision.user };
  }

  async categoryMembers(category: string): Promise<string[]> {
    const titles: string[] = [];
    let cont: string | undefined;
    do {
      const body = await this.#request('GET', {
        action: 'query', list: 'categorymembers', cmtitle: `Category:${category}`, cmnamespace: '0', cmlimit: '500',
        ...(cont === undefined ? {} : { cmcontinue: cont }),
      });
      const members = isRecord(body.query) && Array.isArray(body.query.categorymembers) ? body.query.categorymembers : [];
      for (const member of members) if (isRecord(member) && typeof member.title === 'string') titles.push(member.title);
      cont = isRecord(body.continue) && typeof body.continue.cmcontinue === 'string' ? body.continue.cmcontinue : undefined;
    } while (cont !== undefined);
    return titles;
  }

  async edit(title: string, text: string, summary: string, options: EditOptions = {}): Promise<number> {
    if (this.#csrf === undefined) throw new WikiError('NOT_LOGGED_IN');
    const body = await this.#request('POST', {
      action: 'edit', title, text, summary, token: this.#csrf, bot: '1',
      ...(options.createOnly ? { createonly: '1' } : {}),
      ...(options.baseRevId === undefined ? {} : { baserevid: String(options.baseRevId) }),
    });
    const edit = body.edit;
    if (!isRecord(edit) || edit.result !== 'Success') throw new WikiError('EDIT_FAILED');
    const revid = edit.newrevid ?? edit.oldrevid;
    if (typeof revid !== 'number') throw new WikiError('INVALID_RESPONSE', 'revid');
    return revid;
  }
}
