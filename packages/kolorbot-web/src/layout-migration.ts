import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface LayoutMigrationResult {
  moved: string[];
  skipped: string[];
}

/**
 * Move the pre-`agent` data layout into the current one.
 *
 * Old layout:
 *   <home>/workspace/AI.md, topic/, daily/
 *   <home>/skills/
 *   <home>/conversation.db
 *
 * New layout:
 *   <home>/agent/AI.md, topic/, daily/, skills/, conversation.db
 *
 * Migration only runs for the default `agent` root. Custom
 * KOLOR_FRAME_ROOT / KOLOR_CONVERSATION_DB paths are never touched.
 */
export function migrateLegacyLayout(
  home: string,
  frameRoot: string,
  conversationDbPath: string,
  logger?: (message: string) => void,
): LayoutMigrationResult {
  const moved: string[] = [];
  const skipped: string[] = [];
  const targetRoot = join(home, 'agent');
  if (frameRoot !== targetRoot) return { moved, skipped };

  const legacyRoot = join(home, 'workspace');
  if (existsSync(legacyRoot)) {
    if (!existsSync(targetRoot)) {
      renameSync(legacyRoot, targetRoot);
      moved.push(`${legacyRoot} -> ${targetRoot}`);
    } else {
      mergeMissing(legacyRoot, targetRoot, moved, skipped);
    }
  }

  const legacySkills = join(home, 'skills');
  const targetSkills = join(frameRoot, 'skills');
  if (existsSync(legacySkills)) {
    if (!existsSync(targetSkills)) {
      mkdirSync(frameRoot, { recursive: true });
      renameSync(legacySkills, targetSkills);
      moved.push(`${legacySkills} -> ${targetSkills}`);
    } else {
      mergeMissing(legacySkills, targetSkills, moved, skipped);
    }
  }

  const legacyDb = join(home, 'conversation.db');
  const targetDb = join(frameRoot, 'conversation.db');
  if (
    conversationDbPath === targetDb &&
    existsSync(legacyDb) &&
    !existsSync(targetDb)
  ) {
    mkdirSync(frameRoot, { recursive: true });
    renameSync(legacyDb, targetDb);
    for (const suffix of ['-wal', '-shm']) {
      const source = `${legacyDb}${suffix}`;
      const target = `${targetDb}${suffix}`;
      if (existsSync(source) && !existsSync(target)) renameSync(source, target);
    }
    moved.push(`${legacyDb} -> ${targetDb}`);
  } else if (existsSync(legacyDb)) {
    skipped.push(`${legacyDb} (target already exists or a custom DB path is set)`);
  }

  for (const message of moved) logger?.(`moved legacy data: ${message}`);
  return { moved, skipped };
}

function mergeMissing(
  source: string,
  target: string,
  moved: string[],
  skipped: string[],
): void {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const to = join(target, entry);
    if (existsSync(to)) {
      skipped.push(`${from} (target already exists)`);
      continue;
    }
    renameSync(from, to);
    moved.push(`${from} -> ${to}`);
  }
  try {
    if (statSync(source).isDirectory() && readdirSync(source).length === 0) rmdirSync(source);
  } catch {
    // Keep a non-empty directory for the user to inspect.
  }
}
