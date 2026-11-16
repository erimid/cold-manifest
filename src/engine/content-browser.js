// Browser content loader. Vite bundles every JSON file under /content at build
// time, so the game works offline with no fetches. Node has its own loader in
// tools/lib/load-content.js; both feed the same createContent().

import { createContent } from './content.js';

const modules = import.meta.glob('/content/**/*.json', { eager: true, import: 'default' });

export function loadContent() {
  const files = Object.entries(modules).map(([path, data]) => ({
    path: path.replace(/^\/content\//, ''),
    data,
  }));
  return createContent(files);
}
