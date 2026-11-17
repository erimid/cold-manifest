// Player settings (brief §7, §17), kept in localStorage. Settings are not
// part of the simulation: they change what the player sees and hears and when
// the game pauses for them, never what happens.

const KEY = 'cold-manifest.settings.v1';

/** Auto-pause is on by default on touch screens, where a slip of the finger costs more (brief §7). */
export function defaultSettings({ touch = false } = {}) {
  return { sound: true, shake: true, scanlines: true, fastTime: true, autoPause: { fired: touch, contact: touch, boarded: touch, fire: touch, breach: touch, death: touch, objection: touch, refusal: touch, situation: touch } };
}

/** What each auto-pause setting is called, and which game event trips it. */
export const AUTO_PAUSE = Object.freeze([
  // A ship opens fire on us, warning shot or not (H.3; the duel's "a fight starts" went with the duel).
  { id: 'fired', label: 'We are fired on', event: 'contact.fired' },
  { id: 'boarded', label: 'Boarders get aboard', event: 'enemy.crew.boarded' },
  // A fire or a breach in a room nobody can see into pauses nothing until it is found (senses.js).
  { id: 'fire', label: 'A fire starts', event: 'fire.started', found: 'fire.found' },
  { id: 'breach', label: 'The hull is breached', event: 'breach.opened', found: 'breach.found' },
  { id: 'death', label: 'A crew member dies', event: 'crew.died' },
  // Margo holds an order, or one of the crew will not take one (S2.10; brief §7).
  { id: 'objection', label: 'Margo holds an order', event: 'ai.objected' },
  { id: 'refusal', label: 'A crew member refuses', event: 'crew.refused' },
  // Something aboard wants dealing with (H.7): a situation is put in a room, or one lapses.
  { id: 'situation', label: 'Something happens aboard', event: 'situation.placed' },
  // A ship on the scope that is sure of us and coming in (H.1). Last, so the sheet keeps its height.
  { id: 'contact', label: 'A ship closes on us', event: 'contact.closing' },
]);

/** Merge saved values over defaults, keeping only keys we know and only true or false. */
export function mergeSettings(defaults, saved) {
  const out = structuredClone(defaults);
  if (!saved || typeof saved !== 'object') return out;
  for (const key of ['sound', 'shake', 'scanlines', 'fastTime']) if (typeof saved[key] === 'boolean') out[key] = saved[key];
  for (const key of Object.keys(out.autoPause)) {
    if (typeof saved.autoPause?.[key] === 'boolean') out.autoPause[key] = saved.autoPause[key];
  }
  return out;
}

/**
 * Load settings. `storage` is localStorage (or null where it is blocked);
 * `overrides` come from the URL (?autopause=0, ?sound=0, ?fast=0) and are not saved.
 */
export function createSettings({ storage, touch, overrides = {} }) {
  let saved = null;
  try {
    saved = JSON.parse(storage?.getItem(KEY) ?? 'null');
  } catch {
    saved = null;
  }
  const values = mergeSettings(defaultSettings({ touch }), saved);
  if (typeof overrides.sound === 'boolean') values.sound = overrides.sound;
  if (typeof overrides.fastTime === 'boolean') values.fastTime = overrides.fastTime;
  if (typeof overrides.autoPause === 'boolean') for (const key of Object.keys(values.autoPause)) values.autoPause[key] = overrides.autoPause;
  const listeners = new Set();

  return {
    values,
    /** Change one setting, by path: set('sound', false) or set('autoPause.fire', true). */
    set(path, value) {
      const [first, second] = path.split('.');
      if (second) values[first][second] = Boolean(value);
      else values[first] = Boolean(value);
      try {
        storage?.setItem(KEY, JSON.stringify(values));
      } catch {
        // Private browsing or a full disk: the setting still holds for this visit.
      }
      for (const fn of [...listeners]) fn(values);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
