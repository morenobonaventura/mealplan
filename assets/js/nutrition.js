/**
 * Nutrition maths: what a planned week adds up to, and whether it looks
 * balanced. Everything here is per person, per day, and covers only the meals
 * the app actually plans — lunch and dinner. Breakfast, snacks and drinks are
 * the rest of the day and are nobody's business but the cook's.
 *
 * Targets are the UK reference intakes (2000 kcal, 50 g protein, 260 g carbs,
 * 70 g fat) plus SACN's 30 g of fibre, taken at the ~60% of a day that two
 * meals represent. They are a gentle steer, not a diet.
 */
import { mealById, DAYS, slotsForDay, getPlan, slotKey } from './store.js';

/** Per person, per day, across lunch + dinner together. */
export const TARGETS = {
  kcal:    { ideal: 1300, low: 1050, high: 1550 },
  protein: { ideal: 60,   low: 45,   high: 95 },
  carbs:   { ideal: 150,  low: 105,  high: 205 },
  fibre:   { ideal: 18,   low: 15,   high: 45 },
  fat:     { ideal: 50,   low: 25,   high: 72 },
};

/** Share of the week's meals that should be meat-free, to keep plants in. */
export const MEATLESS_SHARE = { low: 0.25, ideal: 0.4 };

const KEYS = ['kcal', 'protein', 'carbs', 'fibre', 'fat'];

/** Protein types that count as meat, and those that count as meat-free. */
const MEAT = ['beef', 'chicken', 'pork', 'mixed'];
const MEATLESS = ['veg', 'cheese', 'egg'];

export const isMeat = (meal) => MEAT.includes(meal && meal.protein);
export const isMeatless = (meal) => MEATLESS.includes(meal && meal.protein);

/**
 * Rough macros for a meal the user typed in themselves, which has no measured
 * nutrition. Built from what the add-meal form does ask for: how hearty it is
 * and what the protein is. Deliberately middle-of-the-road so a custom meal
 * never dominates the week's picture.
 */
function estimate(meal) {
  const weight = Math.min(3, Math.max(1, Number(meal.weight) || 2));
  const kcal = { 1: 450, 2: 650, 3: 850 }[weight];
  const byProtein = {
    beef:    { protein: 42, fibre: 5, fat: 40 },
    pork:    { protein: 34, fibre: 5, fat: 40 },
    chicken: { protein: 42, fibre: 6, fat: 22 },
    fish:    { protein: 38, fibre: 6, fat: 20 },
    egg:     { protein: 25, fibre: 5, fat: 26 },
    cheese:  { protein: 26, fibre: 5, fat: 32 },
    veg:     { protein: 18, fibre: 12, fat: 22 },
    mixed:   { protein: 30, fibre: 6, fat: 30 },
  }[meal.protein] || { protein: 28, fibre: 6, fat: 28 };

  const scale = kcal / 650;
  const protein = Math.round(byProtein.protein * scale);
  const fat = Math.round(byProtein.fat * scale);
  const fibre = Math.round(byProtein.fibre * scale);
  // Whatever calories the protein and fat do not explain, call carbohydrate.
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return { kcal, protein, carbs, fibre, fat, estimated: true };
}

const ZERO = { kcal: 0, protein: 0, carbs: 0, fibre: 0, fat: 0 };

/** Macros for one serving of a meal, measured if we have it, estimated if not. */
export function nutritionOf(meal) {
  if (!meal) return { ...ZERO };
  const n = meal.nutrition;
  if (n && KEYS.every((k) => typeof n[k] === 'number')) return n;
  return estimate(meal);
}

function addInto(total, n) {
  for (const k of KEYS) total[k] += n[k] || 0;
  return total;
}

/**
 * Everything planned for a week, rolled up.
 * Totals are per person: `perDay` is what one person eats on an average
 * planned day, which is what the targets are written against.
 */
export function weekNutrition(weekIso) {
  const plan = getPlan(weekIso);
  const total = { ...ZERO };
  const meals = [];
  const daysWithFood = new Set();

  for (const day of DAYS) {
    for (const slot of slotsForDay(day)) {
      const entry = plan[slotKey(day, slot)];
      const meal = entry && mealById(entry.mealId);
      if (!meal) continue;
      meals.push(meal);
      daysWithFood.add(day);
      addInto(total, nutritionOf(meal));
    }
  }

  const days = daysWithFood.size;
  const perDay = { ...ZERO };
  if (days) for (const k of KEYS) perDay[k] = Math.round(total[k] / days);

  const meatless = meals.filter(isMeatless).length;
  const meat = meals.filter(isMeat).length;

  return {
    total,
    perDay,
    days,
    mealCount: meals.length,
    meatless,
    meat,
    meatlessShare: meals.length ? meatless / meals.length : 0,
    meatShare: meals.length ? meat / meals.length : 0,
    estimated: meals.some((m) => nutritionOf(m).estimated),
  };
}

/* ------------------------------------------------------------- verdicts -- */

/**
 * How each nutrient is doing: 'low', 'good' or 'high'.
 * Fibre only ever reads low or good — there is no such thing as too much veg
 * in a week of home cooking.
 */
export function nutrientStatus(perDay) {
  const out = {};
  for (const k of KEYS) {
    const t = TARGETS[k];
    if (perDay[k] < t.low) out[k] = 'low';
    else if (perDay[k] > t.high) out[k] = 'high';
    else out[k] = 'good';
  }
  return out;
}

/**
 * One plain-English headline for the week, plus a nudge towards the single
 * most useful change. Written to be read by someone feeding a family on a
 * Tuesday, not by a nutritionist.
 */
export function verdict(summary) {
  const { perDay, mealCount, meatlessShare, meatShare } = summary;
  if (!mealCount) {
    return { tone: 'empty', title: 'Nothing planned yet', detail: 'Plan your week and we will show how it balances out.' };
  }
  if (mealCount < 4) {
    return { tone: 'empty', title: 'Just getting started', detail: 'Add a few more meals and we will show how the week balances out.' };
  }

  const s = nutrientStatus(perDay);
  const issues = [];

  // How far outside its band a nutrient sits, as a fraction of the band edge,
  // so a wildly rich week outranks a mildly low-fibre one rather than losing
  // to it on a fixed priority.
  const over = (k) => {
    const t = TARGETS[k];
    if (perDay[k] < t.low) return (t.low - perDay[k]) / t.low;
    if (perDay[k] > t.high) return (perDay[k] - t.high) / t.high;
    return 0;
  };
  const add = (base, k, issue) => issues.push({ ...issue, rank: base * (1 + over(k) * 3) });

  if (s.fibre === 'low') {
    add(3, 'fibre', {
      tone: 'veg',
      title: 'Could do with more veg',
      detail: 'Adding a bean, lentil or veg-led meal would lift the fibre nicely.',
    });
  }
  if (meatShare > 0.6) {
    issues.push({
      rank: 3 * (1 + (meatShare - 0.6) * 3), tone: 'meat',
      title: 'Heavy on the meat',
      detail: 'A meat-free night or two would even the week out — and it is cheaper.',
    });
  } else if (meatlessShare < MEATLESS_SHARE.low) {
    issues.push({
      rank: 2.5, tone: 'meat',
      title: 'Room for more veg-led meals',
      detail: 'Almost every meal is built round meat or fish. A couple of veg nights would balance it.',
    });
  }
  if (s.fat === 'high') {
    add(3, 'fat', {
      tone: 'rich',
      title: 'A rich week',
      detail: 'Lots of buttery, creamy dishes. Swapping one for something fresher would balance it.',
    });
  }
  if (s.protein === 'high') {
    add(2, 'protein', {
      tone: 'protein',
      title: 'Big on protein',
      detail: 'Plenty of meat and fish here. Fine if that suits you — swap one for a veg night if not.',
    });
  }
  if (s.protein === 'low') {
    add(2.5, 'protein', {
      tone: 'protein',
      title: 'A little light on protein',
      detail: 'A chicken, fish, egg or bean dish would fill the gap.',
    });
  }
  if (s.carbs === 'low') {
    add(2, 'carbs', {
      tone: 'light',
      title: 'Light on the carbs',
      detail: 'Some rice, pasta, potatoes or bread would make these meals go further.',
    });
  }
  if (s.kcal === 'high') {
    add(2, 'kcal', {
      tone: 'rich',
      title: 'Hearty week',
      detail: 'These are generous plates. Lovely for a cold week, heavy for a quiet one.',
    });
  }
  if (s.kcal === 'low') {
    add(2, 'kcal', {
      tone: 'light',
      title: 'A light week',
      detail: 'These meals are on the small side. Add a heartier dinner or two if the family is hungry.',
    });
  }

  if (!issues.length) {
    const great = perDay.fibre >= TARGETS.fibre.ideal && meatlessShare >= MEATLESS_SHARE.ideal;
    return {
      tone: 'good',
      title: great ? 'A really well-balanced week' : 'Nicely balanced week',
      detail: great
        ? 'Good protein, plenty of veg and fibre, and not too rich. Lovely.'
        : 'Protein, carbs and veg are all sitting about where you would want them.',
    };
  }

  issues.sort((a, b) => b.rank - a.rank);
  return issues[0];
}

/* ------------------------------------------------- steering the planner -- */

/**
 * What one more meal ought to look like, given what a week still needs.
 * `slotsLeft` is how many meals are still to be filled (at least 1).
 */
export function idealNext(running, slotsLeft, days) {
  const left = Math.max(1, slotsLeft);
  const want = {};
  for (const k of KEYS) {
    const total = TARGETS[k].ideal * Math.max(1, days);
    // A week already at its target wants nothing more, not a negative amount:
    // clamped at zero this reads as "the lighter the better", which is right.
    want[k] = Math.max(0, (total - (running[k] || 0)) / left);
  }
  return want;
}

/**
 * Would the week still read as balanced with this meal dropped in?
 * `running` is the rest of the week; `days` the number of days being eaten.
 * This is what "keeps your week balanced" means in the UI — not a score, the
 * actual answer.
 */
export function keepsBalance(meal, running, days) {
  const n = nutritionOf(meal);
  const perDay = {};
  for (const k of KEYS) perDay[k] = Math.round(((running[k] || 0) + (n[k] || 0)) / Math.max(1, days));
  const status = nutrientStatus(perDay);
  return KEYS.every((k) => status[k] === 'good');
}

/**
 * How well a meal fits what the week still needs. 0 is a perfect fit and the
 * score falls away from there, so callers can simply add it to their own.
 * The divisors are "how many grams off before we care".
 */
export function fitPenalty(meal, want) {
  const n = nutritionOf(meal);
  const miss = (k, tolerance) => Math.abs(n[k] - want[k]) / tolerance;
  return (
    miss('kcal', 260)
    + miss('protein', 20)
    + miss('carbs', 55)
    + miss('fat', 22)
    // Fibre is one-sided: being over the mark is never a problem.
    + Math.max(0, want.fibre - n.fibre) / 7
  );
}

/**
 * Does the week still want a meat-free meal? Used to nudge, not to forbid.
 * Returns a positive number when meat-free would help.
 */
export function meatlessPressure(mealsSoFar, plannedTotal) {
  const total = Math.max(1, plannedTotal);
  const meatless = mealsSoFar.filter(isMeatless).length;
  const wanted = MEATLESS_SHARE.ideal * total;
  return (wanted - meatless) / total;
}
