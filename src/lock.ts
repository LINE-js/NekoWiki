import { open, readFile, rm } from 'node:fs/promises';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Exclusive run lock so two publishing runs never race on `state.json` or publish the same topic twice. The lock file
 * holds the owner's PID; a file left by a dead process is reclaimed.
 */
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(path, 'wx');
      await file.writeFile(`${process.pid}\n`);
      await file.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const pid = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10);
    if (Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)) throw new Error(`已有另一個執行中的程序（PID ${pid}）持有 ${path}。`);
    await rm(path, { force: true });
  }
  throw new Error(`無法取得 ${path}。`);
}
