import { rename, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

/**
 * Replace `target` with a consistent snapshot of `source`. `VACUUM INTO` reads through SQLite, so a database that
 * NekoBrief is writing (WAL mode) is copied safely, unlike a plain file copy.
 */
export async function syncDatabase(source: string, target: string): Promise<void> {
  const temp = `${target}.sync`;
  await rm(temp, { force: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  // Journal files belong to the database being replaced and must not be applied to the new one.
  await rm(`${target}-wal`, { force: true });
  await rm(`${target}-shm`, { force: true });
  await rename(temp, target);
}
