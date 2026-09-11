/**
 * All app state lives here, and nowhere else.
 * One JSON blob in localStorage — no backend, no accounts, no network.
 */
import { CATALOG } from './meals.js';

const KEY = 'mealplan.v1';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};
const SLOTS = ['lunch', 'dinner'];
const SLOT_NAMES = { lunch: 'Lunch', dinner: 'Dinner' };

/** Every day gets both meals until the user says otherwise. */
function everyDayBothMeals() {
  return Object.fromEntries(DAYS.map((day) => [day, [...SLOTS]]));
}

/** A complete, valid blank slate. */
function defaults() {
  return {
    version: 2,
    settings: {
      household: 2,
      daySlots: everyDayBothMeals(),
      ai: { key: '', model: 'deepseek/deepseek-chat-v3-0324:free', enabled: false },
    },
    customMeals: [],
    hidden: [],
    favourites: [],
    plans: {},
    checked: {},
  };
}

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return merge(JSON.parse(raw));
  } catch (err) {
    console.warn('Could not read saved plan, starting fresh.', err);
    return defaults();
  }
}

/** Lay saved data over a blank slate, then bring it up to the current shape. */
function merge(parsed) {
  const base = defaults();
  return migrate({
    ...base,
    ...parsed,
    settings: {
      ...base.settings,
      ...(parsed.settings || {}),
      ai: { ...base.settings.ai, ...((parsed.settings || {}).ai || {}) },
    },
  });
}

/**
 * v1 stored one list of slots for the whole week (and knew about breakfast).
 * v2 stores which meals to plan per day, lunch and dinner only.
 */
function migrate(state) {
  const settings = state.settings;
  // A v1 payload is identified by its settings.slots list; its choice wins over
  // the blank slate's daySlots that were merged underneath it.
  const legacy = Array.isArray(settings.slots) ? settings.slots.filter((x) => SLOTS.includes(x)) : null;
  const carried = legacy && legacy.length ? legacy : [...SLOTS];
  const saved = !legacy && settings.daySlots && typeof settings.daySlots === 'object'
    ? settings.daySlots
    : null;

  settings.daySlots = Object.fromEntries(DAYS.map((day) => {
    const list = saved ? saved[day] : carried;
    return [day, SLOTS.filter((slot) => Array.isArray(list) && list.includes(slot))];
  }));

  delete settings.slots;
  state.version = 2;
  return state;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not save — storage may be full or blocked.', err);
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Mutate state through here so every change is saved and re-rendered. */
export function update(fn) {
  fn(state);
  persist();
  listeners.forEach((l) => l());
}

export function getState() {
  return state;
}

export function getSettings() {
  return state.settings;
}

/* ---------------------------------------------------------------- dates -- */

/** ISO date (YYYY-MM-DD) of the Monday that starts the week containing `d`. */
export function weekKey(d = new Date()) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const shift = (date.getDay() + 6) % 7; // Sunday = 6
  date.setDate(date.getDate() - shift);
  return toISO(date);
}

export function toISO(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${day}`;
}

export function fromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function shiftWeek(iso, weeks) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + weeks * 7);
  return toISO(d);
}

export function dateOfDay(weekIso, day) {
  const d = fromISO(weekIso);
  d.setDate(d.getDate() + DAYS.indexOf(day));
  return d;
}

export function weekLabel(weekIso) {
  const start = fromISO(weekIso);
  const end = fromISO(weekIso);
  end.setDate(end.getDate() + 6);
  const fmt = (dt, withYear) =>
    dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  return `${fmt(start, false)} – ${fmt(end, true)}`;
}

export { DAYS, DAY_NAMES, SLOTS, SLOT_NAMES };

/* -------------------------------------------------------- planned slots -- */

/** Which meals are planned on this day, in lunch-then-dinner order. */
export function slotsForDay(day) {
  return state.settings.daySlots[day] || [];
}

export function isSlotOn(day, slot) {
  return slotsForDay(day).includes(slot);
}

export function toggleDaySlot(day, slot) {
  update((s) => {
    const on = new Set(s.settings.daySlots[day] || []);
    if (on.has(slot)) on.delete(slot); else on.add(slot);
    s.settings.daySlots[day] = SLOTS.filter((x) => on.has(x));
  });
}

/** Tapping a row label turns that meal on everywhere, or off everywhere. */
export function toggleSlotEveryDay(slot) {
  const turnOn = !DAYS.every((day) => isSlotOn(day, slot));
  update((s) => {
    for (const day of DAYS) {
      const on = new Set(s.settings.daySlots[day] || []);
      if (turnOn) on.add(slot); else on.delete(slot);
      s.settings.daySlots[day] = SLOTS.filter((x) => on.has(x));
    }
  });
}

/** Every day/slot pair that is switched on — the week the planner fills. */
export function plannedSlots() {
  return DAYS.flatMap((day) => slotsForDay(day).map((slot) => ({ day, slot })));
}

/* ---------------------------------------------------------------- meals -- */

/** Every meal the user can be served: catalogue + their own, minus hidden. */
export function allMeals() {
  return [...CATALOG, ...state.customMeals].filter((m) => !state.hidden.includes(m.id));
}

/** Including hidden ones — for the library screen. */
export function everyMeal() {
  return [...CATALOG, ...state.customMeals];
}

export function mealById(id) {
  return everyMeal().find((m) => m.id === id) || null;
}

export function isCustom(id) {
  return state.customMeals.some((m) => m.id === id);
}

export function isHidden(id) {
  return state.hidden.includes(id);
}

export function isFavourite(id) {
  return state.favourites.includes(id);
}

export function toggleFavourite(id) {
  update((s) => {
    const i = s.favourites.indexOf(id);
    if (i === -1) s.favourites.push(id);
    else s.favourites.splice(i, 1);
  });
}

export function toggleHidden(id) {
  update((s) => {
    const i = s.hidden.indexOf(id);
    if (i === -1) s.hidden.push(id);
    else s.hidden.splice(i, 1);
  });
}

export function addMeal(meal) {
  const id = `user-${slug(meal.name)}-${Math.random().toString(36).slice(2, 7)}`;
  update((s) => s.customMeals.push({ ...meal, id }));
  return id;
}

export function updateMeal(id, patch) {
  update((s) => {
    const meal = s.customMeals.find((m) => m.id === id);
    if (meal) Object.assign(meal, patch);
  });
}

export function deleteMeal(id) {
  update((s) => {
    s.customMeals = s.customMeals.filter((m) => m.id !== id);
    s.favourites = s.favourites.filter((f) => f !== id);
    for (const week of Object.values(s.plans)) {
      for (const [slotKey, entry] of Object.entries(week)) {
        if (entry && entry.mealId === id) delete week[slotKey];
      }
    }
  });
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'meal';
}

/* ----------------------------------------------------------------- plan -- */

export function slotKey(day, slot) {
  return `${day}|${slot}`;
}

export function getPlan(weekIso) {
  return state.plans[weekIso] || {};
}

export function getEntry(weekIso, day, slot) {
  return getPlan(weekIso)[slotKey(day, slot)] || null;
}

export function setEntry(weekIso, day, slot, mealId, opts = {}) {
  update((s) => {
    s.plans[weekIso] = s.plans[weekIso] || {};
    if (!mealId) {
      delete s.plans[weekIso][slotKey(day, slot)];
      return;
    }
    const existing = s.plans[weekIso][slotKey(day, slot)] || {};
    s.plans[weekIso][slotKey(day, slot)] = {
      mealId,
      locked: opts.locked !== undefined ? opts.locked : !!existing.locked,
    };
  });
}

export function toggleLock(weekIso, day, slot) {
  update((s) => {
    const entry = (s.plans[weekIso] || {})[slotKey(day, slot)];
    if (entry) entry.locked = !entry.locked;
  });
}

/** Swap the meals sitting in two slots (drag and drop). */
export function swapSlots(weekIso, a, b) {
  update((s) => {
    s.plans[weekIso] = s.plans[weekIso] || {};
    const week = s.plans[weekIso];
    const ka = slotKey(a.day, a.slot);
    const kb = slotKey(b.day, b.slot);
    const tmp = week[ka] || null;
    if (week[kb]) week[ka] = week[kb]; else delete week[ka];
    if (tmp) week[kb] = tmp; else delete week[kb];
  });
}

export function clearWeek(weekIso, { keepLocked = true } = {}) {
  update((s) => {
    const week = s.plans[weekIso] || {};
    for (const [key, entry] of Object.entries(week)) {
      if (keepLocked && entry.locked) continue;
      delete week[key];
    }
    delete s.checked[weekIso];
  });
}

/** Write a whole week at once, leaving locked slots untouched. */
export function applyPlan(weekIso, assignments) {
  update((s) => {
    s.plans[weekIso] = s.plans[weekIso] || {};
    const week = s.plans[weekIso];
    for (const { day, slot, mealId } of assignments) {
      const key = slotKey(day, slot);
      if (week[key] && week[key].locked) continue;
      if (mealId) week[key] = { mealId, locked: false };
      else delete week[key];
    }
  });
}

/* -------------------------------------------------------- shopping list -- */

export function isChecked(weekIso, itemKey) {
  return (state.checked[weekIso] || []).includes(itemKey);
}

export function toggleChecked(weekIso, itemKey) {
  update((s) => {
    const list = s.checked[weekIso] || (s.checked[weekIso] = []);
    const i = list.indexOf(itemKey);
    if (i === -1) list.push(itemKey);
    else list.splice(i, 1);
  });
}

export function resetChecked(weekIso) {
  update((s) => delete s.checked[weekIso]);
}

/* -------------------------------------------------------- import/export -- */

export function exportData() {
  return JSON.stringify(state, null, 2);
}

export function importData(json) {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') throw new Error('That file does not look like a MealPlan backup.');
  update((s) => Object.assign(s, merge(parsed)));
}

export function resetAll() {
  update((s) => Object.assign(s, defaults()));
}
