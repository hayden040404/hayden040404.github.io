/* Back Alley — computer players. Pure functions over engine state; no DOM.
 * Bidding: estimate likely tricks from jokers, trump honors and length, off-suit aces/kings
 * and short suits, scaled by how many cards are actually in play this hand.
 * Play: follow suit, win as cheaply as possible when the team still needs tricks, let a
 * winning partner have the trick, shed high cards (duck) once the bid is made unless
 * setting the other team is realistic.
 */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.BAAI = factory(root.BAEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  const SUITS = E.SUITS;

  function inPlayShare(cards) { return Math.min(1, (3 * cards) / (54 - cards)); }

  function allOfSuit(suit, trump) {
    const list = [];
    for (let r = 2; r <= 14; r++) list.push(suit + r);
    if (suit === trump) list.push(E.LITTLE, E.BIG);
    return list;
  }

  /** Estimated tricks this hand will take (fractional). */
  function estimateTricks(hand, trump, cards) {
    const q = inPlayShare(cards);
    const bySuit = { S: [], H: [], D: [], C: [] };
    hand.forEach(function (c) { bySuit[E.effSuit(c, trump)].push(c); });
    SUITS.forEach(function (s) { bySuit[s].sort(function (a, b) { return E.power(b, trump, s) - E.power(a, trump, s); }); });
    let est = 0;
    let trumpWinners = 0;
    const trumps = bySuit[trump];
    const tLen = trumps.length;
    trumps.forEach(function (c, i) {
      const p0 = E.power(c, trump, trump);
      const higherMissing = allOfSuit(trump, trump).filter(function (x) {
        return E.power(x, trump, trump) > p0 && hand.indexOf(x) < 0;
      }).length;
      let p = Math.pow(1 - q, higherMissing);
      const behind = tLen - i; // this card plus my lower trumps
      if (behind > higherMissing && higherMissing > 0) p = Math.max(p, Math.min(0.8, 0.35 + 0.12 * (behind - higherMissing)));
      est += p;
      if (p >= 0.6) trumpWinners += 1;
    });
    // long trump: extra length wins late tricks on big hands
    const avgLen = cards * 15 / 54;
    if (tLen > avgLen + 1) est += (tLen - avgLen - 1) * 0.35 * q;

    SUITS.forEach(function (s) {
      if (s === trump) return;
      const list = bySuit[s];
      const L = list.length;
      list.forEach(function (c, i) {
        const r = E.rankOf(c);
        const higherMissing = 14 - r - list.filter(function (x) { return E.rankOf(x) > r; }).length;
        let p = Math.pow(1 - q, higherMissing);
        if (higherMissing > 0 && L > higherMissing) p = Math.max(p, 0.45 / higherMissing);
        // the deeper into a suit, the likelier someone ruffs it
        const round = i + 1;
        const ruff = cards <= 3 ? 1 : round === 1 ? 0.92 : round === 2 ? 0.75 : 0.45;
        // on small hands an off-suit card only wins if its suit gets led
        const ledChance = cards <= 4 ? 0.65 : 1;
        if (p > 0.15) est += p * ruff * ledChance;
      });
    });
    // short suits let spare trumps ruff
    const spare = Math.max(0, tLen - trumpWinners);
    let ruffs = 0;
    SUITS.forEach(function (s) {
      if (s === trump) return;
      const L = bySuit[s].length;
      if (L === 0) ruffs += 0.9;
      else if (L === 1) ruffs += 0.5;
      else if (L === 2 && cards >= 9) ruffs += 0.2;
    });
    est += Math.min(spare, ruffs) * Math.min(1, q * 1.1) * 0.8;
    return Math.min(cards, est);
  }

  /** Tricks this hand wins no matter what: top trumps in sequence. */
  function sureTopTrumps(hand, trump) {
    const order = allOfSuit(trump, trump).sort(function (a, b) { return E.power(b, trump, trump) - E.power(a, trump, trump); });
    let n = 0;
    for (let i = 0; i < order.length; i++) {
      if (hand.indexOf(order[i]) >= 0) n += 1; else break;
    }
    return n;
  }

  function chooseBid(state, seat) {
    const r = state.round;
    const o = E.bidOptions(state, seat);
    const hand = r.hands[seat];
    const est = estimateTricks(hand, r.trump, r.cards);
    const sure = sureTopTrumps(hand, r.trump);
    if (o.canBoard && sure >= r.cards) return { type: 'bid', seat: seat, board: r.cards <= 2 ? 4 : 2 };
    if (o.canBoston && r.cards >= 6) {
      const aces = SUITS.filter(function (s) { return s !== r.trump && hand.indexOf(s + '14') >= 0; }).length;
      if (est >= 7 && sure >= 4 && sure + aces >= 6) {
        return { type: 'bid', seat: seat, boston: true, value: Math.max(6, Math.min(r.cards, Math.round(est))) };
      }
    }
    let bid = r.cards >= 8 ? Math.floor(est * 1.1 + 0.3) : Math.floor(est + 0.15);
    if (o.canRainbow) {
      bid = Math.max(o.rainbowMin, Math.min(o.max, bid));
      return { type: 'bid', seat: seat, value: bid, rainbow: true };
    }
    bid = Math.max(o.min, Math.min(o.max, bid));
    return { type: 'bid', seat: seat, value: bid };
  }

  // ---------- play ----------
  function knowledge(state, seat) {
    const r = state.round;
    const seen = {};
    r.hands[seat].forEach(function (c) { seen[c] = 'mine'; });
    r.flipped.forEach(function (c) { seen[c] = 'out'; });
    const voids = [{}, {}, {}, {}];
    const tricks = r.tricks.map(function (t) { return t.cards; }).concat(r.trick.length ? [r.trick] : []);
    tricks.forEach(function (cards) {
      const led = E.effSuit(cards[0].card, r.trump);
      cards.forEach(function (p) {
        seen[p.card] = 'played';
        if (E.effSuit(p.card, r.trump) !== led) voids[p.seat][led] = true;
      });
    });
    const unseen = E.makeDeck().filter(function (c) { return !seen[c]; });
    return { unseen: unseen, voids: voids };
  }

  /** Could any unseen card held by the given seats beat `card` in a trick led with `led`? */
  function beatable(state, k, card, led, seats) {
    const r = state.round;
    if (!seats.length) return false;
    const p = E.power(card, r.trump, led);
    const someoneCanHoldLed = seats.some(function (s) { return !k.voids[s][led]; });
    const someoneCanRuff = led !== r.trump && seats.some(function (s) { return k.voids[s][led] && !k.voids[s][r.trump]; });
    return k.unseen.some(function (c) {
      const cs = E.effSuit(c, r.trump);
      if (E.power(c, r.trump, led) <= p) return false;
      if (cs === led) return someoneCanHoldLed;
      if (cs === r.trump) return someoneCanRuff;
      return false;
    });
  }

  function currentBags(state, team) {
    const sc = E.score(state);
    return team === 'A' ? sc.aBags : sc.bBags;
  }

  function wantsToWin(state, seat) {
    const r = state.round;
    const team = E.teamOf(seat);
    const opp = team === 'A' ? 'B' : 'A';
    const mine = r.team[team];
    const theirs = r.team[opp];
    const took = function (t) { return t === 'A' ? r.took[0] + r.took[2] : r.took[1] + r.took[3]; };
    const left = r.hands[seat].length;
    const firstSix = r.tricks.length < 6;
    if (mine.board) return true;
    if (mine.boston && firstSix) return true;
    if (theirs.boston && firstSix && r.tricks.every(function (t) { return E.teamOf(t.winner) === opp; })) return true;
    if (theirs.board && took(team) === 0) return true;
    const need = E.teamBid(r, team) - took(team);
    if (need > 0) return true;
    const oppNeed = E.teamBid(r, opp) - took(opp);
    if (theirs.board) return false;
    // Bid made: only chase a set when the other team needs nearly every trick left
    // (otherwise every extra trick is just a bag).
    if (oppNeed > 0 && oppNeed <= left && left - oppNeed <= Math.max(1, Math.floor(left / 3)) && currentBags(state, team) < 7) return true;
    return false;
  }

  function lowest(cards, trump, led) {
    return cards.slice().sort(function (a, b) {
      const ta = E.effSuit(a, trump) === trump ? 1 : 0;
      const tb = E.effSuit(b, trump) === trump ? 1 : 0;
      if (ta !== tb) return ta - tb; // keep trumps
      return E.rankOf(a) - E.rankOf(b);
    })[0];
  }
  function cheapest(cards, trump, led) {
    return cards.slice().sort(function (a, b) { return E.power(a, trump, led) - E.power(b, trump, led); })[0];
  }

  function chooseCard(state, seat) {
    const r = state.round;
    const legal = E.legalCards(state, seat);
    if (legal.length === 1) return legal[0];
    const trump = r.trump;
    const k = knowledge(state, seat);
    const win = wantsToWin(state, seat);
    const partner = E.partnerOf(seat);
    const hand = r.hands[seat];
    const count = function (s) { return hand.filter(function (c) { return E.effSuit(c, trump) === s; }).length; };

    if (r.trick.length === 0) {
      const others = [1, 2, 3].map(function (j) { return (seat + j) % 4; });
      const opps = others.filter(function (s) { return s !== partner; });
      if (win) {
        const sure = legal.filter(function (c) { return !beatable(state, k, c, E.effSuit(c, trump), opps); });
        const sureOff = sure.filter(function (c) { return E.effSuit(c, trump) !== trump; });
        if (sureOff.length) return sureOff.sort(function (a, b) { return E.rankOf(b) - E.rankOf(a); })[0];
        if (sure.length) return sure.sort(function (a, b) { return E.power(b, trump, trump) - E.power(a, trump, trump); })[0];
        // lead a singleton off-suit low card to set up ruffs, else low from the longest off suit
        const off = legal.filter(function (c) { return E.effSuit(c, trump) !== trump; });
        if (off.length) {
          const single = off.filter(function (c) { return count(c[0]) === 1 && E.rankOf(c) < 12; });
          if (single.length && count(trump) > 0) return lowest(single, trump);
          const longest = off.slice().sort(function (a, b) { return count(b[0]) - count(a[0]) || E.rankOf(a) - E.rankOf(b); });
          return longest[0];
        }
        return lowest(legal, trump);
      }
      // ducking: lead the card most likely to lose
      const scored = legal.map(function (c) {
        const s = E.effSuit(c, trump);
        const higher = k.unseen.filter(function (u) { return E.effSuit(u, trump) === s && E.power(u, trump, s) > E.power(c, trump, s); }).length;
        return { c: c, v: higher - (s === trump ? 3 : 0) };
      }).sort(function (a, b) { return b.v - a.v || E.rankOf(a.c) - E.rankOf(b.c); });
      return scored[0].c;
    }

    const led = E.ledSuit(r);
    const winnerSeat = E.trickWinner(r.trick, trump);
    const winCard = r.trick.filter(function (p) { return p.seat === winnerSeat; })[0].card;
    const winPower = E.power(winCard, trump, led);
    const remaining = [];
    for (let j = 1; j < 4 - r.trick.length; j++) remaining.push((seat + j) % 4);
    const last = remaining.length === 0;
    const winners = legal.filter(function (c) { return E.power(c, trump, led) > winPower; });
    const losers = legal.filter(function (c) { return E.power(c, trump, led) <= winPower; });
    const partnerWinning = winnerSeat === partner;
    const oppsAfter = remaining.filter(function (s) { return s !== partner; });

    if (win) {
      if (partnerWinning && !beatable(state, k, winCard, led, oppsAfter)) {
        return losers.length ? lowest(losers, trump, led) : cheapest(winners, trump, led);
      }
      if (winners.length) {
        if (last) return cheapest(winners, trump, led);
        const safe = winners.filter(function (c) { return !beatable(state, k, c, led, oppsAfter); });
        if (safe.length) return cheapest(safe, trump, led);
        // second hand low when partner still to play and we can't win for sure
        if (r.trick.length === 1 && remaining.indexOf(partner) >= 0 && losers.length) return lowest(losers, trump, led);
        return cheapest(winners, trump, led);
      }
      return lowest(legal, trump, led);
    }
    // ducking
    if (losers.length) {
      // shed the highest card that still loses (keep trumps unless that's all we have)
      return losers.slice().sort(function (a, b) {
        const ta = E.effSuit(a, trump) === trump ? 1 : 0;
        const tb = E.effSuit(b, trump) === trump ? 1 : 0;
        if (ta !== tb) return ta - tb;
        return E.rankOf(b) - E.rankOf(a);
      })[0];
    }
    if (last) return winners.slice().sort(function (a, b) { return E.power(b, trump, led) - E.power(a, trump, led); })[0];
    return cheapest(winners, trump, led);
  }

  function chooseAction(state, seat) {
    if (state.phase === 'bidding') return chooseBid(state, seat);
    if (state.phase === 'playing') return { type: 'play', seat: seat, card: chooseCard(state, seat) };
    return null;
  }

  return {
    estimateTricks: estimateTricks,
    sureTopTrumps: sureTopTrumps,
    chooseBid: chooseBid,
    chooseCard: chooseCard,
    chooseAction: chooseAction,
    wantsToWin: wantsToWin
  };
});
