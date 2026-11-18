// Situations aboard, on the ship view (H.7, D-156, D-203): a chip at the room each one is in, and its
// card under the chip. Until one of ours is in the room the card says only what is known (the sign)
// and offers to send somebody; once someone is there it tells what they found and offers the choices,
// each with its requirement tag; answered, it tells what came of it until it is put away.
//
// The cards are DOM laid over the schematic, so they are controls like any other (44 px, keyboard,
// screen reader). Only one card is open at a time; a chip opens and folds its own.

import { situationViews } from '../narrative/events.js';
import { el } from './dom.js';

/** The words under a chip's title: what state the matter is in. */
export function chipNote(view) {
  if (view.state === 'answered') return view.result.lapsed ? 'Nobody went' : 'Dealt with';
  if (view.state === 'attended') return `${view.by} is there`;
  const hours = view.left === null ? '' : ` · ${Math.max(1, Math.ceil(view.left))} h`;
  return `${view.hold ? 'Hove to · ' : ''}Nobody there${hours}`;
}

/**
 * `order(command)` gives an order (returns true if it was taken); `nearest(room, about)` names the hand who would
 * get to a room soonest, leaving out the ids in `about` ({ id, name } or null); `selected()` is the crew member picked on the ship view
 * ({ id, name } or null).
 */
export function createSituationCards({ sim, order, nearest, selected }) {
  const node = el('div', { class: 'situations', id: 'situations' });
  const cards = new Map(); // n -> { node, key, state }
  let open = null; // the number of the card that is open

  function body(view) {
    if (view.state === 'answered') {
      return [
        el('p', { class: 'sitcard__text', id: `sit-result-${view.n}` }, view.result.text),
        el('div', { class: 'sitcard__buttons' }, el('button', { class: 'btn btn--small', type: 'button', id: `sit-dismiss-${view.n}`, press: () => order({ type: 'event.dismiss', situation: view.n }) }, 'Put away')),
      ];
    }
    if (view.state === 'attended') {
      return [
        el('p', { class: 'sitcard__text', id: `sit-text-${view.n}` }, view.text),
        el(
          'div',
          { class: 'sitcard__buttons', id: `sit-choices-${view.n}` },
          view.choices.map((choice) =>
            el(
              'button',
              { class: `btn btn--small choice${choice.available ? '' : ' choice--locked'}`, type: 'button', id: `sit-choice-${view.n}-${choice.id}`, disabled: !choice.available, press: () => order({ type: 'event.choose', situation: view.n, choice: choice.id }) },
              choice.tag && el('span', { class: 'choice__tag' }, choice.tag, ' '),
              choice.label,
            ),
          ),
        ),
      ];
    }
    // The people it is about are in it, not sent to it.
    const chosen = selected();
    const picked = chosen && !view.about.includes(chosen.id) ? chosen : null;
    const hand = picked ?? nearest(view.room, view.about);
    return [
      el('p', { class: 'sitcard__text', id: `sit-sign-${view.n}` }, view.sign),
      el('p', { class: 'sitcard__hint' }, `Nobody is in ${view.roomName}. Whoever goes there deals with it.`),
      el(
        'div',
        { class: 'sitcard__buttons' },
        hand
          ? el('button', { class: 'btn btn--small', type: 'button', id: `sit-send-${view.n}`, press: () => order({ type: 'crew.move', crew: hand.id, room: view.room, ship: 'us' }) }, `Send ${hand.name}`, el('small', {}, picked ? 'The one you have picked' : 'Nearest hand awake'))
          : el('p', { class: 'sitcard__hint' }, 'Nobody is free to go.'),
      ),
    ];
  }

  function build(view, isOpen) {
    const toggle = () => {
      open = open === view.n ? null : view.n;
    };
    return el(
      'div',
      { class: `sitcard sitcard--${view.state}${isOpen ? ' is-open' : ''}`, id: `sit-${view.n}`, 'data-event': view.id, 'data-room': view.room, 'data-state': view.state },
      el(
        'button',
        { class: 'btn sitcard__chip', type: 'button', id: `sit-chip-${view.n}`, 'aria-expanded': String(isOpen), press: toggle },
        el('span', { class: 'sitcard__mark', 'aria-hidden': 'true' }, view.state === 'answered' ? '·' : '!'),
        el('span', { class: 'sitcard__title' }, view.title, el('small', { class: 'sitcard__note' }, chipNote(view))),
      ),
      isOpen && el('div', { class: 'panel sitcard__body', role: 'group', 'aria-label': view.title }, body(view)),
    );
  }

  return {
    node,
    /** The number of the open card, or null (tests). */
    get open() {
      return open;
    },
    /**
     * Once a frame: `boxOf(room)` is the room's rectangle on screen ({ x, y, w, h }, CSS pixels inside the
     * ship view), `bounds` the monitor's, and `hidden` takes every card down (the chart is up).
     */
    update({ boxOf, bounds, hidden = false }) {
      if (node.hidden !== hidden) node.hidden = hidden;
      if (hidden) return; // the cards keep their state under the chart
      const views = situationViews(sim);
      const live = new Set(views.map((view) => view.n));
      for (const [n, card] of cards) {
        if (live.has(n)) continue;
        card.node.remove();
        cards.delete(n);
        if (open === n) open = null;
      }
      // A card opens itself when its matter moves on (somebody gets there, or it is settled), unless another is being read.
      for (const view of views) {
        const before = cards.get(view.n)?.state;
        if (before !== view.state) {
          const reading = open !== null && open !== view.n && cards.get(open)?.state === 'attended';
          if (view.state !== 'waiting' && !reading) open = view.n;
          else if (before === undefined && open === null) open = view.n;
        }
      }
      const picked = selected();
      views.forEach((view, i) => {
        const isOpen = open === view.n;
        const key = JSON.stringify([view.state, view.title, view.by, view.text, view.choices, view.result, isOpen, isOpen && view.state === 'waiting' ? ((picked && !view.about.includes(picked.id) ? picked.id : null) ?? nearest(view.room, view.about)?.id ?? null) : null]);
        let card = cards.get(view.n);
        if (!card || card.key !== key) {
          const fresh = build(view, isOpen);
          if (card) card.node.replaceWith(fresh);
          else node.append(fresh);
          card = { node: fresh, key, state: view.state, note: fresh.querySelector('.sitcard__note') };
          cards.set(view.n, card);
        }
        // The hours left tick down in place, so a card being read (or a button under a finger) is not rebuilt for them.
        const note = chipNote(view);
        if (card.note.textContent !== note) card.note.textContent = note;
        // The chip sits on the top edge of its room; a second matter in the same room sits under the first.
        const box = boxOf(view.room);
        const same = views.slice(0, i).filter((other) => other.room === view.room).length;
        const width = Math.min(380, bounds.w - 16);
        // The chip stays on its room, even a narrow one at the monitor's edge (it is cut narrower there, never less
        // than 112 px); the card under it slides left when it would run off the monitor.
        const left = Math.max(bounds.x + 8, Math.min(box.x + 4, bounds.x + bounds.w - 120));
        const shift = Math.max(0, left + width - (bounds.x + bounds.w - 8));
        const top = Math.max(bounds.y + 8, Math.min(box.y + 4 + same * 50, bounds.y + bounds.h - 52));
        // The open card hangs under its chip, over whatever is below the monitor while it is read; only a room at
        // the very foot of the screen has its card stand on the chip instead.
        const below = window.innerHeight - top - 64;
        const up = below < 200;
        const room = up ? top - 16 : below;
        const style = `left:${Math.round(left)}px;top:${Math.round(top)}px;width:${Math.round(width)}px;--sit-shift:${Math.round(shift)}px;--sit-room:${Math.max(120, Math.round(room))}px;z-index:${isOpen ? 5 : 4}`;
        if (card.style !== style) {
          card.style = style;
          card.node.setAttribute('style', style);
          card.node.classList.toggle('sitcard--up', up);
        }
      });
    },
  };
}
