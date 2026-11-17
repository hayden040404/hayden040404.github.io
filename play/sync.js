/* Back Alley Play — account sync. Pure logic, no Firebase import: it talks to a `remote`
 * adapter (cloud.js provides the Firestore one; tests use an in-memory fake).
 *
 * Cloud data model (Firestore), all private to the signed-in user:
 *   users/{uid}                 profile: displayName, stats snapshot, unlocked achievement ids
 *   users/{uid}/games/{gameId}  one saved game: seats, summary, full engine state (JSON string)
 *   users/{uid}/history/{gameId} one finished game's compact record (stats/achievements derive from these)
 * Multiplayer-ready: game docs already carry `mode`, `seats` (human/ai + uid) and the engine
 * state is seat-indexed, so a later online table can live at tables/{tableId} with the same
 * game shape and per-seat member uids, without changing these per-user collections.
 *
 * remote = { listGames(), putGame(doc), deleteGame(id), listHistory(), putHistory(rec), putProfile(p) }
 */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BASync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SCHEMA = 1;
  const MAX_STATE = 400000;

  function int(n) { n = Number(n); return Number.isFinite(n) ? Math.round(n) : 0; }

  /** Local saved-game entry -> Firestore game document. */
  function toGameDoc(g, uid, E) {
    const s = g.state;
    const sc = E.score(s);
    const json = JSON.stringify(s);
    if (json.length > MAX_STATE) throw new Error('Game too large to sync');
    return {
      schema: SCHEMA,
      mode: 'solo',
      ownerUid: uid,
      seats: (s.names || []).slice(0, 4).map(function (name, i) {
        return i === 0 ? { kind: 'human', uid: uid, name: String(name).slice(0, 30) } : { kind: 'ai', uid: '', name: String(name).slice(0, 30) };
      }),
      startedAt: int(g.startedAt),
      updatedAt: int(g.updatedAt),
      finished: s.phase === 'gameOver',
      maxCards: int(s.maxCards),
      summary: { handIndex: int(s.handIndex), handsTotal: s.cardsList.length, phase: String(s.phase), us: int(sc.aTotal), them: int(sc.bTotal) },
      state: json
    };
  }
  /** Firestore game document -> local entry shape (or null if unreadable). */
  function fromGameDoc(id, d) {
    try {
      const state = JSON.parse(d.state);
      return { id: id, startedAt: int(d.startedAt), updatedAt: int(d.updatedAt), finished: !!d.finished, state: state };
    } catch (e) { return null; }
  }
  function toHistoryDoc(r) {
    const c = {};
    Object.keys(r.counters || {}).forEach(function (k) { c[k] = int(r.counters[k]); });
    return { schema: SCHEMA, mode: String(r.mode || 'solo'), seat: int(r.seat), startedAt: int(r.startedAt), finishedAt: int(r.finishedAt), maxCards: int(r.maxCards), handsTotal: int(r.handsTotal), us: int(r.us), them: int(r.them), won: !!r.won, tied: !!r.tied, counters: c };
  }
  function fromHistoryDoc(id, d) { const r = JSON.parse(JSON.stringify(d)); r.id = id; return r; }
  function profileDoc(name, records, Stats) {
    const st = Stats.computeStats(records);
    const stats = {};
    Object.keys(st).forEach(function (k) { if (typeof st[k] === 'number') stats[k] = int(st[k]); });
    const ach = Stats.computeAchievements(records).filter(function (a) { return a.unlocked; }).map(function (a) { return a.id; });
    return { schema: SCHEMA, displayName: String(name || '').slice(0, 60), stats: stats, achievements: ach };
  }

  /**
   * createSync({ store, remote, uid, E, Stats, name(), onStatus(status), onChange(), debounceMs })
   * status: 'syncing' | 'synced' | 'offline' | 'error'
   */
  function createSync(o) {
    const store = o.store;
    const uid = o.uid;
    const timers = o.timers || { set: function (f, ms) { return setTimeout(f, ms); }, clear: function (t) { clearTimeout(t); } };
    let timer = null;
    let running = null;
    let stopped = false;
    let status = 'idle';
    function setStatus(s, err) { status = s; if (o.onStatus) o.onStatus(s, err); }

    async function pushDirty() {
      for (const id of store.pendingDeletes(uid)) {
        await o.remote.deleteGame(id);
        store.clearPendingDelete(uid, id);
      }
      for (const g of store.dirtyGames(uid)) {
        if (!g.state) continue;
        await o.remote.putGame(g.id, toGameDoc(g, uid, o.E));
        store.markGameSynced(uid, g.id, g.updatedAt);
      }
      let histChanged = false;
      for (const r of store.dirtyHistory(uid)) {
        await o.remote.putHistory(r.id, toHistoryDoc(r));
        store.markHistorySynced(uid, r.id);
        histChanged = true;
      }
      return histChanged;
    }

    async function profile() {
      await o.remote.putProfile(profileDoc(o.name ? o.name() : '', store.history(uid), o.Stats));
    }

    function guard(fn) {
      if (stopped) return Promise.resolve(false);
      if (running) return running.then(function () { return guard(fn); }); // queue behind the in-flight sync
      setStatus('syncing');
      running = (async function () {
        try {
          const r = await fn();
          setStatus('synced');
          return r;
        } catch (err) {
          const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || /offline|unavailable|network/i.test(String(err && (err.code || err.message)));
          setStatus(offline ? 'offline' : 'error', err);
          return false;
        } finally {
          running = null;
        }
      })();
      return running;
    }

    /** Full two-way sync: deletions, pull + merge, push, history, profile. */
    function syncAll() {
      return guard(async function () {
        {
          for (const id of store.pendingDeletes(uid)) { await o.remote.deleteGame(id); store.clearPendingDelete(uid, id); }
          const games = (await o.remote.listGames()).filter(Boolean);
          const changed = store.applyRemoteGames(uid, games);
          const hist = await o.remote.listHistory();
          const hchanged = store.applyRemoteHistory(uid, hist);
          await pushDirty();
          await profile();
          if ((changed || hchanged) && o.onChange) o.onChange();
          return { changed: changed, history: hchanged };
        }
      });
    }
    /** Push local changes only (cheap; used after moves, debounced). */
    function pushNow() {
      return guard(async function () {
        if (await pushDirty()) await profile();
        return true;
      });
    }
    function schedule(ms) {
      if (stopped) return;
      if (timer) timers.clear(timer);
      timer = timers.set(function () { timer = null; pushNow(); }, ms == null ? (o.debounceMs || 4000) : ms);
    }
    function stop() { stopped = true; if (timer) timers.clear(timer); }
    return { syncAll: syncAll, pushNow: pushNow, schedule: schedule, stop: stop, status: function () { return status; }, idle: function () { return running || Promise.resolve(); } };
  }

  return { SCHEMA: SCHEMA, toGameDoc: toGameDoc, fromGameDoc: fromGameDoc, toHistoryDoc: toHistoryDoc, fromHistoryDoc: fromHistoryDoc, profileDoc: profileDoc, createSync: createSync };
});
