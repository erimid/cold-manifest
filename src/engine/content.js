// Content registry (brief §4: content is data, not code; DECISIONS D-006).
//
// Content lives in JSON files under /content/<type>/. Each file looks like:
//   { "items": [ { "id": "...", ... }, ... ] }
// The folder name is the content type. Dropping a new file into a folder is
// all it takes to add content: no engine code names any content file.
//
// This module is pure. The browser and Node each have a small loader that
// reads the files and hands them to createContent() as { path, data } pairs,
// with paths relative to /content (for example "ai-lines/placeholder.json").

/** Every content folder the game knows about. */
export const CONTENT_TYPES = Object.freeze([
  'ai-lines',
  'scenes',
  'events',
  'contracts',
  'ports',
  'factions',
  'goods',
  'crew',
  'threats',
  'ships',
  'weapons',
  'sectors',
]);

/** The content type of a file, from its path, or null if it is not in a known folder. */
export function typeOfPath(path) {
  const type = path.split('/')[0];
  return CONTENT_TYPES.includes(type) ? type : null;
}

/**
 * Build the registry from loaded files. Files that are malformed are skipped
 * here; the content checker is what reports them (see content-schema.js).
 */
export function createContent(files) {
  const byType = new Map(CONTENT_TYPES.map((type) => [type, []]));
  const byId = new Map(CONTENT_TYPES.map((type) => [type, new Map()]));

  for (const { path, data } of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const type = typeOfPath(path);
    if (!type || !data || !Array.isArray(data.items)) continue;
    for (const item of data.items) {
      if (!item || typeof item.id !== 'string' || byId.get(type).has(item.id)) continue;
      const entry = Object.freeze({ ...item, _file: path });
      byType.get(type).push(entry);
      byId.get(type).set(item.id, entry);
    }
  }

  function checkType(type) {
    if (!byType.has(type)) throw new Error(`Unknown content type "${type}"`);
  }

  return {
    /** All items of a type, in a stable order (by file path, then file order). */
    all(type) {
      checkType(type);
      return byType.get(type);
    },
    /** One item by id, or undefined. */
    get(type, id) {
      checkType(type);
      return byId.get(type).get(id);
    },
    /** One item by id. Throws if it is missing. */
    require(type, id) {
      const item = this.get(type, id);
      if (!item) throw new Error(`Missing ${type} content with id "${id}"`);
      return item;
    },
    count(type) {
      checkType(type);
      return byType.get(type).length;
    },
  };
}
