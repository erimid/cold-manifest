// Node content loader, used by the content checker, autoplay and tests.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONTENT_DIR = join(ROOT, 'content');

/** Every file under `dir` (recursive) whose name ends with `ext`, sorted. */
export function listFiles(dir, ext) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      out.push(...listFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Read every JSON file under /content.
 * Returns { path, data } per file, or { path, error } when a file does not parse.
 */
export function readContentFiles(contentDir = CONTENT_DIR) {
  return listFiles(contentDir, '.json').map((full) => {
    const path = relative(contentDir, full).split(sep).join('/');
    try {
      return { path, data: JSON.parse(readFileSync(full, 'utf8')) };
    } catch (err) {
      return { path, error: err.message };
    }
  });
}
