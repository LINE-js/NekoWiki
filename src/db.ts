import { DatabaseSync } from 'node:sqlite';

export interface Topic {
  id: number;
  chatId: string;
  hour: string;
  title: string;
  points: string[];
  startAt: string;
  endAt: string;
}

export interface Message {
  sentAt: string;
  senderId: string;
  text: string;
}

interface TopicRow {
  id: number;
  chat_id: string;
  hour: string;
  title: string;
  points: string;
  start_at: string;
  end_at: string;
}

function parsePoints(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toTopic(row: TopicRow): Topic {
  return {
    id: row.id, chatId: row.chat_id, hour: row.hour, title: row.title,
    points: parsePoints(row.points), startAt: row.start_at, endAt: row.end_at,
  };
}

/** Read-only view of NekoBrief's chatlog.db. */
export class ChatLogReader {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path, { readOnly: true });
  }

  /** Topics of one chat in chronological order. */
  topics(chatId: string): Topic[] {
    return (this.#db.prepare('SELECT * FROM topics WHERE chat_id = ? ORDER BY start_at, id').all(chatId) as unknown as TopicRow[])
      .map(toTopic);
  }

  /** End time of the newest topic: the snapshot's own notion of "now", used to skip topics that may still grow. */
  latestTopicEnd(): string | undefined {
    const row = this.#db.prepare('SELECT MAX(end_at) AS latest FROM topics').get();
    return typeof row?.latest === 'string' ? row.latest : undefined;
  }

  topic(id: number): Topic | undefined {
    const row = this.#db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as unknown as TopicRow | undefined;
    return row && toTopic(row);
  }

  /** Raw messages attached to any of the topics, oldest first. */
  messages(topicIds: readonly number[]): Message[] {
    if (topicIds.length === 0) return [];
    const marks = topicIds.map(() => '?').join(',');
    return this.#db.prepare(
      `SELECT sent_at, sender_id, text FROM messages WHERE topic_id IN (${marks}) ORDER BY sent_at, message_id`,
    ).all(...topicIds).map((row) => ({
      sentAt: String(row.sent_at), senderId: String(row.sender_id), text: String(row.text),
    }));
  }

  close(): void {
    this.#db.close();
  }
}
