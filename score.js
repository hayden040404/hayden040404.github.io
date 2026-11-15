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

function handMeta(index) {
  const cards = HANDS_CARDS[index];
  const river = index <= 12 ? 'down' : 'up';
  const shortLabel = cards === 1 ? (river === 'down' ? '1 ↓' : '1 ↑') : String(cards);
  return {
    index: index,
    cards: cards,
    river: river,
    shortLabel: shortLabel,
    handNumber: index + 1,
    totalHands: HANDS_CARDS.length
  };
}

function createHands() {
  return HANDS_CARDS.map(function (_, i) {
    const meta = handMeta(i);
    return {
      cards: meta.cards,
      trump: null,
      aBid: null,
      aTook: null,
      bBid: null,
      bTook: null
    };
  });
}

function isFilled(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function isHandComplete(hand) {
  return isFilled(hand.aBid) && isFilled(hand.aTook) && isFilled(hand.bBid) && isFilled(hand.bTook);
}

/**
 * Score one team for a single hand.
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
      made: true
    };
  }
  return {
    pts: -10 * bid,
    bagsAfter: bagsBefore,
    bagsThisHand: 0,
    penalty: false,
    penaltyCount: 0,
    made: false
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
        a: { pts: null, total: aTotal, bags: aBags, penalty: false, penaltyCount: 0, made: null, bagsThisHand: 0 },
        b: { pts: null, total: bTotal, bags: bBags, penalty: false, penaltyCount: 0, made: null, bagsThisHand: 0 },
        warnings: []
      };
    }
    const trickCheck = validateTricks(hand.cards, hand.aTook, hand.bTook);
    const a = scoreHand(Number(hand.aBid), Number(hand.aTook), aBags);
    const b = scoreHand(Number(hand.bBid), Number(hand.bTook), bBags);
    aTotal += a.pts;
    bTotal += b.pts;
    aBags = a.bagsAfter;
    bBags = b.bagsAfter;
    return {
      complete: true,
      a: Object.assign({}, a, { total: aTotal, bags: aBags }),
      b: Object.assign({}, b, { total: bTotal, bags: bBags }),
      warnings: trickCheck.warnings
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
  handMeta: handMeta,
  createHands: createHands,
  isFilled: isFilled,
  isHandComplete: isHandComplete,
  scoreHand: scoreHand,
  validateTricks: validateTricks,
  validateBids: validateBids,
  scoreGame: scoreGame,
  firstIncompleteIndex: firstIncompleteIndex
};

if (typeof module === 'object' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.BackAlley = api;
}
