/**
 * Offline meal picking + shopping list maths.
 * Deliberately dumb-but-sensible: no network needed, instant, good enough
 * that the AI is a bonus rather than a dependency.
 */
import { AISLES } from './meals.js';
import {
  DAYS, allMeals, mealById, getPlan, slotKey, isFavourite, getSettings, slotsForDay,
} from './store.js';

const WEEKEND = ['Fri', 'Sat', 'Sun'];

/** Meals that make sense in this slot at all. */
export function candidatesFor(slot) {
  const pool = allMeals().filter((m) => (m.slots || ['lunch', 'dinner']).includes(slot));
  return pool.length ? pool : allMeals();
}

/**
 * Score a meal for a given position in the week.
 * Higher is better. `context` carries what is already planned around it.
 */
function score(meal, { day, slot, usedIds, neighbourProteins, weekProteins, dayCuisines }) {
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
  for (const [key, entry] of Object.entries(plan)) {
    if (!entry || !entry.locked) continue;
    const meal = mealById(entry.mealId);
    if (!meal) continue;
    usedIds.add(meal.id);
    const [day] = key.split('|');
    (proteinByDay[day] = proteinByDay[day] || []).push(meal.protein);
    (cuisineByDay[day] = cuisineByDay[day] || []).push(meal.cuisine);
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

      const pool = candidatesFor(slot);
      let best = null;
      let bestScore = -Infinity;
      for (const meal of pool) {
        const value = score(meal, {
          day, slot, usedIds, neighbourProteins, weekProteins,
          dayCuisines: cuisineByDay[day] || [],
        });
        if (value > bestScore) { bestScore = value; best = meal; }
      }
      if (!best) continue;

      usedIds.add(best.id);
      (proteinByDay[day] = proteinByDay[day] || []).push(best.protein);
      (cuisineByDay[day] = cuisineByDay[day] || []).push(best.cuisine);
      assignments.push({ day, slot, mealId: best.id });
    }
  });

  return assignments;
}

/**
 * The meal a swipe should reveal: the next sensible alternative for this slot,
 * skipping anything already on the plan that week.
 */
export function nextMealFor(weekIso, day, slot, currentId, direction = 1) {
  const pool = candidatesFor(slot);
  if (!pool.length) return null;

  const plan = getPlan(weekIso);
  const elsewhere = new Set(
    Object.entries(plan)
      .filter(([key]) => key !== slotKey(day, slot))
      .map(([, entry]) => entry && entry.mealId)
      .filter(Boolean),
  );

  const ordered = [...pool].sort((a, b) => a.name.localeCompare(b.name));
  const start = ordered.findIndex((m) => m.id === currentId);
  const step = direction >= 0 ? 1 : -1;

  for (let i = 1; i <= ordered.length; i += 1) {
    const idx = (((start + i * step) % ordered.length) + ordered.length) % ordered.length;
    const meal = ordered[idx];
    if (meal.id === currentId) continue;
    if (elsewhere.has(meal.id) && i < ordered.length) continue; // prefer something new
    return meal;
  }
  return ordered.find((m) => m.id !== currentId) || null;
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
