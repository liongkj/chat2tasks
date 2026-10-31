import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function acquireLock(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, '.chat2tasks-process.sqlite'));
  try {
    db.exec(
      'PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE;',
    );
    return db;
  } catch (error) {
    db.close();
    if (
      error &&
      (error.errcode === 5 || error.errcode === 6 || /busy|locked/i.test(error.message))
    ) {
      const unavailable = new Error('This workspace is already running on this computer.');
      unavailable.code = 'CHAT2TASKS_IN_USE';
      throw unavailable;
    }
    throw error;
  }
}
