/* Back Alley Play — stats and achievements. Pure functions, no DOM, no Firebase.
 * A finished game becomes one compact "history record" (gameRecord). Lifetime stats and
 * achievements are always DERIVED from the list of history records, so syncing them across
 * devices is just syncing the records (merge = union by game id; no double counting).
 * The player's own team is team A (seat 0 + partner seat 2) in solo games; `seat` is stored
 * so online games (any seat) can reuse the same record format later.
 */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BAStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SCHEMA = 1;
  const COUNTERS = ['hands', 'bidsMade', 'bidsSet', 'oppSet', 'boardsBid', 'boardsMade', 'boardsSet',
    'doubleBoardsMade', 'tripleBoardsMade', 'quadBoardsMade', 'oppBoardsSet', 'rainbowsBid', 'rainbowsMade',
    'bostonsBid', 'bostonsMade', 'bagPenalties', 'teamTricks', 'myTricks', 'myBidsMade', 'maxTrail', 'maxLead'];

  /** Build the history record for a finished (gameOver) engine state. */
  function gameRecord(state, meta, E) {
    meta = meta || {};
    const seat = meta.seat || 0;
    const mine = seat % 2 === 0 ? 'a' : 'b';
    const theirs = mine === 'a' ? 'b' : 'a';
    const sc = E.score(state);
    const c = {};
    COUNTERS.forEach(function (k) { c[k] = 0; });
    state.hands.forEach(function (h, i) {
      const res = sc.results[i];
      if (!res || !res.complete) return;
      const me = res[mine];
      const them = res[theirs];
      const myBoard = h[mine + 'Board'] || 0;
      const theirBoard = h[theirs + 'Board'] || 0;
      c.hands += 1;
      if (me.made) c.bidsMade += 1; else c.bidsSet += 1;
      if (!them.made) c.oppSet += 1;
      if (myBoard) {
        c.boardsBid += 1;
        if (me.made) {
          c.boardsMade += 1;
          if (myBoard >= 4) c.doubleBoardsMade += 1;
          if (myBoard >= 6) c.tripleBoardsMade += 1;
          if (myBoard >= 8) c.quadBoardsMade += 1;
        } else c.boardsSet += 1;
      }
      if (theirBoard && !them.made) c.oppBoardsSet += 1;
      if (h[mine + 'Rainbow']) { c.rainbowsBid += 1; if (me.made) c.rainbowsMade += 1; }
      if (h[mine + 'Boston']) { c.bostonsBid += 1; if (h[mine + 'BostonMade']) c.bostonsMade += 1; }
      c.bagPenalties += me.penaltyCount || 0;
      c.teamTricks += h[mine + 'Took'] || 0;
      if (h.seatTook) c.myTricks += h.seatTook[seat] || 0;
      if (h.seatBids && h.seatTook && h.seatBids[seat] != null && h.seatTook[seat] >= h.seatBids[seat]) c.myBidsMade += 1;
      const diff = me.total - them.total;
      if (-diff > c.maxTrail) c.maxTrail = -diff;
      if (diff > c.maxLead) c.maxLead = diff;
    });
    const us = mine === 'a' ? sc.aTotal : sc.bTotal;
    const them = mine === 'a' ? sc.bTotal : sc.aTotal;
    return {
      schema: SCHEMA,
      id: meta.id,
      mode: meta.mode || 'solo',
      seat: seat,
      startedAt: meta.startedAt || 0,
      finishedAt: meta.finishedAt || 0,
      maxCards: state.maxCards,
      handsTotal: state.cardsList.length,
      us: us,
      them: them,
      won: us > them,
      tied: us === them,
      counters: c
    };
  }

  function byFinish(a, b) { return (a.finishedAt - b.finishedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

  function emptyStats() {
    const s = { games: 0, wins: 0, losses: 0, ties: 0, winPct: 0, streak: 0, bestStreak: 0, highScore: null, bestMargin: null, fullGames: 0 };
    COUNTERS.forEach(function (k) { s[k] = 0; });
    s.maxTrail = 0; s.maxLead = 0;
    return s;
  }

  function addRecord(s, r) {
    s.games += 1;
    if (r.won) { s.wins += 1; s.streak += 1; if (s.streak > s.bestStreak) s.bestStreak = s.streak; }
    else { s.streak = 0; if (r.tied) s.ties += 1; else s.losses += 1; }
    s.winPct = Math.round((100 * s.wins) / s.games);
    if (s.highScore === null || r.us > s.highScore) s.highScore = r.us;
    if (r.won && (s.bestMargin === null || r.us - r.them > s.bestMargin)) s.bestMargin = r.us - r.them;
    if (r.maxCards >= 13) s.fullGames += 1;
    COUNTERS.forEach(function (k) {
      const v = (r.counters && r.counters[k]) || 0;
      if (k === 'maxTrail' || k === 'maxLead') { if (v > s[k]) s[k] = v; } else s[k] += v;
    });
    return s;
  }

  /** Lifetime stats from any list of history records (order-independent input). */
  function computeStats(records) {
    return dedupe(records).sort(byFinish).reduce(addRecord, emptyStats());
  }

  function dedupe(records) {
    const seen = {};
    const out = [];
    (records || []).forEach(function (r) { if (r && r.id && !seen[r.id]) { seen[r.id] = 1; out.push(r); } });
    return out;
  }

  // test(stats so far, the record that was just added) -> unlocked?
  const ACHIEVEMENTS = [
    { id: 'first_game', icon: '🪑', name: 'Pull Up a Chair', desc: 'Finish your first game', test: function (s) { return s.games >= 1; } },
    { id: 'first_win', icon: '🏆', name: 'First Win', desc: 'Win a game', test: function (s) { return s.wins >= 1; } },
    { id: 'streak3', icon: '🔥', name: 'Hot Hand', desc: 'Win 3 games in a row', test: function (s) { return s.bestStreak >= 3; } },
    { id: 'streak5', icon: '☄️', name: 'On Fire', desc: 'Win 5 games in a row', test: function (s) { return s.bestStreak >= 5; } },
    { id: 'games10', icon: '🃏', name: 'Regular', desc: 'Finish 10 games', test: function (s) { return s.games >= 10; } },
    { id: 'wins10', icon: '🐈‍⬛', name: 'Alley Cat', desc: 'Win 10 games', test: function (s) { return s.wins >= 10; } },
    { id: 'hands100', icon: '🦈', name: 'Card Shark', desc: 'Play 100 hands', test: function (s) { return s.hands >= 100; } },
    { id: 'full_deck', icon: '📦', name: 'Full Deck', desc: 'Finish a full 13-card game', test: function (s) { return s.fullGames >= 1; } },
    { id: 'board_made', icon: '🛹', name: 'On Board', desc: 'Make a Board', test: function (s) { return s.boardsMade >= 1; } },
    { id: 'double_board', icon: '✌️', name: 'Double Trouble', desc: 'Make a Double Board (x4)', test: function (s) { return s.doubleBoardsMade >= 1; } },
    { id: 'triple_board', icon: '🔱', name: 'Triple Threat', desc: 'Make a Triple Board (x6)', test: function (s) { return s.tripleBoardsMade >= 1; } },
    { id: 'quad_board', icon: '👑', name: 'Quad Board', desc: 'Make a Quad Board (x8)', test: function (s) { return s.quadBoardsMade >= 1; } },
    { id: 'board_buster', icon: '🪓', name: 'Board Buster', desc: 'Set the other team’s Board', test: function (s) { return s.oppBoardsSet >= 1; } },
    { id: 'rainbow', icon: '🌈', name: 'Over the Rainbow', desc: 'Make a Rainbow', test: function (s) { return s.rainbowsMade >= 1; } },
    { id: 'boston', icon: '🫖', name: 'Boston Tea Party', desc: 'Make a Boston', test: function (s) { return s.bostonsMade >= 1; } },
    { id: 'spotless', icon: '✨', name: 'Spotless', desc: 'Win a game without your team ever being set', test: function (s, r) { return r.won && r.counters.bidsSet === 0; } },
    { id: 'spoiler', icon: '🧨', name: 'Spoiler', desc: 'Set the other team 5 times in one game', test: function (s, r) { return r.counters.oppSet >= 5; } },
    { id: 'comeback', icon: '🔄', name: 'Comeback Kid', desc: 'Win after trailing by 100 or more', test: function (s, r) { return r.won && r.counters.maxTrail >= 100; } },
    { id: 'blowout', icon: '💥', name: 'Blowout', desc: 'Win a game by 200 or more', test: function (s, r) { return r.won && r.us - r.them >= 200; } },
    { id: 'bag_free', icon: '🧹', name: 'No Bags', desc: 'Win a game without a bag penalty', test: function (s, r) { return r.won && r.counters.bagPenalties === 0; } }
  ];

  /** Every achievement with unlocked flag and the time of the game that first earned it. */
  function computeAchievements(records) {
    const recs = dedupe(records).sort(byFinish);
    const s = emptyStats();
    const when = {};
    recs.forEach(function (r) {
      addRecord(s, r);
      ACHIEVEMENTS.forEach(function (a) {
        if (!when[a.id] && a.test(s, r)) when[a.id] = { at: r.finishedAt, gameId: r.id };
      });
    });
    return ACHIEVEMENTS.map(function (a) {
      return { id: a.id, icon: a.icon, name: a.name, desc: a.desc, unlocked: !!when[a.id], at: when[a.id] ? when[a.id].at : null, gameId: when[a.id] ? when[a.id].gameId : null };
    });
  }

  /** Achievements newly unlocked by adding `rec` to `records`. */
  function newlyUnlocked(records, rec) {
    const before = {};
    computeAchievements(records.filter(function (r) { return r.id !== rec.id; })).forEach(function (a) { before[a.id] = a.unlocked; });
    return computeAchievements(records.concat([rec])).filter(function (a) { return a.unlocked && !before[a.id]; });
  }

  return { SCHEMA: SCHEMA, COUNTERS: COUNTERS, ACHIEVEMENTS: ACHIEVEMENTS, gameRecord: gameRecord, computeStats: computeStats, computeAchievements: computeAchievements, newlyUnlocked: newlyUnlocked };
});
