import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { isRecord } from './guards.js';

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export const CHAT_ID = /^[ucrsm][A-Za-z0-9]{10,64}$/;

export interface WikiConfig {
  /** Base URL ending in `/`, e.g. `https://wiki.example.org/`. */
  url: string;
  username: string;
  password: string;
}

export interface Config {
  /** Chat IDs to process, in configuration order. */
  chats: string[];
  openai: OpenAIConfig;
  /** Always `chatlog.db` beside the configuration file. */
  database: string;
  /** Topics whose last activity is within this many minutes of the newest topic are left for a later run. */
  settleMinutes: number;
  /** Optional NekoBrief database that `--sync` copies into `database`. */
  syncFrom: string | undefined;
  /** Directory holding `state.json`, `plan.json`, `drafts/` and the run lock. */
  stateDir: string;
  /** Only required when publishing. */
  wiki: WikiConfig | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConfigError(message);
}

export async function loadConfig(filename = 'config.yaml'): Promise<Config> {
  const path = resolve(filename);
  let raw: unknown;
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    requireValue(stat.isFile(), '設定檔必須是一般檔案。');
    requireValue((stat.mode & 0o077) === 0, '設定檔包含金鑰，請先執行 chmod 600 config.yaml。');
    raw = parse(await file.readFile('utf8'), { maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('無法讀取設定檔：請確認檔案存在、不是符號連結，且為有效 YAML。');
  } finally {
    await file?.close();
  }
  return parseConfig(raw, dirname(path));
}

export function parseConfig(raw: unknown, baseDir: string): Config {
  requireValue(isRecord(raw), '設定必須是鍵值物件。');
  const openai = raw.openai;
  requireValue(isRecord(openai), '缺少 openai 設定。');
  requireValue(typeof openai.apiKey === 'string' && openai.apiKey !== '', 'openai.apiKey 必須是非空字串。');
  const model = openai.model;
  requireValue(typeof model === 'string' && model !== '', 'openai.model 必須是非空字串（請指定模型）。');
  const maxOutputTokens = openai.maxOutputTokens ?? 16_000;
  requireValue(typeof maxOutputTokens === 'number' && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0,
    'openai.maxOutputTokens 必須是正整數。');
  const timeoutMs = openai.timeoutMs ?? 180_000;
  requireValue(typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    'openai.timeoutMs 必須是正整數。');
  const chats = raw.chats;
  requireValue(Array.isArray(chats) && chats.length > 0
    && chats.every((id) => typeof id === 'string' && CHAT_ID.test(id)) && new Set(chats).size === chats.length,
    'chats 必須是不重複聊天室 ID 的非空清單。');
  const stateDir = raw.stateDir ?? 'state';
  requireValue(typeof stateDir === 'string' && stateDir !== '', 'stateDir 必須是非空字串。');
  const settleMinutes = raw.settleMinutes ?? 120;
  requireValue(typeof settleMinutes === 'number' && Number.isSafeInteger(settleMinutes) && settleMinutes >= 0,
    'settleMinutes 必須是非負整數。');
  const syncFrom = raw.syncFrom;
  requireValue(syncFrom === undefined || (typeof syncFrom === 'string' && syncFrom !== ''), 'syncFrom 必須是非空字串。');
  let wiki: WikiConfig | undefined;
  if (raw.wiki !== undefined) {
    const w = raw.wiki;
    requireValue(isRecord(w), 'wiki 必須是鍵值物件。');
    requireValue(typeof w.url === 'string' && /^https?:\/\/.+\/$/.test(w.url), 'wiki.url 必須是以 / 結尾的 http(s) 網址。');
    requireValue(typeof w.username === 'string' && w.username !== '', 'wiki.username 必須是非空字串。');
    requireValue(typeof w.password === 'string' && w.password !== '', 'wiki.password 必須是非空字串。');
    wiki = { url: w.url, username: w.username, password: w.password };
  }
  return {
    chats: chats as string[],
    openai: { apiKey: openai.apiKey, model, maxOutputTokens, timeoutMs },
    database: resolve(baseDir, 'chatlog.db'),
    settleMinutes,
    syncFrom: syncFrom === undefined ? undefined : resolve(baseDir, syncFrom),
    stateDir: resolve(baseDir, stateDir),
    wiki,
  };
}
