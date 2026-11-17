'use strict';

/**
 * Back Alley scoring — pure functions, no DOM or storage.
 * Works in the browser and in Node.
 */
const HANDS_CARDS = Object.freeze([
  13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
]);

const SUITS = Object.freeze(['spades', 'hearts', 'diamonds', 'clubs']);

const BOARD_LEVELS = Object.freeze([
  { mult: 0, key: 'none', short: 'None', badge: '' },
  { mult: 2, key: 'board', short: 'Board', badge: 'BOARD x2' },
  { mult: 4, key: 'double', short: 'Double', badge: 'DOUBLE BOARD x4' },
  { mult: 6, key: 'triple', short: 'Triple', badge: 'TRIPLE BOARD x6' },
  { mult: 8, key: 'quadruple', short: 'Quad', badge: 'QUADRUPLE BOARD x8' }
]);

const BOARD_MULTS = Object.freeze([0, 2, 4, 6, 8]);

/**
 * Rainbow contracts, keyed by card count.
 * Rainbow (4-card hand): one of each suit. Double Rainbow (8-card hand): exactly two of each suit.
 * A joker counts as the trump suit. Required tricks are worth 20 each, every trick after that 10.
 */
const RAINBOWS = Object.freeze({
  4: Object.freeze({ cards: 4, need: 1, key: 'rainbow', short: 'Rainbow', badge: 'RAINBOW' }),
  8: Object.freeze({ cards: 8, need: 2, key: 'double-rainbow', short: 'Double Rainbow', badge: 'DOUBLE RAINBOW' })
});

function rainbowFor(cards) {
  return RAINBOWS[Number(cards)] || null;
}

function clampMaxCards(n) {
  if (n == null || n === '') return 13;
  n = Number(n);
  if (!Number.isFinite(n)) return 13;
  return Math.max(1, Math.min(13, Math.round(n)));
}

function handsCardsFor(maxCards) {
  const size = clampMaxCards(maxCards);
  const cards = [];
  let i;
  for (i = size; i >= 1; i--) cards.push(i);
  for (i = 1; i <= size; i++) cards.push(i);
  return cards;
}

function handMeta(index, cardsOrMax) {
  let list;
  if (Array.isArray(cardsOrMax)) list = cardsOrMax;
  else if (cardsOrMax != null && cardsOrMax !== '') list = handsCardsFor(cardsOrMax);
  else list = HANDS_CARDS;
  const cards = list[index];
  const top = list.length / 2;
  const river = index < top ? 'down' : 'up';
  const shortLabel = cards === 1 ? (river === 'down' ? '1 ↓' : '1 ↑') : String(cards);
  return {
    index: index,
    cards: cards,
    river: river,
    shortLabel: shortLabel,
    handNumber: index + 1,
    totalHands: list.length,
    maxCards: top
  };
}

function createHands(maxCards) {
  const list = handsCardsFor(maxCards == null ? 13 : maxCards);
  return list.map(function (_, i) {
    const meta = handMeta(i, list);
    return {
      cards: meta.cards,
      trump: null,
      aBid: null,
      aTook: null,
      bBid: null,
      bTook: null,
      aBoard: 0,
      bBoard: 0,
      aBoston: false,
      bBoston: false,
      aBostonMade: null,
      bBostonMade: null,
      aRainbow: false,
      bRainbow: false
    };
  });
}

function isFilled(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function normalizeBoard(value) {
  const n = Number(value);
  return BOARD_MULTS.indexOf(n) >= 0 ? n : 0;
}

function boardBadge(mult) {
  const level = BOARD_LEVELS.find(function (l) { return l.mult === normalizeBoard(mult); });
  return level && level.badge ? level.badge : '';
}

function contractBadge(hand, side) {
  const rb = hand[side + 'Rainbow'] ? rainbowFor(hand.cards) : null;
  if (rb) return rb.badge;
  if (hand[side + 'Boston']) return 'BOSTON';
  return boardBadge(hand[side + 'Board']);
}

function bostonAnswered(hand, side) {
  if (!hand[side + 'Boston']) return true;
  return hand[side + 'BostonMade'] === true || hand[side + 'BostonMade'] === false;
}

function isHandComplete(hand) {
  return isFilled(hand.aBid) && isFilled(hand.aTook) && isFilled(hand.bBid) && isFilled(hand.bTook)
    && bostonAnswered(hand, 'a') && bostonAnswered(hand, 'b');
}

/**
 * Score one team for a single normal (non-board, non-Boston) hand.
 * Making the bid: +10 per trick bid, +1 per extra trick (a bag).
 * Getting set (took < bid): -10 per trick bid, bags unchanged.
 * Each time bags reach 10: -100 and subtract 10 bags (can happen more than once).
 */
function scoreHand(bid, took, bagsBefore) {
  if (!Number.isFinite(bid) || !Number.isFinite(took) || !Number.isFinite(bagsBefore)) {
    throw new TypeError('scoreHand requires finite numbers');
  }
  if (took >= bid) {
    const bagsThisHand = took - bid;
    let pts = bid * 10 + bagsThisHand;
    let bags = bagsBefore + bagsThisHand;
    let penaltyCount = 0;
    while (bags >= 10) {
      pts -= 100;
      bags -= 10;
      penaltyCount += 1;
    }
    return {
      pts: pts,
      bagsAfter: bags,
      bagsThisHand: bagsThisHand,
      penalty: penaltyCount > 0,
      penaltyCount: penaltyCount,
      made: true,
      contract: 'normal'
    };
  }
  return {
    pts: -10 * bid,
    bagsAfter: bagsBefore,
    bagsThisHand: 0,
    penalty: false,
    penaltyCount: 0,
    made: false,
    contract: 'normal'
  };
}

/**
 * Score one team for a hand, including Board and Boston contracts.
 * opts: { bid, took, bagsBefore, cards, board, boston, bostonMade }
 */
function scoreTeamHand(opts) {
  const bid = Number(opts.bid);
  const took = Number(opts.took);
  const bagsBefore = Number(opts.bagsBefore);
  const cards = Number(opts.cards);
  const board = normalizeBoard(opts.board);
  const boston = !!opts.boston && cards >= 6;
  const bostonMade = opts.bostonMade === true;
  const rainbow = opts.rainbow ? rainbowFor(cards) : null;

  if (rainbow) {
    // Rainbow sets a minimum team bid of 1 (Double Rainbow: 2); the team may bid more.
    // Made (took >= bid): +20 per required trick, +10 per other bid trick,
    //   +1 per trick over the bid (a bag, with the normal 10-bag -100 penalty).
    // Set (took < bid): minus what the bid would have earned: -(20*need + 10*(bid-need)). Bags unchanged.
    const need = rainbow.need;
    const rbBid = Math.max(need, Number.isFinite(bid) ? bid : need);
    const made = took >= rbBid;
    const bidValue = 20 * need + 10 * (rbBid - need);
    const bagsThisHand = made ? took - rbBid : 0;
    let pts = made ? bidValue + bagsThisHand : -bidValue;
    let bags = bagsBefore + bagsThisHand;
    let penaltyCount = 0;
    while (bags >= 10) {
      pts -= 100;
      bags -= 10;
      penaltyCount += 1;
    }
    return {
      pts: pts,
      bagsAfter: bags,
      bagsThisHand: bagsThisHand,
      penalty: penaltyCount > 0,
      penaltyCount: penaltyCount,
      made: made,
      contract: rainbow.key,
      board: 0,
      bostonMade: null,
      badge: rainbow.badge
    };
  }

  if (board) {
    const made = took >= cards;
    const pts = (made ? 1 : -1) * board * 10 * cards;
    return {
      pts: pts,
      bagsAfter: bagsBefore,
      bagsThisHand: 0,
      penalty: false,
      penaltyCount: 0,
      made: made,
      contract: 'board',
      board: board,
      bostonMade: null,
      badge: boardBadge(board)
    };
  }

  if (boston) {
    // Boston is a bid of 6 or more. You must take the first 6 and at least the bid.
    // Made: +120 + 10*(bid-6) + 1 per trick over the bid (bags).
    // Failed (missed first 6, or took < bid): -20*bid, no bag points.
    // Bags = max(0, took - bid) and count toward the 10-bag -100 penalty either way.
    const effectiveBid = Math.max(6, bid);
    const bagsThisHand = Math.max(0, took - effectiveBid);
    const made = bostonMade === true && took >= effectiveBid;
    let bags = bagsBefore + bagsThisHand;
    let penaltyCount = 0;
    let pts = made
      ? 120 + 10 * (effectiveBid - 6) + bagsThisHand
      : -20 * effectiveBid;
    while (bags >= 10) {
      pts -= 100;
      bags -= 10;
      penaltyCount += 1;
    }
    return {
      pts: pts,
      bagsAfter: bags,
      bagsThisHand: bagsThisHand,
      penalty: penaltyCount > 0,
      penaltyCount: penaltyCount,
      made: made,
      contract: 'boston',
      board: 0,
      bostonMade: bostonMade === true,
      badge: 'BOSTON'
    };
  }

  const normal = scoreHand(bid, took, bagsBefore);
  return Object.assign({}, normal, { board: 0, bostonMade: null, badge: '' });
}

function teamOpts(hand, side, bagsBefore) {
  return {
    bid: hand[side + 'Bid'],
    took: hand[side + 'Took'],
    bagsBefore: bagsBefore,
    cards: hand.cards,
    board: hand[side + 'Board'],
    boston: hand[side + 'Boston'],
    bostonMade: hand[side + 'BostonMade'],
    rainbow: hand[side + 'Rainbow']
  };
}

/**
 * Validate tricks taken against the number of cards in the hand.
 * Tricks for a team may not exceed the card count, and the two teams'
 * tricks must sum exactly to the card count.
 */
function validateTricks(cards, aTook, bTook) {
  const warnings = [];
  if (!Number.isFinite(cards) || cards < 0) {
    warnings.push('Invalid card count.');
    return { ok: false, warnings: warnings };
  }
  const a = Number(aTook);
  const b = Number(bTook);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    warnings.push('Both teams need a tricks-taken number.');
    return { ok: false, warnings: warnings };
  }
  if (a < 0 || b < 0) warnings.push('Tricks taken cannot be negative.');
  if (a > cards) warnings.push('Team A took more tricks than there are cards.');
  if (b > cards) warnings.push('Team B took more tricks than there are cards.');
  if (a + b !== cards) {
    warnings.push('Tricks taken (' + (a + b) + ') must equal the ' + cards + ' card' + (cards === 1 ? '' : 's') + ' in this hand.');
  }
  return { ok: warnings.length === 0, warnings: warnings };
}

function validateBids(cards, aBid, bBid) {
  const warnings = [];
  const a = Number(aBid);
  const b = Number(bBid);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    warnings.push('Both teams need a bid.');
    return { ok: false, warnings: warnings };
  }
  if (a < 0 || b < 0) warnings.push('Bids cannot be negative.');
  if (a > cards) warnings.push('Team A bid more than the cards in this hand.');
  if (b > cards) warnings.push('Team B bid more than the cards in this hand.');
  return { ok: warnings.length === 0, warnings: warnings };
}

function validateContracts(hand) {
  const warnings = [];
  const cards = Number(hand.cards);
  ['a', 'b'].forEach(function (side, i) {
    const team = i === 0 ? 'Team A' : 'Team B';
    const board = normalizeBoard(hand[side + 'Board']);
    const boston = !!hand[side + 'Boston'];
    const took = isFilled(hand[side + 'Took']) ? Number(hand[side + 'Took']) : null;
    const bid = isFilled(hand[side + 'Bid']) ? Number(hand[side + 'Bid']) : null;
    if (board && boston) warnings.push(team + ' can’t bid Board and Boston on the same hand.');
    if (hand[side + 'Rainbow']) {
      const rb = rainbowFor(cards);
      if (!rb) warnings.push(team + ' can only call Rainbow on a 4-card hand or Double Rainbow on an 8-card hand.');
      else {
        if (board || boston) warnings.push(team + ' can’t combine ' + rb.short + ' with Board or Boston.');
        if (bid !== null && bid < rb.need) warnings.push(team + ' called ' + rb.short + ', so the bid has to be at least ' + rb.need + '.');
      }
    }
    if (boston && cards < 6) warnings.push(team + ' can’t bid Boston on a hand with fewer than 6 cards.');
    if (boston && !bostonAnswered(hand, side)) warnings.push('Say whether ' + team + ' took the first 6 tricks.');
    if (boston && hand[side + 'BostonMade'] === true && took !== null && took < 6) {
      warnings.push(team + ' can’t have taken the first 6 with only ' + took + ' trick' + (took === 1 ? '' : 's') + ' total.');
    }
    if (boston && hand[side + 'BostonMade'] === false && took !== null && took === cards && cards >= 6) {
      warnings.push(team + ' took every trick, so they also took the first 6.');
    }
    if (board && bid !== null && bid !== cards) {
      warnings.push(team + ' boarded, so the bid should be all ' + cards + ' tricks.');
    }
    if (boston && bid !== null && (bid < 6 || bid > cards) && cards >= 6) {
      warnings.push(team + ' declared Boston, so the bid should be 6 to ' + cards + '.');
    }
  });
  if (hand.aBostonMade === true && hand.bBostonMade === true) {
    warnings.push('Both teams can’t have taken the first 6 tricks.');
  }
  return { ok: warnings.length === 0, warnings: warnings };
}

/**
 * Walk every hand in order and return per-hand results plus running totals.
 * Incomplete hands are skipped for scoring (running totals carry through).
 */
function scoreGame(hands) {
  let aBags = 0;
  let bBags = 0;
  let aTotal = 0;
  let bTotal = 0;
  const results = (hands || []).map(function (hand) {
    if (!isHandComplete(hand)) {
      return {
        complete: false,
        a: { pts: null, total: aTotal, bags: aBags, penalty: false, penaltyCount: 0, made: null, bagsThisHand: 0, contract: null, badge: '' },
        b: { pts: null, total: bTotal, bags: bBags, penalty: false, penaltyCount: 0, made: null, bagsThisHand: 0, contract: null, badge: '' },
        warnings: []
      };
    }
    const trickCheck = validateTricks(hand.cards, hand.aTook, hand.bTook);
    const contractCheck = validateContracts(hand);
    const a = scoreTeamHand(teamOpts(hand, 'a', aBags));
    const b = scoreTeamHand(teamOpts(hand, 'b', bBags));
    aTotal += a.pts;
    bTotal += b.pts;
    aBags = a.bagsAfter;
    bBags = b.bagsAfter;
    return {
      complete: true,
      a: Object.assign({}, a, { total: aTotal, bags: aBags }),
      b: Object.assign({}, b, { total: bTotal, bags: bBags }),
      warnings: trickCheck.warnings.concat(contractCheck.warnings)
    };
  });

  let leader = 'tie';
  if (aTotal > bTotal) leader = 'A';
  else if (bTotal > aTotal) leader = 'B';

  return {
    results: results,
    aTotal: aTotal,
    bTotal: bTotal,
    aBags: aBags,
    bBags: bBags,
    leader: leader,
    completeCount: results.filter(function (r) { return r.complete; }).length
  };
}

function firstIncompleteIndex(hands) {
  for (let i = 0; i < hands.length; i++) {
    if (!isHandComplete(hands[i])) return i;
  }
  return -1;
}

const api = {
  HANDS_CARDS: HANDS_CARDS,
  SUITS: SUITS,
  BOARD_LEVELS: BOARD_LEVELS,
  BOARD_MULTS: BOARD_MULTS,
  RAINBOWS: RAINBOWS,
  rainbowFor: rainbowFor,
  clampMaxCards: clampMaxCards,
  handsCardsFor: handsCardsFor,
  handMeta: handMeta,
  createHands: createHands,
  isFilled: isFilled,
  isHandComplete: isHandComplete,
  normalizeBoard: normalizeBoard,
  boardBadge: boardBadge,
  contractBadge: contractBadge,
  scoreHand: scoreHand,
  scoreTeamHand: scoreTeamHand,
  validateTricks: validateTricks,
  validateBids: validateBids,
  validateContracts: validateContracts,
  scoreGame: scoreGame,
  firstIncompleteIndex: firstIncompleteIndex
};

if (typeof module === 'object' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.BackAlley = api;
}
