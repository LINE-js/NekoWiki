/** Hosts of invite, meeting and link-shortener URLs: private, short-lived or opaque, so never published. */
const BLOCKED_HOSTS = [
  'discord.gg', 'discord.com', 'discordapp.com', 'line.me', 'lin.ee', 'zoom.us', 'meet.google.com',
  'teams.microsoft.com', 't.me', 'wa.me', 'whatsapp.com', 'bit.ly', 'reurl.cc', 'tinyurl.com', 'pse.is',
];

const URL_PATTERN = /https?:\/\/[^\s<>\]|)）」』]+/gi;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Taiwan mobile and +886 numbers. */
const PHONE_PATTERN = /(?:\+886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g;

export interface Sanitized {
  text: string;
  /** Human-readable notes for the reviewer: what was removed, what deserves a look. */
  flags: string[];
}

function blocked(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return BLOCKED_HOSTS.some((blockedHost) => host === blockedHost || host.endsWith(`.${blockedHost}`));
  } catch {
    return true;
  }
}

/**
 * Clean one model-written wikitext field. Removes what could change page structure or leak private details:
 * templates, magic words, HTML other than `<code>`, links to anything but known entries, invite/meeting URLs, emails
 * and phone numbers. Remaining external URLs are kept but flagged so the reviewer sees them.
 */
export function sanitizeWikitext(input: string, allowedLinks: ReadonlySet<string>): Sanitized {
  const flags = new Set<string>();
  let text = input;

  text = text.replace(/<!--[\s\S]*?-->/g, () => { flags.add('移除 HTML 註解'); return ''; });
  for (let depth = 0; depth < 5 && /\{\{[^{}]*\}\}/.test(text); depth += 1) {
    text = text.replace(/\{\{[^{}]*\}\}/g, () => { flags.add('移除樣板 {{…}}'); return ''; });
  }
  text = text.replace(/\{\{|\}\}|\{\||\|\}/g, () => { flags.add('移除樣板或表格標記'); return ''; });
  text = text.replace(/__[A-Z]+__|~{3,5}/g, () => { flags.add('移除魔術字'); return ''; });
  text = text.replace(/<\/?code>|<[^>]*>/gi, (tag) => {
    if (/^<\/?code>$/i.test(tag)) return tag.toLowerCase();
    flags.add('移除 HTML 標籤');
    return '';
  });
  text = text.replace(/^#redirect/gim, () => { flags.add('移除重新導向'); return ''; });
  text = text.replace(/^=+\s*(.*?)\s*=+\s*$/gm, (_all, title: string) => { flags.add('章節標題降級為粗體'); return `'''${title}'''`; });

  text = text.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_all, target: string, label: string | undefined) => {
    const name = target.trim().replace(/_/g, ' ');
    if (allowedLinks.has(name)) return label === undefined ? `[[${name}]]` : `[[${name}|${label}]]`;
    flags.add(`移除未知內部連結：${name}`);
    return label ?? name;
  });
  text = text.replace(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/gi, (_all, url: string, label: string | undefined) => {
    return blocked(url) ? (label ?? '') : `${label === undefined ? '' : `${label} `}${url}`;
  });

  text = text.replace(URL_PATTERN, (url) => {
    if (blocked(url)) { flags.add('移除邀請／會議／短網址連結'); return '〔連結已移除〕'; }
    flags.add(`含外部網址：${new URL(url).hostname}`);
    return url;
  });
  text = text.replace(EMAIL_PATTERN, () => { flags.add('移除 Email'); return '〔Email 已移除〕'; });
  text = text.replace(PHONE_PATTERN, () => { flags.add('移除電話'); return '〔電話已移除〕'; });
  return { text: text.trim(), flags: [...flags] };
}

/** Heading, tag or category-like text: plain characters only. */
export function plainText(input: string): string {
  return input.replace(/[[\]{}|<>=#\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}
