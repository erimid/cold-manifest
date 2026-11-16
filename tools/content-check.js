#!/usr/bin/env node
// Content checker (brief §19). Run with: npm run check
//
// Validates every content file, lints the code for unseeded randomness, and
// prints the coverage report against the launch targets.
//
//   --strict   also fail when any coverage target is not met, or any
//              placeholder line remains (used from the end of Stage 10)
//
// Each stage adds checks for the content it introduces (PLAN.md §4).

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AI_CATEGORIES, CONTENT_TARGETS } from '../src/ai/categories.js';
import { createContent } from '../src/engine/content.js';
import { coverage, validateContent } from '../src/engine/content-schema.js';
import { ROOT, listFiles, readContentFiles } from './lib/load-content.js';

const strict = process.argv.includes('--strict');

// Built from two pieces so this file does not flag itself.
const BANNED_CALL = ['Math', 'random'].join('.');

/** Code must draw all randomness from src/engine/rng.js (DECISIONS D-005). */
function lintRandomness() {
  const problems = [];
  for (const dir of ['src', 'tools']) {
    for (const file of listFiles(join(ROOT, dir), '.js')) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes(BANNED_CALL)) {
            problems.push(`${relative(ROOT, file)}:${i + 1}: uses ${BANNED_CALL}; use the seeded RNG in src/engine/rng.js`);
          }
        });
    }
  }
  return problems;
}

function row(label, count, target) {
  const mark = count >= target ? 'ok ' : '   ';
  return `  ${mark} ${label.padEnd(34)} ${String(count).padStart(5)} / ${String(target).padEnd(5)}`;
}

const files = readContentFiles();
const { errors, warnings } = validateContent(files);
errors.push(...lintRandomness());

const report = coverage(createContent(files.filter((f) => !f.error)));

console.log('Cold Manifest content check');
console.log(`  ${files.length} content file(s)\n`);

console.log('AI lines by category (placeholders not counted)');
for (const category of report.categories) console.log(row(category.label, category.count, category.target));
console.log(row('All AI lines', report.aiLines, CONTENT_TARGETS.aiLines));
console.log(`      Placeholder lines still in the library: ${report.placeholders}\n`);

console.log('Other content');
console.log(row('Crew scenes', report.scenes, CONTENT_TARGETS.scenes));
console.log(row('Transit events', report.events, CONTENT_TARGETS.events));
console.log('');

const under = report.categories.filter((c) => c.count < c.target).map((c) => c.label);
if (report.aiLines < CONTENT_TARGETS.aiLines) under.push('All AI lines');
if (report.scenes < CONTENT_TARGETS.scenes) under.push('Crew scenes');
if (report.events < CONTENT_TARGETS.events) under.push('Transit events');

if (under.length) {
  const text = `${under.length} of ${AI_CATEGORIES.length + 3} coverage targets not met yet`;
  if (strict) errors.push(`${text}: ${under.join(', ')}`);
  else console.log(`Coverage: ${text} (expected before Stage 10; --strict makes this fail).`);
} else {
  console.log('Coverage: every target met.');
}
if (strict && report.placeholders > 0) errors.push(`${report.placeholders} placeholder line(s) remain`);

for (const warning of warnings) console.log(`warning: ${warning}`);
for (const error of errors) console.error(`ERROR: ${error}`);

if (errors.length) {
  console.error(`\nFAILED with ${errors.length} error(s).`);
  process.exit(1);
}
console.log('\nPASSED: content is valid.');
