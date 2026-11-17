/* Back Alley Play — saved games + finished-game history on this device.
 * Pure storage logic over any localStorage-like object (getItem/setItem/removeItem), so it runs
 * in the browser and in Node tests. No DOM, no Firebase.
 *
 * Every game keeps its full engine state, so a resume continues exactly where it stopped.
 * Accounts: each entry has an `owner` (null = guest, otherwise the account uid). The store shows
 * only the active owner's games. `dirty` marks changes the cloud hasn't seen yet; deletions of
 * account games are queued in `pendingDeletes` until the cloud confirms them. sync.js uses the
 * sync helpers at the bottom; guests never touch them.
 */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BASaves = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const KEY = 'backalley-play-games-v1';
  const HISTORY_KEY = 'backalley-play-history-v1';
  const LEGACY_KEY = 'backalley-play-v1';

  function newId(now) {
    return 'g' + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function ownerKey(o) { return o || ''; }

  function createStore(storage, opts) {
    opts = opts || {};
    const key = opts.key || KEY;
    const hkey = opts.historyKey || HISTORY_KEY;
    const clock = opts.now || function () { return Date.now(); };
    let owner = opts.owner || null;

    function read() {
      try {
        const raw = JSON.parse(storage.getItem(key) || 'null');
        if (raw && Array.isArray(raw.games)) {
          if (!raw.current || typeof raw.current !== 'object') raw.current = {};
          if (raw.currentId !== undefined) { if (raw.currentId) raw.current[''] = raw.currentId; delete raw.currentId; }
          if (!Array.isArray(raw.pendingDeletes)) raw.pendingDeletes = [];
          raw.games.forEach(function (g) { if (g.owner === undefined) g.owner = null; });
          return raw;
        }
      } catch (e) {}
      return { games: [], current: {}, pendingDeletes: [] };
    }
    function write(db) { storage.setItem(key, JSON.stringify(db)); }
    function find(db, id) { return db.games.filter(function (x) { return x.id === id && x.owner === owner; })[0] || null; }

    function setOwner(o) { owner = o || null; }
    function getOwner() { return owner; }

    /** Save (create or overwrite) a game's full state for the active owner. Returns its id. */
    function put(id, state) {
      const db = read();
      const now = clock();
      let g = id ? find(db, id) : null;
      if (!g) {
        g = { id: id || newId(now), owner: owner, startedAt: now, updatedAt: now, state: null };
        db.games.push(g);
      }
      g.state = state;
      g.updatedAt = Math.max(now, (g.updatedAt || 0) + 1);
      g.finished = !!(state && state.phase === 'gameOver');
      if (owner) g.dirty = true;
      db.current[ownerKey(owner)] = g.id;
      write(db);
      return g.id;
    }
    function get(id) { return clone(find(read(), id)); }
    function remove(id) {
      const db = read();
      const g = find(db, id);
      if (!g) return false;
      db.games = db.games.filter(function (x) { return x !== g; });
      if (db.current[ownerKey(owner)] === id) db.current[ownerKey(owner)] = null;
      if (owner && db.pendingDeletes.indexOf(owner + '/' + id) < 0) db.pendingDeletes.push(owner + '/' + id);
      write(db);
      return true;
    }
    function setCurrent(id) { const db = read(); db.current[ownerKey(owner)] = id; write(db); }
    function current() { const db = read(); const id = db.current[ownerKey(owner)]; return id ? get(id) : null; }
    /** Active owner's games, newest activity first. */
    function list() {
      return read().games.filter(function (g) { return g.owner === owner; })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; }).map(clone);
    }
    /** One-time import of the single game the first version kept under backalley-play-v1. */
    function migrateLegacy() {
      let raw = null;
      try { raw = JSON.parse(storage.getItem(LEGACY_KEY) || 'null'); } catch (e) {}
      if (!raw) return null;
      storage.removeItem(LEGACY_KEY);
      const was = owner;
      owner = null;
      const id = raw.state && raw.state.round ? put(null, raw.state) : null;
      owner = was;
      return { prefs: raw.prefs || null, id: id };
    }

    // ---------- finished-game history (feeds stats + achievements) ----------
    function readH() {
      try {
        const raw = JSON.parse(storage.getItem(hkey) || 'null');
        if (raw && Array.isArray(raw.records)) return raw;
      } catch (e) {}
      return { records: [] };
    }
    function writeH(h) { storage.setItem(hkey, JSON.stringify(h)); }
    /** Add a finished game's record (idempotent per game id + owner). Returns true if new. */
    function addHistory(rec) {
      const h = readH();
      if (h.records.some(function (r) { return r.id === rec.id && r.owner === owner; })) return false;
      const r = clone(rec);
      r.owner = owner;
      if (owner) r.dirty = true;
      h.records.push(r);
      writeH(h);
      return true;
    }
    function history(who) {
      const o = arguments.length ? (who || null) : owner;
      return readH().records.filter(function (r) { return r.owner === o; }).map(function (r) {
        const c = clone(r); delete c.owner; delete c.dirty; return c;
      });
    }

    // ---------- sync helpers (used by sync.js only) ----------
    /** Move every guest game + guest history record on this device into account `uid`. */
    function adoptGuest(uid) {
      const db = read();
      let n = 0;
      db.games.forEach(function (g) {
        if (g.owner === null) {
          if (db.games.some(function (x) { return x.owner === uid && x.id === g.id; })) return;
          g.owner = uid; g.dirty = true; n += 1;
        }
      });
      if (db.current[''] && !db.current[uid]) db.current[uid] = db.current[''];
      db.current[''] = null;
      db.games = db.games.filter(function (g) { return g.owner !== null; });
      write(db);
      const h = readH();
      let hn = 0;
      h.records.forEach(function (r) {
        if (r.owner === null) {
          if (h.records.some(function (x) { return x.owner === uid && x.id === r.id; })) { r.drop = true; return; }
          r.owner = uid; r.dirty = true; hn += 1;
        }
      });
      h.records = h.records.filter(function (r) { return !r.drop; });
      writeH(h);
      return { games: n, history: hn };
    }
    function dirtyGames(uid) { return read().games.filter(function (g) { return g.owner === uid && g.dirty; }).map(clone); }
    function markGameSynced(uid, id, updatedAt) {
      const db = read();
      const g = db.games.filter(function (x) { return x.owner === uid && x.id === id; })[0];
      if (g && g.updatedAt === updatedAt) { g.dirty = false; g.synced = true; write(db); }
    }
    function pendingDeletes(uid) {
      return read().pendingDeletes.filter(function (p) { return p.indexOf(uid + '/') === 0; }).map(function (p) { return p.slice(uid.length + 1); });
    }
    function clearPendingDelete(uid, id) {
      const db = read();
      db.pendingDeletes = db.pendingDeletes.filter(function (p) { return p !== uid + '/' + id; });
      write(db);
    }
    /** Merge the cloud's game list into this device. Newer updatedAt wins; games deleted on
     * another device (previously synced here, now missing in the cloud) are removed here. */
    function applyRemoteGames(uid, remote) {
      const db = read();
      const pend = {};
      db.pendingDeletes.forEach(function (p) { pend[p] = 1; });
      const seen = {};
      let changed = 0;
      remote.forEach(function (rg) {
        seen[rg.id] = 1;
        if (pend[uid + '/' + rg.id]) return;
        const g = db.games.filter(function (x) { return x.owner === uid && x.id === rg.id; })[0];
        if (!g) {
          db.games.push({ id: rg.id, owner: uid, startedAt: rg.startedAt, updatedAt: rg.updatedAt, state: rg.state, finished: !!rg.finished, dirty: false, synced: true });
          changed += 1;
        } else if (rg.updatedAt > g.updatedAt) {
          g.state = rg.state; g.updatedAt = rg.updatedAt; g.startedAt = rg.startedAt; g.finished = !!rg.finished; g.dirty = false; g.synced = true;
          changed += 1;
        } else if (rg.updatedAt === g.updatedAt) { g.dirty = false; g.synced = true; }
      });
      db.games = db.games.filter(function (g) {
        const gone = g.owner === uid && !seen[g.id] && g.synced && !g.dirty;
        if (gone) { changed += 1; if (db.current[uid] === g.id) db.current[uid] = null; }
        return !gone;
      });
      write(db);
      return changed;
    }
    function dirtyHistory(uid) {
      return readH().records.filter(function (r) { return r.owner === uid && r.dirty; }).map(function (r) { const c = clone(r); delete c.owner; delete c.dirty; return c; });
    }
    function markHistorySynced(uid, id) {
      const h = readH();
      h.records.forEach(function (r) { if (r.owner === uid && r.id === id) r.dirty = false; });
      writeH(h);
    }
    function applyRemoteHistory(uid, remote) {
      const h = readH();
      let n = 0;
      remote.forEach(function (rr) {
        if (!h.records.some(function (r) { return r.owner === uid && r.id === rr.id; })) {
          const c = clone(rr); c.owner = uid; c.dirty = false; h.records.push(c); n += 1;
        }
      });
      writeH(h);
      return n;
    }

    return {
      put: put, get: get, remove: remove, list: list, current: current, setCurrent: setCurrent, migrateLegacy: migrateLegacy,
      setOwner: setOwner, owner: getOwner, addHistory: addHistory, history: history,
      adoptGuest: adoptGuest, dirtyGames: dirtyGames, markGameSynced: markGameSynced, pendingDeletes: pendingDeletes,
      clearPendingDelete: clearPendingDelete, applyRemoteGames: applyRemoteGames, dirtyHistory: dirtyHistory,
      markHistorySynced: markHistorySynced, applyRemoteHistory: applyRemoteHistory
    };
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

  return { KEY: KEY, HISTORY_KEY: HISTORY_KEY, LEGACY_KEY: LEGACY_KEY, createStore: createStore, summarize: summarize };
});
