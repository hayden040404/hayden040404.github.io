/* Back Alley — game engine (pure rules + state machine).
 * No DOM, no storage, no timers. Works in the browser (window.BAEngine) and in Node.
 * State is plain JSON so it can be saved, sent over the network (phase 2) and replayed.
 * Scoring is delegated to the scorekeeper's score.js (BackAlley.scoreGame) for exact parity.
 */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../score.js'));
  else root.BAEngine = factory(root.BackAlley);
})(typeof self !== 'undefined' ? self : this, function (BA) {
  const ENGINE_VERSION = 1;
  const SUITS = ['S', 'H', 'D', 'C'];
  const SUIT_KEY = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
  const BIG = 'JB';
  const LITTLE = 'JL';
  const BOARD_MULTS = [2, 4, 6, 8];

  // ---------- cards ----------
  function makeDeck() {
    const d = [];
    SUITS.forEach(function (s) { for (let r = 2; r <= 14; r++) d.push(s + r); });
    d.push(BIG, LITTLE);
    return d;
  }
  function isJoker(c) { return c === BIG || c === LITTLE; }
  function rankOf(c) { return c === BIG ? 16 : c === LITTLE ? 15 : Number(c.slice(1)); }
  /** Suit a card belongs to for following/trump purposes (jokers are trump). */
  function effSuit(c, trump) { return isJoker(c) ? trump : c[0]; }
  /** Strength of a card in a trick with the given led suit. 0 = cannot win. */
  function power(c, trump, led) {
    if (isJoker(c)) return 200 + rankOf(c);
    if (c[0] === trump) return 100 + rankOf(c);
    if (c[0] === led) return rankOf(c);
    return 0;
  }
  function teamOf(seat) { return seat % 2 === 0 ? 'A' : 'B'; }
  function partnerOf(seat) { return (seat + 2) % 4; }

  // ---------- rng (mulberry32, state stored in game state) ----------
  function nextRandom(state) {
    let t = (state.rng = (state.rng + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function shuffle(state, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom(state) * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  // ---------- game setup ----------
  function newGame(opts) {
    opts = opts || {};
    const maxCards = BA.clampMaxCards(opts.maxCards == null ? 13 : opts.maxCards);
    const seed = Number.isFinite(opts.seed) ? (opts.seed | 0) : ((Math.random() * 4294967296) | 0);
    const state = {
      engine: ENGINE_VERSION,
      maxCards: maxCards,
      cardsList: BA.handsCardsFor(maxCards),
      names: (opts.names || ['You', 'Wes', 'Pat', 'Eve']).slice(0, 4),
      teamNames: (opts.teamNames || ['Your team', 'Them']).slice(0, 2),
      firstDealer: 0,
      rng: seed,
      handIndex: 0,
      phase: 'bidding',
      hands: [],
      round: null
    };
    state.firstDealer = Number.isInteger(opts.firstDealer) ? ((opts.firstDealer % 4) + 4) % 4 : Math.floor(nextRandom(state) * 4);
    dealRound(state);
    return state;
  }

  function rainbowEligible(hand, trump, cards) {
    const rb = BA.rainbowFor(cards);
    if (!rb || hand.length !== cards) return false;
    const n = { S: 0, H: 0, D: 0, C: 0 };
    hand.forEach(function (c) { n[effSuit(c, trump)] += 1; });
    return SUITS.every(function (s) { return n[s] === rb.need; });
  }

  function dealRound(state) {
    const cards = state.cardsList[state.handIndex];
    const dealer = (state.firstDealer + state.handIndex) % 4;
    const deck = shuffle(state, makeDeck());
    const hands = [[], [], [], []];
    let k = 0;
    for (let i = 0; i < cards; i++) {
      for (let j = 1; j <= 4; j++) hands[(dealer + j) % 4].push(deck[k++]);
    }
    const rest = deck.slice(k);
    const flipped = [];
    let trump = null;
    let trumpCard = null;
    for (let i = 0; i < rest.length; i++) {
      flipped.push(rest[i]);
      if (!isJoker(rest[i])) { trump = rest[i][0]; trumpCard = rest[i]; break; }
    }
    let trumpFrom = 'flip';
    if (!trump) {
      // Only the two jokers were left undealt (13-card hand): the dealer's last card sets trump.
      trumpCard = hands[dealer][hands[dealer].length - 1];
      trump = trumpCard[0];
      trumpFrom = 'dealer';
    }
    const bidOrder = [1, 2, 3, 4].map(function (j) { return (dealer + j) % 4; });
    state.round = {
      cards: cards,
      dealer: dealer,
      hands: hands,
      flipped: flipped,
      trumpCard: trumpCard,
      trump: trump,
      trumpFrom: trumpFrom,
      bidOrder: bidOrder,
      bidPos: 0,
      bids: [null, null, null, null],
      team: {
        A: { board: 0, boston: false, bostonBid: 0, rainbow: false, caller: null },
        B: { board: 0, boston: false, bostonBid: 0, rainbow: false, caller: null }
      },
      rainbowEligible: hands.map(function (h) { return rainbowEligible(h, trump, cards); }),
      turn: bidOrder[0],
      leader: null,
      trick: [],
      tricks: [],
      took: [0, 0, 0, 0],
      trumpBroken: false
    };
    state.phase = 'bidding';
  }

  // ---------- bidding ----------
  function teamBid(round, team) {
    const t = round.team[team];
    if (t.board) return round.cards;
    if (t.boston) return t.bostonBid;
    const seats = team === 'A' ? [0, 2] : [1, 3];
    return seats.reduce(function (sum, s) { return sum + (round.bids[s] && round.bids[s].value || 0); }, 0);
  }

  /** What a seat may bid right now. */
  function bidOptions(state, seat) {
    const r = state.round;
    if (state.phase !== 'bidding' || r.turn !== seat) return null;
    const team = teamOf(seat);
    const tc = r.team[team];
    const pb = r.bids[partnerOf(seat)];
    const partnerNum = pb && pb.kind === 'num' ? pb.value : 0;
    const rb = BA.rainbowFor(r.cards);
    const max = Math.max(0, r.cards - partnerNum);
    let min = 0;
    if (tc.rainbow && rb) min = Math.min(max, Math.max(0, rb.need - partnerNum));
    const canRainbow = !!(rb && r.rainbowEligible[seat] && !tc.rainbow && !tc.board && !tc.boston);
    return {
      min: min,
      max: max,
      cards: r.cards,
      canBoard: !tc.rainbow,
      boardLevels: BOARD_MULTS.slice(),
      canBoston: r.cards >= 6 && !tc.rainbow,
      bostonMin: 6,
      bostonMax: r.cards,
      canRainbow: canRainbow,
      rainbow: rb ? { key: rb.key, short: rb.short, need: rb.need } : null,
      rainbowMin: canRainbow ? Math.min(max, Math.max(0, rb.need - partnerNum)) : null,
      partnerBid: pb
    };
  }

  /**
   * action: { type:'bid', seat, value, board?: 2|4|6|8, boston?: true, rainbow?: true }
   *  - board: team bids every trick at that multiplier (value ignored).
   *  - boston: value is the team bid (6..cards); the partner does not bid.
   *  - rainbow: value is this player's bid; the team must reach the minimum.
   */
  function validateBid(state, a) {
    const o = bidOptions(state, a.seat);
    if (!o) return 'Not your turn to bid.';
    if (a.board) {
      if (!o.canBoard) return 'Board can’t be combined with a rainbow.';
      if (BOARD_MULTS.indexOf(a.board) < 0) return 'Unknown board level.';
      return null;
    }
    if (!Number.isInteger(a.value)) return 'Bid must be a whole number.';
    if (a.boston) {
      if (!o.canBoston) return 'Boston needs 6 or more cards.';
      if (a.value < 6 || a.value > o.cards) return 'Boston bid must be 6 to ' + o.cards + '.';
      return null;
    }
    if (a.rainbow) {
      if (!o.canRainbow) return 'Not a rainbow hand.';
      if (a.value < o.rainbowMin || a.value > o.max) return o.rainbow.short + ' bid must be ' + o.rainbowMin + ' to ' + o.max + '.';
      return null;
    }
    if (a.value < o.min || a.value > o.max) return 'Bid must be ' + o.min + ' to ' + o.max + '.';
    return null;
  }

  function applyBid(state, a) {
    const r = state.round;
    const tc = r.team[teamOf(a.seat)];
    if (a.board) {
      tc.board = a.board;
      tc.boston = false;
      r.bids[a.seat] = { kind: 'board', value: r.cards, level: a.board };
    } else if (a.boston) {
      tc.boston = true;
      tc.bostonBid = a.value;
      r.bids[a.seat] = { kind: 'boston', value: a.value };
    } else {
      if (a.rainbow) { tc.rainbow = true; tc.caller = a.seat; }
      r.bids[a.seat] = { kind: 'num', value: a.value, rainbow: !!a.rainbow };
    }
    advanceBidding(state);
  }

  function advanceBidding(state) {
    const r = state.round;
    r.bidPos += 1;
    while (r.bidPos < 4) {
      const s = r.bidOrder[r.bidPos];
      const tc = r.team[teamOf(s)];
      if (tc.board || tc.boston) {
        r.bids[s] = { kind: 'partner', value: 0 };
        r.bidPos += 1;
        continue;
      }
      r.turn = s;
      return;
    }
    // Everyone has bid: the highest individual bid leads (ties go to whoever bid it first).
    let best = -1;
    let leader = r.bidOrder[0];
    r.bidOrder.forEach(function (s) {
      const b = r.bids[s];
      const v = b.kind === 'partner' ? -1 : b.value;
      if (v > best) { best = v; leader = s; }
    });
    r.leader = leader;
    r.turn = leader;
    state.phase = 'playing';
  }

  // ---------- play ----------
  function ledSuit(r) { return r.trick.length ? effSuit(r.trick[0].card, r.trump) : null; }

  function legalCards(state, seat) {
    const r = state.round;
    if (state.phase !== 'playing' || r.turn !== seat) return [];
    const hand = r.hands[seat];
    const led = ledSuit(r);
    if (!led) {
      if (r.trumpBroken) return hand.slice();
      const nonTrump = hand.filter(function (c) { return effSuit(c, r.trump) !== r.trump; });
      return nonTrump.length ? nonTrump : hand.slice();
    }
    const follow = hand.filter(function (c) { return effSuit(c, r.trump) === led; });
    return follow.length ? follow : hand.slice();
  }

  function trickWinner(trick, trump) {
    const led = effSuit(trick[0].card, trump);
    let best = trick[0];
    let bestP = power(best.card, trump, led);
    for (let i = 1; i < trick.length; i++) {
      const p = power(trick[i].card, trump, led);
      if (p > bestP) { best = trick[i]; bestP = p; }
    }
    return best.seat;
  }

  function applyPlay(state, a) {
    const r = state.round;
    const hand = r.hands[a.seat];
    hand.splice(hand.indexOf(a.card), 1);
    if (effSuit(a.card, r.trump) === r.trump) r.trumpBroken = true;
    r.trick.push({ seat: a.seat, card: a.card });
    if (r.trick.length < 4) {
      r.turn = (a.seat + 1) % 4;
      return;
    }
    const winner = trickWinner(r.trick, r.trump);
    r.tricks.push({ leader: r.trick[0].seat, cards: r.trick, winner: winner });
    r.took[winner] += 1;
    r.trick = [];
    r.turn = winner;
    if (r.hands.every(function (h) { return h.length === 0; })) finishRound(state);
  }

  function bostonMadeFor(r, team) {
    if (!r.team[team].boston) return null;
    if (r.tricks.length < 6) return false;
    for (let i = 0; i < 6; i++) if (teamOf(r.tricks[i].winner) !== team) return false;
    return true;
  }

  /** The finished round in the scorekeeper's hand format (score.js scores it). */
  function roundRecord(state) {
    const r = state.round;
    const A = r.team.A;
    const B = r.team.B;
    return {
      cards: r.cards,
      trump: SUIT_KEY[r.trump],
      aBid: teamBid(r, 'A'),
      aTook: r.took[0] + r.took[2],
      bBid: teamBid(r, 'B'),
      bTook: r.took[1] + r.took[3],
      aBoard: A.board || 0,
      bBoard: B.board || 0,
      aBoston: !!A.boston,
      bBoston: !!B.boston,
      aBostonMade: bostonMadeFor(r, 'A'),
      bBostonMade: bostonMadeFor(r, 'B'),
      aRainbow: !!A.rainbow,
      bRainbow: !!B.rainbow,
      recorded: true,
      dealer: r.dealer,
      seatBids: r.bids.map(function (b) { return b ? b.value : null; }),
      seatTook: r.took.slice()
    };
  }

  function finishRound(state) {
    state.hands.push(roundRecord(state));
    state.phase = 'roundEnd';
  }

  function nextRound(state) {
    state.handIndex += 1;
    if (state.handIndex >= state.cardsList.length) {
      state.phase = 'gameOver';
      return;
    }
    dealRound(state);
  }

  // ---------- public reducer ----------
  function validate(state, a) {
    if (!a || typeof a !== 'object') return 'Bad action.';
    if (a.type === 'bid') {
      if (state.phase !== 'bidding') return 'Not bidding now.';
      return validateBid(state, a);
    }
    if (a.type === 'play') {
      if (state.phase !== 'playing') return 'Not playing now.';
      if (state.round.turn !== a.seat) return 'Not your turn.';
      if (legalCards(state, a.seat).indexOf(a.card) < 0) return 'That card can’t be played now.';
      return null;
    }
    if (a.type === 'next') return state.phase === 'roundEnd' ? null : 'Round not finished.';
    return 'Unknown action.';
  }

  /** Returns a new state (or mutates when opts.mutate). Throws on illegal actions. */
  function apply(state, a, opts) {
    const err = validate(state, a);
    if (err) throw new Error(err);
    const s = opts && opts.mutate ? state : clone(state);
    if (a.type === 'bid') applyBid(s, a);
    else if (a.type === 'play') applyPlay(s, a);
    else if (a.type === 'next') nextRound(s);
    return s;
  }

  function score(state) { return BA.scoreGame(state.hands); }

  /** Who the game is waiting on: a seat number, or null when it’s between rounds/over. */
  function waitingOn(state) {
    if (state.phase === 'bidding' || state.phase === 'playing') return state.round.turn;
    return null;
  }

  /** What one seat is allowed to see (for online play): other hands become counts. */
  function viewFor(state, seat) {
    const v = clone(state);
    if (v.round) {
      v.round.hands = v.round.hands.map(function (h, i) { return i === seat ? h : h.length; });
      v.round.rainbowEligible = v.round.rainbowEligible.map(function (e, i) { return i === seat ? e : null; });
    }
    delete v.rng;
    return v;
  }

  return {
    ENGINE_VERSION: ENGINE_VERSION,
    SUITS: SUITS,
    SUIT_KEY: SUIT_KEY,
    BIG: BIG,
    LITTLE: LITTLE,
    BOARD_MULTS: BOARD_MULTS,
    makeDeck: makeDeck,
    isJoker: isJoker,
    rankOf: rankOf,
    effSuit: effSuit,
    power: power,
    teamOf: teamOf,
    partnerOf: partnerOf,
    newGame: newGame,
    rainbowEligible: rainbowEligible,
    teamBid: teamBid,
    bidOptions: bidOptions,
    legalCards: legalCards,
    ledSuit: ledSuit,
    trickWinner: trickWinner,
    validate: validate,
    apply: apply,
    score: score,
    waitingOn: waitingOn,
    viewFor: viewFor,
    roundRecord: roundRecord,
    clone: clone,
    scorer: BA
  };
});
