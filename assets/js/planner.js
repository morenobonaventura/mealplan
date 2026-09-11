/**
 * Offline meal picking + shopping list maths.
 * Deliberately dumb-but-sensible: no network needed, instant, good enough
 * that the AI is a bonus rather than a dependency.
 */
import { AISLES } from './meals.js';
import {
  DAYS, allMeals, mealById, getPlan, slotKey, isFavourite, getSettings, slotsForDay,
} from './store.js';
import {
  nutritionOf, idealNext, fitPenalty, meatlessPressure, isMeatless, keepsBalance,
} from './nutrition.js';

const WEEKEND = ['Fri', 'Sat', 'Sun'];

/** How far off the best fit a meal can be and still count as a good swap. */
const GOOD_FIT_MARGIN = 2.2;

/** Meals that make sense in this slot at all. */
export function candidatesFor(slot) {
  const pool = allMeals().filter((m) => (m.slots || ['lunch', 'dinner']).includes(slot));
  return pool.length ? pool : allMeals();
}

/**
 * Score a meal for a given position in the week.
 * Higher is better. `context` carries what is already planned around it.
 */
function score(meal, {
  day, slot, usedIds, neighbourProteins, weekProteins, dayCuisines,
  want, chosen, slotTotal,
}) {
  let s = 10;

  if (usedIds.has(meal.id)) s -= 60;                      // no repeats within a week
  if (isFavourite(meal.id)) s += 12;                      // the user said they like it

  const weekend = WEEKEND.includes(day);
  const heavy = (meal.weight || 2) >= 3;
  const slow = (meal.time || 30) > 45;

  if (slot === 'lunch') {
    if (heavy) s -= 8;                                    // keep lunches lighter
    if (meal.time <= 25) s += 6;
  }
  if (slot === 'dinner') {
    if (weekend && heavy) s += 8;                         // project cooking at the weekend
    if (!weekend && slow) s -= 10;                        // not on a Tuesday
  }

  if (dayCuisines.includes(meal.cuisine)) s -= 12;        // vary the day's cuisines
  if (neighbourProteins.includes(meal.protein)) s -= 14;  // not two beef nights running
  const seen = weekProteins.filter((p) => p === meal.protein).length;
  s -= seen * 6;                                          // spread proteins over the week

  // Keep the week's nutrition heading where it should: how close is this meal
  // to what the remaining slots still need?
  if (want) s -= fitPenalty(meal, want) * 5;
  if (chosen && isMeatless(meal)) s += meatlessPressure(chosen, slotTotal) * 30;

  return s + Math.random() * 7;                           // a little shuffle
}

/**
 * Build assignments for every enabled slot that is empty or unlocked.
 * Returns [{ day, slot, mealId }].
 */
export function generateWeek(weekIso, { onlyEmpty = false } = {}) {
  const plan = getPlan(weekIso);
  const assignments = [];

  const usedIds = new Set();
  const proteinByDay = {};
  const cuisineByDay = {};

  // What the week already carries, so the meals we pick top it up rather than
  // start from scratch. Locked meals are fixed points we plan around.
  const running = { kcal: 0, protein: 0, carbs: 0, fibre: 0, fat: 0 };
  const chosen = [];
  const plannedDays = DAYS.filter((d) => slotsForDay(d).length).length;
  const slotTotal = DAYS.reduce((n, d) => n + slotsForDay(d).length, 0);
  let slotsLeft = 0;

  // A meal we are keeping (locked, or untouched because we are only filling
  // gaps) counts towards the week. Everything else is ours to replace, so the
  // first pick already knows how much of the week is left to spread across.
  const keeping = (entry) => entry && (entry.locked || onlyEmpty);

  for (const day of DAYS) {
    for (const slot of slotsForDay(day)) {
      const entry = plan[slotKey(day, slot)];
      if (!keeping(entry)) { slotsLeft += 1; continue; }
      const meal = mealById(entry.mealId);
      if (!meal) { slotsLeft += 1; continue; }
      usedIds.add(meal.id);
      (proteinByDay[day] = proteinByDay[day] || []).push(meal.protein);
      (cuisineByDay[day] = cuisineByDay[day] || []).push(meal.cuisine);
      const n = nutritionOf(meal);
      for (const k of Object.keys(running)) running[k] += n[k] || 0;
      chosen.push(meal);
    }
  }

  DAYS.forEach((day, dayIndex) => {
    for (const slot of slotsForDay(day)) {
      const existing = plan[slotKey(day, slot)];
      if (existing && existing.locked) continue;
      if (onlyEmpty && existing) continue;

      const prev = DAYS[dayIndex - 1];
      const neighbourProteins = [
        ...(proteinByDay[day] || []),
        ...((prev && proteinByDay[prev]) || []),
      ];
      const weekProteins = Object.values(proteinByDay).flat();

      const want = idealNext(running, slotsLeft, plannedDays);
      const pool = candidatesFor(slot);
      let best = null;
      let bestScore = -Infinity;
      for (const meal of pool) {
        const value = score(meal, {
          day, slot, usedIds, neighbourProteins, weekProteins,
          dayCuisines: cuisineByDay[day] || [],
          want, chosen, slotTotal,
        });
        if (value > bestScore) { bestScore = value; best = meal; }
      }
      if (!best) continue;

      usedIds.add(best.id);
      (proteinByDay[day] = proteinByDay[day] || []).push(best.protein);
      (cuisineByDay[day] = cuisineByDay[day] || []).push(best.cuisine);
      const picked = nutritionOf(best);
      for (const k of Object.keys(running)) running[k] += picked[k] || 0;
      chosen.push(best);
      slotsLeft -= 1;
      assignments.push({ day, slot, mealId: best.id });
    }
  });

  return assignments;
}

/**
 * Every meal that could go in one slot, best first, judged on what the rest of
 * the week already provides. A swap should leave the week as balanced as it
 * found it, so the meals that plug the week's actual gap come out on top.
 *
 * Each entry carries `penalty` (lower is a better fit) and `good`, which marks
 * the handful worth putting a nudge beside in the picker.
 */
export function alternativesFor(weekIso, day, slot) {
  const pool = candidatesFor(slot);
  if (!pool.length) return [];

  const plan = getPlan(weekIso);
  const here = slotKey(day, slot);

  // The week as it stands with this slot emptied: what the replacement has to
  // make up on its own.
  const running = { kcal: 0, protein: 0, carbs: 0, fibre: 0, fat: 0 };
  const others = [];
  const elsewhere = new Set();
  const neighbourProteins = [];
  const dayIndex = DAYS.indexOf(day);
  const around = [DAYS[dayIndex - 1], day, DAYS[dayIndex + 1]].filter(Boolean);

  for (const d of DAYS) {
    for (const sl of slotsForDay(d)) {
      const key = slotKey(d, sl);
      if (key === here) continue;
      const meal = plan[key] && mealById(plan[key].mealId);
      if (!meal) continue;
      elsewhere.add(meal.id);
      others.push(meal);
      if (around.includes(d)) neighbourProteins.push(meal.protein);
      const n = nutritionOf(meal);
      for (const k of Object.keys(running)) running[k] += n[k] || 0;
    }
  }

  const plannedDays = DAYS.filter((d) => slotsForDay(d).length).length;
  const slotTotal = DAYS.reduce((n, d) => n + slotsForDay(d).length, 0);
  const want = idealNext(running, 1, plannedDays);
  const weekend = WEEKEND.includes(day);

  const ranked = pool
    .map((meal) => {
      let penalty = fitPenalty(meal, want);
      if (elsewhere.has(meal.id)) penalty += 3;                 // already on the plan
      if (neighbourProteins.includes(meal.protein)) penalty += 1;
      if (isMeatless(meal)) penalty -= meatlessPressure(others, slotTotal) * 6;
      if (slot === 'lunch' && (meal.weight || 2) >= 3) penalty += 0.8;
      if (slot === 'dinner' && !weekend && (meal.time || 30) > 45) penalty += 0.8;
      if (isFavourite(meal.id)) penalty -= 0.8;
      return { meal, penalty, balanced: keepsBalance(meal, running, plannedDays) };
    })
    .sort((a, b) => a.penalty - b.penalty);

  // One meal in fourteen barely shifts a seven-day average, so "still balanced"
  // is true of almost anything and would be a badge on every row. Flag the ones
  // that both keep the week in shape and are near the top of the ranking.
  const best = ranked.length ? ranked[0].penalty : 0;
  for (const a of ranked) a.good = a.balanced && a.penalty <= best + GOOD_FIT_MARGIN;
  return ranked;
}

/** The single best meal to drop into a slot — used by Hide and by shuffles. */
export function bestMealFor(weekIso, day, slot, { exclude = [] } = {}) {
  const skip = new Set(exclude);
  const found = alternativesFor(weekIso, day, slot).find((a) => !skip.has(a.meal.id));
  return found ? found.meal : null;
}

/**
 * The meal a swipe should reveal: the next sensible alternative for this slot.
 * Ordered by how well each one keeps the week balanced, so swiping walks from
 * the best fit outwards rather than alphabetically.
 */
export function nextMealFor(weekIso, day, slot, currentId, direction = 1) {
  const ranked = alternativesFor(weekIso, day, slot).map((a) => a.meal);
  if (!ranked.length) return null;

  // The ranking ignores whatever is in this slot right now, so it stays put
  // between swipes and stepping through it is stable in both directions.
  const start = ranked.findIndex((m) => m.id === currentId);
  const step = direction >= 0 ? 1 : -1;

  for (let i = 1; i <= ranked.length; i += 1) {
    const idx = (((start + i * step) % ranked.length) + ranked.length) % ranked.length;
    if (ranked[idx].id !== currentId) return ranked[idx];
  }
  return null;
}

/* -------------------------------------------------------- shopping list -- */

const ROUND_UNITS = { g: 5, ml: 10 };

function tidy(qty, unit) {
  const step = ROUND_UNITS[unit];
  if (step) return Math.round(qty / step) * step;
  if (!unit) return Math.ceil(qty);                 // you cannot buy 1.4 lemons
  return Math.round(qty * 4) / 4;                   // tbsp / tsp to the quarter
}

export function formatQty(qty, unit) {
  const value = Number.isInteger(qty) ? qty : Number(qty.toFixed(2));
  if (unit === 'g' && value >= 1000) return `${Number((value / 1000).toFixed(2))} kg`;
  if (unit === 'ml' && value >= 1000) return `${Number((value / 1000).toFixed(2))} l`;
  return unit ? `${value} ${unit}` : `${value}`;
}

/**
 * Roll every planned meal up into one list, scaled to the household size,
 * grouped by supermarket aisle.
 */
export function shoppingList(weekIso) {
  const people = Math.max(1, Number(getSettings().household) || 1);
  const plan = getPlan(weekIso);
  const items = new Map();
  const meals = [];

  for (const [key, entry] of Object.entries(plan)) {
    const [day, slot] = key.split('|');
    if (!slotsForDay(day).includes(slot)) continue;   // day switched off in Settings
    const meal = entry && mealById(entry.mealId);
    if (!meal) continue;
    meals.push(meal);

    for (const [name, qty, unit, scale, aisle] of meal.ingredients || []) {
      const amount = scale === 'person' ? qty * people : qty;
      const itemKey = `${name.toLowerCase()}|${unit}`;
      const found = items.get(itemKey);
      if (found) {
        found.qty += amount;
        if (!found.meals.includes(meal.name)) found.meals.push(meal.name);
      } else {
        items.set(itemKey, {
          key: itemKey, name, unit, qty: amount,
          aisle: AISLES.includes(aisle) ? aisle : 'other',
          meals: [meal.name],
        });
      }
    }
  }

  const groups = AISLES.map((aisle) => ({
    aisle,
    items: [...items.values()]
      .filter((i) => i.aisle === aisle)
      .map((i) => ({ ...i, qty: tidy(i.qty, i.unit) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.items.length);

  return { groups, mealCount: meals.length, itemCount: items.size, people };
}

export function shoppingListText(weekIso, weekLabelText) {
  const { groups, people } = shoppingList(weekIso);
  const lines = [`Shopping list — ${weekLabelText} (for ${people} ${people === 1 ? 'person' : 'people'})`, ''];
  for (const group of groups) {
    lines.push(group.aisle.toUpperCase());
    for (const item of group.items) lines.push(`  ${formatQty(item.qty, item.unit)} ${item.name}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}
