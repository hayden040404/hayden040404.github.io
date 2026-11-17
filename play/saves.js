/* Back Alley Play — saved games. Pure storage logic over any localStorage-like object
 * (getItem/setItem/removeItem), so it runs in the browser and in Node tests. No DOM.
 * Every game is kept as its full engine state, so a resume continues exactly where it stopped.
 */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BASaves = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const KEY = 'backalley-play-games-v1';
  const LEGACY_KEY = 'backalley-play-v1';

  function newId(now) {
    return 'g' + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function createStore(storage, opts) {
    opts = opts || {};
    const key = opts.key || KEY;
    const clock = opts.now || function () { return Date.now(); };

    function read() {
      try {
        const raw = JSON.parse(storage.getItem(key) || 'null');
        if (raw && Array.isArray(raw.games)) return raw;
      } catch (e) {}
      return { games: [], currentId: null };
    }
    function write(db) { storage.setItem(key, JSON.stringify(db)); }

    /** Save (create or overwrite) a game's full state. Returns its id. */
    function put(id, state) {
      const db = read();
      const now = clock();
      let g = id ? db.games.filter(function (x) { return x.id === id; })[0] : null;
      if (!g) {
        g = { id: id || newId(now), startedAt: now, updatedAt: now, state: null };
        db.games.push(g);
      }
      g.state = state;
      g.updatedAt = now;
      g.finished = !!(state && state.phase === 'gameOver');
      db.currentId = g.id;
      write(db);
      return g.id;
    }
    function get(id) {
      const g = read().games.filter(function (x) { return x.id === id; })[0];
      return g ? JSON.parse(JSON.stringify(g)) : null;
    }
    function remove(id) {
      const db = read();
      const before = db.games.length;
      db.games = db.games.filter(function (x) { return x.id !== id; });
      if (db.currentId === id) db.currentId = null;
      write(db);
      return db.games.length < before;
    }
    function setCurrent(id) { const db = read(); db.currentId = id; write(db); }
    function current() { const db = read(); return db.currentId ? get(db.currentId) : null; }
    /** Newest activity first. */
    function list() {
      return read().games.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    }
    /** One-time import of the single game the first version kept under backalley-play-v1. */
    function migrateLegacy() {
      let raw = null;
      try { raw = JSON.parse(storage.getItem(LEGACY_KEY) || 'null'); } catch (e) {}
      if (!raw) return null;
      storage.removeItem(LEGACY_KEY);
      return { prefs: raw.prefs || null, id: raw.state && raw.state.round ? put(null, raw.state) : null };
    }
    return { put: put, get: get, remove: remove, list: list, current: current, setCurrent: setCurrent, migrateLegacy: migrateLegacy };
  }

  /** Plain summary for the Saved Games list (needs the engine for scores). */
  function summarize(game, E, BA) {
    const s = game.state;
    const sc = E.score(s);
    const total = s.cardsList.length;
    const finished = s.phase === 'gameOver';
    let progress;
    if (finished) progress = 'Finished';
    else {
      const meta = BA.handMeta(s.handIndex, s.cardsList);
      const step = s.phase === 'bidding' ? 'bidding' : s.phase === 'playing' ? 'playing' : 'hand done';
      progress = 'Hand ' + meta.handNumber + ' of ' + total + ' \u00b7 ' + meta.cards + ' card' + (meta.cards === 1 ? '' : 's') + ' \u00b7 ' + step;
    }
    return { id: game.id, startedAt: game.startedAt, updatedAt: game.updatedAt, finished: finished, progress: progress, us: sc.aTotal, them: sc.bTotal, leader: sc.leader, maxCards: s.maxCards };
  }

  return { KEY: KEY, LEGACY_KEY: LEGACY_KEY, createStore: createStore, summarize: summarize };
});
