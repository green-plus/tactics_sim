const FACE_VALUES = { t: 10, j: 11, q: 12, k: 13 };
const VALUE_SYMBOLS = { 10: "t", 11: "j", 12: "q", 13: "k" };
const TOKEN_RE = /^[0-9tjqk]+$/i;
const ITEM_RE = /[0-9tjqk]+/gi;

export const STRATEGIES = [
  "x-lock",
  "dual-wield",
  "nine-plus",
  "three-prime-eight-composite",
  "three-kkj",
  "two-kk-factor",
  "one-x-one-x",
  "face-five-prime",
  "trumps",
];

export const DEFAULT_WIN_RATES = {
  "x-lock": 1.0,
  "dual-wield": 0.85,
  "nine-plus": 0.7,
  "three-prime-eight-composite": 0.9,
  "three-kkj": 0.75,
  "two-kk-factor": 0.98,
  "one-x-one-x": 1.0,
  "face-five-prime": 0.8,
  "trumps": 0.9,
  "all-out": 0.5,
};

const TRUMP_PRIMES = ["kkj", "kqk", "kjj", "kjqj", "kjtk", "ktqj", "qqqj", "qk"];
const DUAL_WIELD_TRUMPS = ["kjqj", "ktqj", "kkj", "kqk", "kjj"];
const EXTRA_COMPOSITES = ["kq=2^5*41", "kq=2^4*2*41", "kj=3*19*23", "kt=2*5*k1"];
const DECK = [...Array.from({ length: 13 }, (_, i) => Array(4).fill(i + 1)).flat(), 0, 0];

const encodingCache = new Map();

export function buildMemory(primeText, compositeText, additionalCompositeText = "", options = {}) {
  const maxCards = options.maxCards || 12;
  const primes = parsePrimeText(primeText, maxCards);
  const composites = parseCompositeText(compositeText, maxCards, "composite");
  const additional = parseCompositeText(additionalCompositeText, maxCards, "additional-composite");
  const compositeMoves = [...composites.moves, ...additional.moves];
  return {
    primeText,
    compositeText,
    additionalCompositeText,
    primeMoves: primes.moves,
    compositeMoves,
    stats: {
      primeValues: primes.values,
      primeMoves: primes.moves.length,
      compositeEquations: composites.equations,
      additionalCompositeEquations: additional.equations,
      compositeMoves: compositeMoves.length,
      warnings: [...primes.warnings, ...composites.warnings, ...additional.warnings],
    },
  };
}

function buildSimulationContext(memory, jokersWild) {
  const allMoves = [...memory.primeMoves, ...memory.compositeMoves];
  const movesBySize = indexMoves(allMoves);
  const movesByConsumption = indexMoves(allMoves, true);
  const trumpMoves = TRUMP_PRIMES.map((pattern) => move(pattern.toUpperCase(), tokenize(pattern), patternValue(pattern), "prime"));
  trumpMoves.push(...EXTRA_COMPOSITES.flatMap((equation) => unsplitLeftEquationMoves(equation)));
  return {
    primeMoves: memory.primeMoves,
    compositeMoves: memory.compositeMoves,
    movesBySize,
    movesByConsumption,
    primesBySize: indexMoves(memory.primeMoves),
    faceFivePrimes: memory.primeMoves.filter((item) => item.cards.filter((rank) => rank >= 10).length >= 5),
    ninePlusMoves: [...movesBySize.entries()]
      .filter(([size]) => size >= 9)
      .flatMap(([, moves]) => moves),
    threePrimeMoves: memory.primeMoves.filter((item) => (
      (item.playCount || item.cards.length) === 3 && item.value !== null && item.value <= 9999n
    )),
    threeCompositeFinishers: memory.compositeMoves.filter((item) => item.playCount === 3),
    dualTrumpMoves: DUAL_WIELD_TRUMPS.map((pattern) => fixedMove(pattern.toUpperCase(), pattern)),
    kkFactorMoves: equationMoves("kk=t1*k"),
    kkjMove: fixedMove("KKJ", "kkj"),
    trumpMoves,
    exactPrime: exactPrimeMatcher(memory.primeMoves, jokersWild),
  };
}

export function parsePrimeText(text, maxCards = 12) {
  const seen = new Set();
  const moves = [];
  const warnings = [];
  for (const match of text.matchAll(ITEM_RE)) {
    const token = match[0].toLowerCase();
    if (!TOKEN_RE.test(token)) {
      warnings.push(`${token}: カード表記として読めません`);
      continue;
    }
    const value = patternValue(token);
    const key = value.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isProbablePrime(value)) {
      warnings.push(`${token}: 素数ではありません`);
      continue;
    }
    for (const cards of valueEncodings(value, maxCards)) {
      if (!primeEncodingAllowed(cards)) continue;
      if (cardsValue(cards) === value) {
        moves.push(move(cardsLabel(cards), cards, value, "prime"));
      }
    }
  }
  return { moves, values: seen.size - warnings.length, warnings };
}

function primeEncodingAllowed(cards) {
  return cards.filter((rank) => rank === 1).length < 5;
}

export function parseCompositeText(text, maxCards = 12, kind = "composite") {
  const moves = [];
  const warnings = [];
  let equations = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [equationPart, physicalPart] = line.split("|").map((part) => part.trim());
    if (!equationPart.includes("=")) {
      warnings.push(`${line}: 合成数式に = がありません`);
      continue;
    }
    try {
      equations += 1;
      if (physicalPart) {
        const left = equationPart.split("=", 1)[0].toLowerCase();
        moves.push(move(equationPart.toLowerCase(), tokenize(physicalPart), patternValue(left), kind, tokenize(left).length));
      } else {
        moves.push(...equationMoves(equationPart.toLowerCase(), maxCards).map((item) => ({ ...item, kind })));
      }
    } catch (error) {
      warnings.push(`${line}: ${error.message}`);
    }
  }
  return { moves, equations, warnings };
}

export async function simulatePolicy(memory, request) {
  const trials = Math.max(1, Number(request.trials) || 300);
  const handSize = Math.max(1, Number(request.handSize) || 11);
  const seed = Number(request.seed) || 20260613;
  const exampleLimit = Math.max(0, Number(request.examples) || trials);
  const jokersWild = request.jokersWild !== false;
  const config = normalizeWinConfig(request.winRates);
  const enabledStrategies = new Set(request.enabledStrategies || STRATEGIES);
  const context = buildSimulationContext(memory, jokersWild);
  const rng = mulberry32(seed);

  const rows = [];
  const availability = {};
  const initialAvailabilityCount = {};
  const drawAvailabilityCount = {};
  let expectedWins = 0;
  let expectedWinsSquared = 0;
  let drawAttempts = 0;
  let drawSuccesses = 0;
  let topRateTies = 0;
  let finalSizeTiesRandomized = 0;
  const selectedFinishSizeDistribution = {};
  const allOutDrawCardDistribution = {};

  for (let trial = 1; trial <= trials; trial += 1) {
    const hand = sampleHand(handSize, rng);
    const decision = policyDecisionForHand(
      hand,
      context,
      config,
      jokersWild,
      enabledStrategies,
      seed,
      trial,
    );
    const initialOptions = decision.initialOptions;
    const drawOptions = decision.drawOptions;
    const selected = decision.selected;
    const rate = decision.rate;
    const finishSize = finishingPlaySize(decision.moves);

    expectedWins += rate;
    expectedWinsSquared += rate * rate;
    addCount(initialAvailabilityCount, initialOptions.length);
    if (decision.drawnCard !== null) {
      drawAttempts += 1;
      addCount(drawAvailabilityCount, drawOptions.length);
      if (selected !== "all-out") drawSuccesses += 1;
      if (selected === "all-out") addCount(allOutDrawCardDistribution, cardsLabel([decision.drawnCard]));
    }
    if (selected !== "all-out") addCount(selectedFinishSizeDistribution, finishSize);
    for (const option of initialOptions) addCount(availability, option.strategy);
    for (const option of drawOptions) addCount(availability, `draw:${option.strategy}`);
    if (optionTieFlags(initialOptions)[0]) topRateTies += 1;
    if (optionTieFlags(initialOptions)[1]) finalSizeTiesRandomized += 1;

    rows.push({
      trial,
      hand,
      drawn_card: decision.drawnCard,
      strategy: selected,
      moves: decision.moves,
      win_rate: rate,
      initial_candidates: initialOptions.map(optionRecord),
      draw_candidates: drawOptions.map(optionRecord),
    });
  }

  const selection = buildSelection(rows, trials, config);
  const examples = {};
  for (const strategy of [...STRATEGIES, ...STRATEGIES.map((strategy) => `draw:${strategy}`), "all-out"]) {
    examples[strategy] = [];
  }
  for (const row of rows) {
    if (!examples[row.strategy]) examples[row.strategy] = [];
    if (examples[row.strategy].length < exampleLimit) examples[row.strategy].push(row);
  }

  const expectedWinRate = expectedWins / trials;
  const variance = Math.max(0, expectedWinsSquared / trials - expectedWinRate * expectedWinRate);
  const error = 1.96 * Math.sqrt(variance / trials);
  return {
    trials,
    expected_wins: expectedWins,
    expected_win_rate: expectedWinRate,
    expected_win_rate_ci95_low: Math.max(0, expectedWinRate - error),
    expected_win_rate_ci95_high: Math.min(1, expectedWinRate + error),
    seed,
    draw_attempts: drawAttempts,
    draw_attempt_rate: drawAttempts / trials,
    draw_successes: drawSuccesses,
    draw_success_rate_given_attempt: drawAttempts ? drawSuccesses / drawAttempts : 0,
    all_outs: rows.filter((row) => row.strategy === "all-out").length,
    all_out_rate: rows.filter((row) => row.strategy === "all-out").length / trials,
    top_rate_ties: topRateTies,
    final_size_ties_randomized: finalSizeTiesRandomized,
    initial_availability_count_distribution: initialAvailabilityCount,
    draw_availability_count_distribution: drawAvailabilityCount,
    strategy_availability: availability,
    selected_finish_size_distribution: selectedFinishSizeDistribution,
    all_out_draw_card_distribution: allOutDrawCardDistribution,
    selection,
    examples,
    prime_moves: memory.primeMoves.length,
    composite_moves: memory.compositeMoves.length,
  };
}

function normalizeWinConfig(config = {}) {
  return {
    strategy_rates: { ...DEFAULT_WIN_RATES, ...(config.strategy_rates || {}) },
    conditional_rates: config.conditional_rates || [],
    move_overrides: config.move_overrides || {},
  };
}

function policyDecisionForHand(hand, context, config, jokersWild, enabledStrategies, seed, trial) {
  const initialOptions = availableStrategyOptions(hand, context, config, jokersWild, enabledStrategies);
  const tieRng = mulberry32((seed ^ 0x71e) + trial * 2);
  const best = selectBestOption(initialOptions, tieRng);
  if (best) {
    return {
      selected: best.strategy,
      rate: best.winRate,
      moves: best.moves,
      drawnCard: null,
      initialOptions,
      drawOptions: [],
    };
  }

  const drawnCard = drawFromRemainingDeck(hand, mulberry32((seed ^ 0xd12a) + trial));
  const drawnHand = [...hand, drawnCard].sort((a, b) => a - b);
  const drawOptions = availableStrategyOptions(drawnHand, context, config, jokersWild, enabledStrategies);
  const bestAfterDraw = selectBestOption(drawOptions, mulberry32((seed ^ 0x71e) + trial * 2 + 1));
  if (bestAfterDraw) {
    return {
      selected: `draw:${bestAfterDraw.strategy}`,
      rate: bestAfterDraw.winRate,
      moves: [`DRAW:${cardsLabel([drawnCard])}`, ...bestAfterDraw.moves],
      drawnCard,
      initialOptions,
      drawOptions,
    };
  }

  return {
    selected: "all-out",
    rate: strategyWinRate("all-out", [`DRAW:${cardsLabel([drawnCard])}`, "ALL-OUT"], config),
    moves: [`DRAW:${cardsLabel([drawnCard])}`, "ALL-OUT"],
    drawnCard,
    initialOptions,
    drawOptions,
  };
}

function availableStrategyOptions(hand, context, config, jokersWild, enabledStrategies = new Set(STRATEGIES)) {
  const options = [];
  for (const strategy of STRATEGIES) {
    if (!enabledStrategies.has(strategy)) continue;
    const moves = findStrategyExample(hand, context, strategy, jokersWild);
    if (moves) {
      options.push({
        winRate: strategyWinRate(strategy, moves, config),
        finishSize: finishingPlaySize(moves),
        strategy,
        moves,
      });
    }
  }
  return options;
}

function selectBestOption(options, rng) {
  if (!options.length) return null;
  const bestRate = Math.max(...options.map((option) => option.winRate));
  const rateTies = options.filter((option) => option.winRate === bestRate);
  const bestFinish = Math.max(...rateTies.map((option) => option.finishSize));
  const finalists = rateTies.filter((option) => option.finishSize === bestFinish);
  return finalists[Math.floor(rng() * finalists.length)];
}

function findStrategyExample(hand, context, strategy, jokersWild) {
  const { movesBySize, movesByConsumption } = context;
  if (strategy === "x-lock") return findXLockExample(hand, movesBySize, movesByConsumption, jokersWild);
  if (strategy === "dual-wield") return findDualWieldExample(hand, context, jokersWild);
  if (strategy === "nine-plus") {
    const first = context.ninePlusMoves.filter((item) => (item.playCount || item.cards.length) < hand.length);
    return sequenceThenFinish(hand, [first], movesByConsumption, jokersWild);
  }
  if (strategy === "three-prime-eight-composite") {
    return findThreePrimeEightCompositeExample(hand, context, jokersWild);
  }
  if (strategy === "three-kkj") {
    return sequenceThenFinish(hand, [movesBySize.get(3) || [], [context.kkjMove]], movesByConsumption, jokersWild);
  }
  if (strategy === "two-kk-factor") {
    return sequenceThenFinish(hand, [movesBySize.get(2) || [], context.kkFactorMoves], movesByConsumption, jokersWild);
  }
  if (strategy === "one-x-one-x") {
    return sequenceThenFinish(
      hand,
      [movesBySize.get(1) || [], [move("X", [0], null, "joker")], movesBySize.get(1) || [], [move("X", [0], null, "joker")]],
      movesByConsumption,
      jokersWild,
    );
  }
  if (strategy === "trumps") {
    return sequenceThenFinish(hand, [context.trumpMoves], movesByConsumption, jokersWild);
  }
  if (strategy === "face-five-prime") return findFaceFiveExample(hand, context.faceFivePrimes, movesByConsumption, jokersWild);
  return null;
}

function findXLockExample(hand, movesBySize, movesByConsumption, jokersWild) {
  if (hand.filter((rank) => rank === 0).length < 2) return null;
  for (const { remaining: afterFirst, move: first } of playable(hand, movesBySize.get(1) || [], jokersWild)) {
    if (afterFirst.filter((rank) => rank === 0).length < 2) continue;
    const afterX = [...afterFirst];
    afterX.splice(afterX.indexOf(0), 1);
    const finishes = finishWithKAdjustment(afterX, movesByConsumption, jokersWild, true);
    if (finishes) return [first.label, "X", ...finishes];
  }
  return null;
}

function findFaceFiveExample(hand, primeMoves, movesByConsumption, jokersWild) {
  for (const first of primeMoves) {
    if (first.cards.filter((rank) => rank >= 10).length < 5) continue;
    for (const remainder of possibleRemainders(hand, first.cards, jokersWild)) {
      const finishes = finishOptions(remainder, movesByConsumption, jokersWild);
      if (finishes.length) return [first.label, ...finishes[0]];
    }
  }
  return null;
}

function findDualWieldExample(hand, context, jokersWild) {
  if (!context.dualTrumpMoves.some((trump) => possibleRemainders(hand, trump.cards, jokersWild).length)) {
    return null;
  }
  for (const trump of context.dualTrumpMoves) {
    for (const first of context.primesBySize.get(trump.cards.length) || []) {
      for (const afterFirst of possibleRemainders(hand, first.cards, jokersWild)) {
        const combined = context.exactPrime(afterFirst);
        if (!combined) continue;
        for (const afterTrump of possibleRemainders(afterFirst, trump.cards, jokersWild)) {
          const second = context.exactPrime(afterTrump);
          if (second) return [first.label, trump.label, second.label, `COMBINED:${combined.label}`];
        }
      }
    }
  }
  return null;
}

function findThreePrimeEightCompositeExample(hand, context, jokersWild) {
  const finishers = context.threeCompositeFinishers.filter((item) => item.cards.length === hand.length - 3);
  for (const first of context.threePrimeMoves) {
    for (const afterFirst of possibleRemainders(hand, first.cards, jokersWild)) {
      if (afterFirst.length !== hand.length - 3) continue;
      for (const finisher of finishers) {
        if ((finisher.value || 0n) <= (first.value || 0n)) continue;
        if (possibleRemainders(afterFirst, finisher.cards, jokersWild).some((remaining) => remaining.length === 0)) {
          return [first.label, finisher.label];
        }
      }
    }
  }
  return null;
}

function sequenceThenFinish(hand, steps, movesByConsumption, jokersWild) {
  let states = [{ hand, labels: [] }];
  for (const options of steps) {
    const next = new Map();
    for (const state of states) {
      for (const { remaining, move: played } of playable(state.hand, options, jokersWild)) {
        const key = handKey(remaining);
        if (!next.has(key)) next.set(key, { hand: remaining, labels: [...state.labels, played.label] });
      }
    }
    states = [...next.values()];
    if (!states.length) return null;
  }
  for (const state of states) {
    const finishes = finishOptions(state.hand, movesByConsumption, jokersWild);
    if (finishes.length) return [...state.labels, ...finishes[0]];
  }
  return null;
}

function finishOptions(hand, movesByConsumption, jokersWild, showJokers = false) {
  const results = [];
  for (const { remaining, move: played } of playable(hand, movesByConsumption.get(hand.length) || [], jokersWild)) {
    if (remaining.length === 0) results.push([showJokers ? moveLabelWithJokers(hand, played, jokersWild) : played.label]);
  }
  for (const after57 of possibleRemainders(hand, [5, 7], jokersWild)) {
    const prefix = showJokers ? moveLabelWithJokers(hand, fixedMove("57", [5, 7]), jokersWild) : "57";
    for (const { remaining, move: played } of playable(after57, movesByConsumption.get(after57.length) || [], jokersWild)) {
      if (remaining.length === 0) {
        results.push([prefix, showJokers ? moveLabelWithJokers(after57, played, jokersWild) : played.label]);
      }
    }
  }
  return results;
}

function finishWithKAdjustment(hand, movesByConsumption, jokersWild, showJokers = false) {
  const kCount = hand.filter((rank) => rank === 13).length;
  for (let removeCount = 0; removeCount <= kCount; removeCount += 1) {
    const adjusted = [...hand];
    for (let i = 0; i < removeCount; i += 1) adjusted.splice(adjusted.indexOf(13), 1);
    const finishes = finishOptions(adjusted, movesByConsumption, jokersWild, showJokers);
    if (finishes.length) return [...Array(removeCount).fill("K"), ...finishes[0]];
  }
  return null;
}

function playable(hand, moves, jokersWild) {
  const results = [];
  for (const item of moves) {
    if (item.kind === "joker") {
      if (hand.includes(0)) {
        const remaining = [...hand];
        remaining.splice(remaining.indexOf(0), 1);
        results.push({ remaining, move: item });
      }
      continue;
    }
    for (const remaining of possibleRemainders(hand, item.cards, jokersWild)) {
      results.push({ remaining, move: item });
    }
  }
  return results;
}

function possibleRemainders(hand, cards, jokersWild = true) {
  const required = countRanks(cards);
  const available = countRanks(hand);
  const ranks = required.map((count, rank) => (count ? rank : -1)).filter((rank) => rank >= 0);
  const results = [];

  function visit(index, remaining, jokersUsed) {
    if (index === ranks.length) {
      const result = [...remaining];
      result[0] -= jokersUsed;
      if (result[0] >= 0) results.push(elementsFromCounts(result));
      return;
    }
    const rank = ranks[index];
    const needed = required[rank];
    const minimum = jokersWild ? Math.max(0, needed - (remaining[0] - jokersUsed)) : needed;
    for (let actual = minimum; actual <= Math.min(needed, remaining[rank]); actual += 1) {
      const missing = needed - actual;
      if ((missing && !jokersWild) || jokersUsed + missing > remaining[0]) continue;
      const next = [...remaining];
      next[rank] -= actual;
      visit(index + 1, next, jokersUsed + missing);
    }
  }

  visit(0, available, 0);
  return uniqueHands(results);
}

function jokerSubstitutions(hand, cards) {
  const available = countRanks(hand.filter((rank) => rank !== 0));
  const missing = [];
  for (let rank = 1; rank <= 13; rank += 1) {
    const shortage = Math.max(0, countRanks(cards)[rank] - available[rank]);
    for (let i = 0; i < shortage; i += 1) missing.push(rank);
  }
  return missing.length <= hand.filter((rank) => rank === 0).length ? missing.sort((a, b) => a - b) : null;
}

function moveLabelWithJokers(hand, item, jokersWild) {
  const substitutions = jokersWild ? jokerSubstitutions(hand, item.cards) : null;
  return substitutions?.length ? `${item.label} (X=${cardsLabel(substitutions)})` : item.label;
}

function exactPrimeMatcher(primeMoves, jokersWild) {
  const byLength = indexMoves(primeMoves, true);
  const exact = new Map();
  for (const [length, moves] of byLength.entries()) {
    exact.set(length, new Map(moves.map((item) => [handKey(item.cards), item])));
  }
  const cache = new Map();
  return (hand) => {
    const sorted = [...hand].sort((a, b) => a - b);
    const key = handKey(sorted);
    if (cache.has(key)) return cache.get(key);
    let result = exact.get(sorted.length)?.get(key) || null;
    if (!result && jokersWild && sorted.includes(0)) {
      result = (byLength.get(sorted.length) || []).find((item) => jokerSubstitutions(sorted, item.cards) !== null) || null;
    }
    cache.set(key, result);
    return result;
  };
}

function indexMoves(moves, byConsumption = false) {
  const result = new Map();
  for (const item of moves) {
    const size = byConsumption ? item.cards.length : item.playCount || item.cards.length;
    if (!result.has(size)) result.set(size, []);
    result.get(size).push(item);
  }
  return result;
}

function equationMoves(equation, maxCards = 12) {
  const [left, right] = equation.toLowerCase().split("=", 2);
  const leftEncodings = valueEncodings(patternValue(left), maxCards);
  const rightTerms = [...right.matchAll(ITEM_RE)].map((match) => match[0]);
  const rightChoices = rightTerms.map((term) => valueEncodings(patternValue(term), maxCards));
  const moves = [];
  for (const leftCards of leftEncodings) {
    for (const rightParts of product(rightChoices)) {
      const consumed = [...leftCards, ...rightParts.flat()];
      if (consumed.length <= maxCards) {
        moves.push(move(equation, consumed, patternValue(left), "composite", leftCards.length));
      }
    }
  }
  return moves;
}

function unsplitLeftEquationMoves(equation, maxCards = 12) {
  const leftCards = tokenize(equation.split("=", 1)[0]);
  return equationMoves(equation, maxCards).filter((item) => (
    item.playCount === leftCards.length && handKey(item.cards.slice(0, leftCards.length)) === handKey(leftCards)
  ));
}

function equationCards(label) {
  const terms = [...label.toLowerCase().matchAll(ITEM_RE)].map((match) => match[0]);
  const choices = terms.map((term) => valueEncodings(patternValue(term), 12));
  return product(choices).map((parts) => parts.flat()).filter((cards) => cards.length <= 12);
}

function tokenize(pattern) {
  const text = String(pattern).trim().toLowerCase();
  if (!TOKEN_RE.test(text)) throw new Error(`invalid card pattern: ${pattern}`);
  return [...text].map((char) => (char === "0" ? 10 : FACE_VALUES[char] || Number(char)));
}

function patternValue(pattern) {
  const text = [...String(pattern).trim().toLowerCase()].map((char) => FACE_VALUES[char] || char).join("");
  return BigInt(text);
}

function cardsValue(cards) {
  return BigInt(cards.map(String).join(""));
}

function cardsLabel(cards) {
  return cards.map((rank) => VALUE_SYMBOLS[rank] || String(rank)).join("");
}

function valueEncodings(value, maxCards = 12) {
  const key = `${value}:${maxCards}`;
  if (encodingCache.has(key)) return encodingCache.get(key);
  const text = value.toString();
  const results = new Map();

  function visit(index, cards) {
    if (cards.length > maxCards) return;
    if (index === text.length) {
      results.set(sequenceKey(cards), [...cards]);
      return;
    }
    const digit = Number(text[index]);
    if (digit) visit(index + 1, [...cards, digit]);
    if (index + 1 < text.length) {
      const pair = Number(text.slice(index, index + 2));
      if (pair >= 10 && pair <= 13) visit(index + 2, [...cards, pair]);
    }
  }

  visit(0, []);
  const encodings = [...results.values()]
    .filter((cards) => cardsValue(cards) === value)
    .sort((a, b) => a.length - b.length || handKey(a).localeCompare(handKey(b)));
  encodingCache.set(key, encodings);
  return encodings;
}

function isProbablePrime(n) {
  if (n < 2n) return false;
  const smallPrimes = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
  for (const prime of smallPrimes) {
    if (n === prime) return true;
    if (n % prime === 0n) return false;
  }
  let d = n - 1n;
  let s = 0;
  while (d % 2n === 0n) {
    s += 1;
    d /= 2n;
  }
  for (const base of smallPrimes) {
    let x = modPow(base, d, n);
    if (x === 1n || x === n - 1n) continue;
    let witnessed = false;
    for (let i = 0; i < s - 1; i += 1) {
      x = modPow(x, 2n, n);
      if (x === n - 1n) {
        witnessed = true;
        break;
      }
    }
    if (!witnessed) return false;
  }
  return true;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let value = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    power >>= 1n;
  }
  return result;
}

export function strategyWinRate(strategy, moves, config) {
  const overrides = config.move_overrides || {};
  const candidates = [`${strategy}:${moves.join(" -> ")}`, ...moves.map((item) => `${strategy}:${item}`)];
  for (const key of candidates) {
    if (Object.hasOwn(overrides, key)) return Number(overrides[key]);
  }
  const conditional = conditionalWinRate(strategy, moves, config);
  if (conditional !== null) return conditional;
  return Number(config.strategy_rates?.[strategy] ?? DEFAULT_WIN_RATES[strategy] ?? 0);
}

function conditionalWinRate(strategy, moves, config) {
  const rules = (config.conditional_rates || []).filter((rule) => rule.strategy === strategy);
  if (!rules.length || !moves.length) return null;
  const firstMove = moves.find((item) => !item.startsWith("DRAW:")) || moves[0];
  const metric = { strategy, ...moveMetric(firstMove) };
  for (const rule of rules) {
    if (ruleMatches(metric, rule)) return Number(rule.rate);
  }
  return null;
}

function moveMetric(label) {
  const clean = label.split(" (X=", 1)[0].replace(/^COMBINED:/, "").toLowerCase();
  const left = clean.split("=", 1)[0];
  let cards = [];
  let value = null;
  try {
    cards = TOKEN_RE.test(left) ? tokenize(left) : [];
    value = left && TOKEN_RE.test(left) ? patternValue(left) : null;
  } catch {
    cards = [];
  }
  return {
    label: left,
    play_count: cards.length,
    digit_count: value === null ? null : value.toString().length,
    gain: value === null ? null : value.toString().length - cards.length,
    value: value === null ? null : Number(value),
  };
}

function ruleMatches(metric, rule) {
  for (const [key, expected] of Object.entries(rule)) {
    if (["strategy", "rate", "description"].includes(key)) continue;
    if (key.endsWith("_min")) {
      const actual = metric[key.slice(0, -4)];
      if (actual === null || actual < expected) return false;
    } else if (key.endsWith("_max")) {
      const actual = metric[key.slice(0, -4)];
      if (actual === null || actual > expected) return false;
    } else if (metric[key] !== expected) {
      return false;
    }
  }
  return true;
}

function finishingPlaySize(moves) {
  const actual = moves.filter((item) => !item.startsWith("DRAW:") && !item.startsWith("COMBINED:"));
  return moveConsumptionCount(actual.at(-1) || "");
}

function moveConsumptionCount(label) {
  const clean = label.split(" (X=", 1)[0].replace(/^COMBINED:/, "");
  if (!clean || clean === "ALL-OUT") return 0;
  if (clean.startsWith("DRAW:") || clean === "X" || clean === "K") return 1;
  if (clean.includes("=")) return Math.max(0, ...equationCards(clean).map((cards) => cards.length));
  try {
    return tokenize(clean).length;
  } catch {
    return 0;
  }
}

function optionRecord(option) {
  return {
    win_rate: option.winRate,
    finish_size: option.finishSize,
    strategy: option.strategy,
    moves: option.moves,
  };
}

function optionTieFlags(options) {
  if (!options.length) return [false, false];
  const bestRate = Math.max(...options.map((option) => option.winRate));
  const rateTies = options.filter((option) => option.winRate === bestRate);
  const bestFinish = Math.max(...rateTies.map((option) => option.finishSize));
  return [rateTies.length > 1, rateTies.filter((option) => option.finishSize === bestFinish).length > 1];
}

function buildSelection(rows, trials, config) {
  const order = [...STRATEGIES, ...STRATEGIES.map((strategy) => `draw:${strategy}`), "all-out"];
  for (const row of rows) if (!order.includes(row.strategy)) order.push(row.strategy);
  return order.map((strategy) => {
    const selectedRows = rows.filter((row) => row.strategy === strategy);
    const expected = selectedRows.reduce((sum, row) => sum + row.win_rate, 0);
    return {
      strategy,
      selected: selectedRows.length,
      adoption_rate: selectedRows.length / trials,
      assigned_win_rate: Number(config.strategy_rates?.[strategy.replace(/^draw:/, "")] ?? 0),
      average_selected_win_rate: selectedRows.length ? expected / selectedRows.length : null,
      expected_win_contribution: expected / trials,
    };
  });
}

function sampleHand(size, rng) {
  const deck = [...DECK];
  const hand = [];
  for (let i = 0; i < size; i += 1) {
    const index = Math.floor(rng() * deck.length);
    hand.push(deck.splice(index, 1)[0]);
  }
  return hand.sort((a, b) => a - b);
}

function drawFromRemainingDeck(hand, rng) {
  const remaining = [...DECK];
  for (const card of hand) remaining.splice(remaining.indexOf(card), 1);
  return remaining[Math.floor(rng() * remaining.length)];
}

function fixedMove(label, cards, kind = "fixed") {
  return move(label, Array.isArray(cards) ? cards : tokenize(cards), null, kind);
}

function move(label, cards, value = null, kind = "prime", playCount = null) {
  return { label, cards: [...cards], value, kind, playCount };
}

function countRanks(cards) {
  const counts = Array(14).fill(0);
  for (const card of cards) counts[card] += 1;
  return counts;
}

function elementsFromCounts(counts) {
  const result = [];
  counts.forEach((count, rank) => {
    for (let i = 0; i < count; i += 1) result.push(rank);
  });
  return result;
}

function uniqueHands(hands) {
  const seen = new Map();
  for (const hand of hands) seen.set(handKey(hand), hand);
  return [...seen.values()];
}

function handKey(cards) {
  return [...cards].sort((a, b) => a - b).join(",");
}

function sequenceKey(cards) {
  return cards.join(",");
}

function product(choices) {
  if (!choices.length) return [[]];
  return choices.reduce((acc, choice) => acc.flatMap((prefix) => choice.map((item) => [...prefix, item])), [[]]);
}

function addCount(target, key, amount = 1) {
  target[key] = (target[key] || 0) + amount;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
