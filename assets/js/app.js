/**
 * MealPlan — a static, offline, account-free weekly meal planner.
 * Everything is rendered by hand; state changes re-render the active view.
 */
import {
  DAYS, DAY_NAMES, SLOTS, SLOT_NAMES,
  slotsForDay, isSlotOn, toggleDaySlot, toggleSlotEveryDay, plannedSlots,
  subscribe, update, getSettings, weekKey, shiftWeek, weekLabel, dateOfDay, toISO,
  allMeals, everyMeal, mealById, isCustom, isHidden, isFavourite,
  toggleFavourite, toggleHidden, addMeal, deleteMeal,
  getEntry, setEntry, toggleLock, swapSlots, clearWeek, applyPlan,
  isChecked, toggleChecked, resetChecked, exportData, importData, resetAll, getState,
} from './store.js';
import { AISLES } from './meals.js';
import {
  generateWeek, nextMealFor, candidatesFor, shoppingList, shoppingListText, formatQty,
} from './planner.js';
import { planWeekWithAI, fetchFreeModels, FALLBACK_FREE_MODELS } from './ai.js';

/* ------------------------------------------------------------- helpers -- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const AISLE_LABELS = {
  produce: 'Fruit & veg', meat: 'Meat', fish: 'Fish', dairy: 'Dairy & eggs',
  bakery: 'Bakery', pantry: 'Cupboard', frozen: 'Frozen', other: 'Other',
};

const UNITS = ['', 'g', 'kg', 'ml', 'l', 'tbsp', 'tsp', 'cloves', 'bunch', 'slices', 'nest', 'ball', 'loaf', 'roll', 'sticks', 'thumb'];
const PROTEINS = ['veg', 'chicken', 'beef', 'pork', 'fish', 'egg', 'cheese', 'mixed'];

let currentWeek = weekKey();
let currentView = 'week';
let libraryFilter = 'all';
let librarySearch = '';
let aiBusy = false;

function haptic(ms = 12) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (_) { /* ignore */ } }
}

/**
 * After a touch gesture the browser still fires a synthetic click at the same
 * point. If a sheet has just opened there, that click lands on the sheet (or
 * the scrim) and undoes what the tap just did — so eat exactly one.
 */
function swallowNextClick() {
  const handler = (e) => { e.stopPropagation(); e.preventDefault(); };
  document.addEventListener('click', handler, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', handler, { capture: true }), 400);
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-open'), 2600);
}

/* --------------------------------------------------------------- sheet -- */

let sheetCleanup = null;

function openSheet(html, onMount) {
  const sheet = $('#sheet');
  $('#sheetBody').innerHTML = html;
  sheet.classList.add('is-open');
  sheet.setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('is-open');
  document.body.style.overflow = 'hidden';
  sheetCleanup = typeof onMount === 'function' ? onMount($('#sheetBody')) : null;
}

function closeSheet() {
  const sheet = $('#sheet');
  if (!sheet.classList.contains('is-open')) return;
  sheet.classList.remove('is-open');
  sheet.setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('is-open');
  document.body.style.overflow = '';
  if (typeof sheetCleanup === 'function') sheetCleanup();
  sheetCleanup = null;
}

const sheetIsOpen = () => $('#sheet').classList.contains('is-open');

/* ------------------------------------------------------------ fragments -- */

function artHTML(meal, size = '') {
  const cls = size ? ` art--${size}` : '';
  if (!meal) return `<div class="art${cls}" style="--hue:28;opacity:.35">＋</div>`;
  return `<div class="art${cls}" style="--hue:${Number(meal.hue) || 20}">${esc(meal.emoji || '🍽️')}</div>`;
}

/** Padlock, open or shut — drawn so it tints with the button's colour. */
function lockIcon(locked) {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="4" y="10.5" width="16" height="11" rx="2.6"></rect>
    <path d="${locked ? 'M8 10.5V7a4 4 0 0 1 8 0v3.5' : 'M8 10.5V7a4 4 0 0 1 7.7-1.5'}"></path>
  </svg>`;
}

function mealMeta(meal) {
  const weight = { 1: 'light', 2: 'medium', 3: 'hearty' }[meal.weight || 2];
  return `${esc(meal.cuisine || 'Home cooking')} · ${meal.time || 30} min · ${weight}`;
}

/* ----------------------------------------------------------- week view -- */

function relativeWeek(iso) {
  const diff = Math.round((new Date(iso) - new Date(weekKey())) / 604800000);
  if (diff === 0) return 'This week';
  if (diff === 1) return 'Next week';
  if (diff === -1) return 'Last week';
  return diff > 0 ? `In ${diff} weeks` : `${Math.abs(diff)} weeks ago`;
}

function renderWeek() {
  const todayISO = toISO(new Date());

  $('#weekLabel').textContent = weekLabel(currentWeek);
  $('#weekRelative').textContent = relativeWeek(currentWeek);
  $('#brandSub').textContent = relativeWeek(currentWeek).toLowerCase();

  $('#weekGrid').innerHTML = DAYS.map((day) => {
    const date = dateOfDay(currentWeek, day);
    const isToday = toISO(date) === todayISO;

    const rows = slotsForDay(day).map((slot) => {
      const entry = getEntry(currentWeek, day, slot);
      const meal = entry ? mealById(entry.mealId) : null;

      if (!meal) {
        return `
          <div class="slot" data-day="${day}" data-slot="${slot}">
            <div class="slot__card is-empty" role="button" tabindex="0"
                 aria-label="${DAY_NAMES[day]} ${SLOT_NAMES[slot].toLowerCase()}: empty, choose a meal">
              ${artHTML(null)}
              <div class="slot__text">
                <div class="slot__label">${SLOT_NAMES[slot]}</div>
                <div class="slot__name" style="color:var(--muted);font-weight:500">Tap to choose a meal</div>
              </div>
            </div>
          </div>`;
      }

      const fav = isFavourite(meal.id);
      return `
        <div class="slot" data-day="${day}" data-slot="${slot}">
          <div class="slot__hint" aria-hidden="true"><span>↺ swap</span><span>swap ↻</span></div>
          <div class="slot__card" role="button" tabindex="0"
               aria-label="${DAY_NAMES[day]} ${SLOT_NAMES[slot].toLowerCase()}: ${esc(meal.name)}">
            ${artHTML(meal)}
            <div class="slot__text">
              <div class="slot__label">${SLOT_NAMES[slot]}</div>
              <div class="slot__name">${esc(meal.name)}</div>
              <div class="slot__meta">${mealMeta(meal)}</div>
            </div>
            <div class="slot__acts">
              <button class="slot__act${entry.locked ? ' is-on' : ''}" type="button" data-slot-act="lock"
                      aria-pressed="${entry.locked}"
                      title="${entry.locked ? 'Unlock this slot' : 'Lock this slot'}"
                      aria-label="${entry.locked ? 'Unlock' : 'Lock'} ${esc(meal.name)} on ${DAY_NAMES[day]}">
                ${lockIcon(entry.locked)}
              </button>
              <button class="slot__act slot__act--fav${fav ? ' is-on' : ''}" type="button" data-slot-act="fav"
                      aria-pressed="${fav}"
                      title="${fav ? 'Remove from favourites' : 'Add to favourites'}"
                      aria-label="${fav ? 'Unfavourite' : 'Favourite'} ${esc(meal.name)}">
                ${fav ? '★' : '☆'}
              </button>
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <section class="card day${isToday ? ' is-today' : ''}${rows ? '' : ' day--off'}">
        <header class="day__head">
          <h3>${DAY_NAMES[day]}</h3>
          <span class="day__date">${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
          ${isToday ? '<span class="day__badge">Today</span>' : ''}
        </header>
        ${rows
          ? `<div class="slots">${rows}</div>`
          : '<p class="day__off">Not planning meals this day</p>'}
      </section>`;
  }).join('');
}

/* -------------------------------------------------------- meal sheets -- */

function openSlotSheet(day, slot) {
  const entry = getEntry(currentWeek, day, slot);
  const meal = entry ? mealById(entry.mealId) : null;
  if (!meal) { openPicker(day, slot); return; }

  const people = Math.max(1, Number(getSettings().household) || 1);
  const ingredients = (meal.ingredients || []).map(([name, qty, unit, scale]) => {
    const amount = scale === 'person' ? qty * people : qty;
    return `<li><span>${esc(name)}</span><b>${esc(formatQty(amount, unit))}</b></li>`;
  }).join('');

  openSheet(`
    <div class="detail">
      ${artHTML(meal, 'lg')}
      <div>
        <h2>${esc(meal.name)}</h2>
        <p class="sheet__sub" style="margin:2px 0 0">${DAY_NAMES[day]} · ${SLOT_NAMES[slot].toLowerCase()}</p>
      </div>
    </div>
    <div class="chips">
      <span class="chip chip--accent">${esc(meal.cuisine || 'Home cooking')}</span>
      <span class="chip">${esc(meal.protein || 'mixed')}</span>
      <span class="chip">${meal.time || 30} min</span>
      <span class="chip chip--green">for ${people} ${people === 1 ? 'person' : 'people'}</span>
    </div>
    ${meal.note ? `<p class="note">${esc(meal.note)}</p>` : ''}
    <ul class="ing">${ingredients || '<li><span style="color:var(--muted)">No ingredients listed</span></li>'}</ul>
    <div class="sheet__actions">
      <button class="btn btn--primary btn--wide" data-act="swap">🔀 Choose another meal</button>
      <button class="btn" data-act="lock">${entry.locked ? '🔓 Unlock' : '🔒 Lock'}</button>
      <button class="btn" data-act="fav">${isFavourite(meal.id) ? '★ Favourited' : '☆ Favourite'}</button>
      <button class="btn btn--ghost btn--wide" data-act="clear">Clear this slot</button>
    </div>
  `, (root) => {
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const which = act.dataset.act;
      if (which === 'swap') { openPicker(day, slot); return; }
      if (which === 'lock') toggleLock(currentWeek, day, slot);
      if (which === 'fav') toggleFavourite(meal.id);
      if (which === 'clear') setEntry(currentWeek, day, slot, null);
      closeSheet();
    });
  });
}

function openPicker(day, slot) {
  const entry = getEntry(currentWeek, day, slot);
  const currentId = entry ? entry.mealId : null;

  const list = (query) => {
    const q = query.trim().toLowerCase();
    return candidatesFor(slot)
      .filter((m) => !q || m.name.toLowerCase().includes(q) || (m.cuisine || '').toLowerCase().includes(q))
      .sort((a, b) => {
        const fav = Number(isFavourite(b.id)) - Number(isFavourite(a.id));
        return fav || a.name.localeCompare(b.name);
      })
      .map((m) => `
        <button class="picker-item${m.id === currentId ? ' is-current' : ''}" type="button" data-meal="${esc(m.id)}">
          ${artHTML(m, 'sm')}
          <div class="picker-item__text">
            <b>${esc(m.name)}</b>
            <span>${mealMeta(m)}</span>
          </div>
          ${isFavourite(m.id) ? '<span>★</span>' : ''}
        </button>`).join('');
  };

  openSheet(`
    <h2>${SLOT_NAMES[slot]} on ${DAY_NAMES[day]}</h2>
    <p class="sheet__sub">Pick a meal, or search for one</p>
    <label class="field">
      <span class="sr-only">Search</span>
      <input class="input" type="search" id="pickerSearch" placeholder="Search meals…" autocomplete="off">
    </label>
    <div class="picker-list" id="pickerList">${list('')}</div>
  `, (root) => {
    const search = $('#pickerSearch', root);
    search.addEventListener('input', () => { $('#pickerList', root).innerHTML = list(search.value); });
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-meal]');
      if (!btn) return;
      setEntry(currentWeek, day, slot, btn.dataset.meal);
      haptic();
      closeSheet();
    });
  });
}

/* ---------------------------------------------------------- gestures --- */
/**
 * One pointer gesture on a slot card can become:
 *   swipe sideways -> swap in a different meal
 *   press and hold -> pick the card up and drop it on another slot
 *   tap            -> open the meal card
 */
const SWIPE_TRIGGER = 78;
const HOLD_MS = 380;
let gesture = null;

function resetCard(card) {
  card.style.transition = 'transform .2s ease';
  card.style.transform = '';
  card.style.pointerEvents = '';
  card.classList.remove('is-dragging');
  setTimeout(() => { if (card.isConnected) card.style.transition = ''; }, 210);
}

function clearDropTargets() {
  $$('.slot.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
}

function onPointerDown(e) {
  if (e.button != null && e.button !== 0) return;
  const card = e.target.closest('.slot__card');
  if (!card) return;
  const slotEl = card.closest('.slot');
  const entry = getEntry(currentWeek, slotEl.dataset.day, slotEl.dataset.slot);

  gesture = {
    card, slotEl, entry,
    // A gesture may begin on the lock/favourite buttons: a still tap presses
    // them, but any movement is still a swipe or a drag of the whole card.
    onAct: !!e.target.closest('[data-slot-act]'),
    day: slotEl.dataset.day, slot: slotEl.dataset.slot,
    x: e.clientX, y: e.clientY, t: Date.now(),
    mode: 'pending', pointerId: e.pointerId,
    hold: setTimeout(() => {
      if (!gesture || gesture.mode !== 'pending' || !gesture.entry) return;
      gesture.mode = 'drag';
      card.classList.add('is-dragging');
      card.style.pointerEvents = 'none';
      card.style.transition = 'none';
      haptic(18);
    }, HOLD_MS),
  };
}

function onPointerMove(e) {
  if (!gesture || e.pointerId !== gesture.pointerId) return;
  const dx = e.clientX - gesture.x;
  const dy = e.clientY - gesture.y;

  if (gesture.mode === 'pending') {
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
      clearTimeout(gesture.hold);
      gesture.mode = 'swipe';
      gesture.card.style.transition = 'none';
      try { gesture.card.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    } else if (Math.abs(dy) > 12) {
      endGesture(true);
    }
    return;
  }

  if (gesture.mode === 'swipe') {
    const pull = gesture.entry ? dx : dx * 0.25;                 // empty slots barely move
    gesture.card.style.transform = `translateX(${pull}px) rotate(${pull * 0.015}deg)`;
    return;
  }

  if (gesture.mode === 'drag') {
    gesture.card.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under && under.closest('.slot');
    clearDropTargets();
    if (target && target !== gesture.slotEl) target.classList.add('is-drop-target');
  }
}

function onPointerUp(e) {
  if (!gesture || (e && e.pointerId !== gesture.pointerId)) return;
  const g = gesture;
  clearTimeout(g.hold);
  const dx = e ? e.clientX - g.x : 0;
  const elapsed = Date.now() - g.t;

  if (g.mode === 'drag') {
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under && under.closest('.slot');
    clearDropTargets();
    gesture = null;
    if (g.onAct) swallowNextClick();
    if (target && target !== g.slotEl) {
      swapSlots(currentWeek, { day: g.day, slot: g.slot },
        { day: target.dataset.day, slot: target.dataset.slot });
      haptic(22);
      toast('Meals swapped');
      return;                                                    // re-render clears styles
    }
    resetCard(g.card);
    return;
  }

  if (g.mode === 'swipe') {
    gesture = null;
    if (g.onAct) swallowNextClick();
    if (Math.abs(dx) < SWIPE_TRIGGER) { resetCard(g.card); return; }

    if (!g.entry) {                                              // empty slot: just open the picker
      resetCard(g.card);
      swallowNextClick();
      openPicker(g.day, g.slot);
      return;
    }
    if (g.entry.locked) {
      resetCard(g.card);
      toast('That slot is locked — tap it to unlock');
      return;
    }

    const direction = dx > 0 ? 1 : -1;
    const next = nextMealFor(currentWeek, g.day, g.slot, g.entry.mealId, direction);
    if (!next) { resetCard(g.card); toast('No other meal fits this slot'); return; }

    g.card.style.transition = 'transform .16s ease, opacity .16s ease';
    g.card.style.transform = `translateX(${direction * 420}px)`;
    g.card.style.opacity = '0';
    haptic();
    setTimeout(() => setEntry(currentWeek, g.day, g.slot, next.id), 140);
    return;
  }

  gesture = null;
  resetCard(g.card);
  if (g.onAct) return;                                 // its own click handler takes it
  if (g.mode === 'pending' && elapsed < 700) {
    swallowNextClick();
    openSlotSheet(g.day, g.slot);
  }
}

function endGesture(silent) {
  if (!gesture) return;
  clearTimeout(gesture.hold);
  clearDropTargets();
  if (!silent) resetCard(gesture.card);
  else { gesture.card.style.transform = ''; gesture.card.style.pointerEvents = ''; gesture.card.classList.remove('is-dragging'); }
  gesture = null;
}

function bindGestures() {
  const grid = $('#weekGrid');

  grid.addEventListener('click', (e) => {
    const act = e.target.closest('[data-slot-act]');
    if (!act) return;
    const slotEl = act.closest('.slot');
    const entry = getEntry(currentWeek, slotEl.dataset.day, slotEl.dataset.slot);
    if (!entry) return;
    if (act.dataset.slotAct === 'lock') toggleLock(currentWeek, slotEl.dataset.day, slotEl.dataset.slot);
    else toggleFavourite(entry.mealId);
    haptic(10);
  });

  // The card is a div so it can hold real buttons; give it the keyboard back.
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('[data-slot-act]')) return;
    const card = e.target.closest('.slot__card');
    if (!card) return;
    e.preventDefault();
    const slotEl = card.closest('.slot');
    openSlotSheet(slotEl.dataset.day, slotEl.dataset.slot);
  });

  grid.addEventListener('pointerdown', onPointerDown);
  grid.addEventListener('pointermove', onPointerMove);
  grid.addEventListener('pointerup', onPointerUp);
  grid.addEventListener('pointercancel', () => endGesture(false));
  // While a card is picked up, stop the page scrolling underneath it.
  grid.addEventListener('touchmove', (e) => {
    if (gesture && gesture.mode === 'drag' && e.cancelable) e.preventDefault();
  }, { passive: false });
}

/* ------------------------------------------------------- plan the week -- */

async function planWeek() {
  const settings = getSettings();
  const btn = $('#btnGenerate');
  const useAI = settings.ai.enabled && settings.ai.key;

  if (!useAI) {
    applyPlan(currentWeek, generateWeek(currentWeek));
    haptic(16);
    toast('Week planned');
    return;
  }

  if (aiBusy) return;
  aiBusy = true;
  const label = btn.innerHTML;
  btn.innerHTML = '<span class="spin"></span> Asking the model…';
  btn.disabled = true;

  try {
    const plan = [];
    const locked = [];
    for (const { day, slot } of plannedSlots()) {
      {
        const entry = getEntry(currentWeek, day, slot);
        if (entry && entry.locked) {
          const meal = mealById(entry.mealId);
          if (meal) locked.push({ day, slot, id: meal.id, name: meal.name });
        } else {
          plan.push({ day, slot });
        }
      }
    }

    const { assignments, note, skipped } = await planWeekWithAI({
      key: settings.ai.key,
      model: settings.ai.model,
      meals: allMeals(),
      targets: plan,
      locked,
      household: settings.household,
      favourites: allMeals().filter((m) => isFavourite(m.id)).map((m) => m.name),
    });

    applyPlan(currentWeek, assignments);

    if (skipped > 0) {                                   // fill any gaps offline
      const filled = new Set(assignments.map((a) => `${a.day}|${a.slot}`));
      const rest = generateWeek(currentWeek).filter((a) => !filled.has(`${a.day}|${a.slot}`));
      applyPlan(currentWeek, rest);
    }
    toast(note ? note.slice(0, 90) : 'Week planned by AI');
  } catch (err) {
    console.warn(err);
    applyPlan(currentWeek, generateWeek(currentWeek));
    toast(`${err.message} Used the offline planner instead.`);
  } finally {
    aiBusy = false;
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

/* ------------------------------------------------------- shopping view -- */

function renderShopping() {
  const { groups, mealCount, itemCount, people } = shoppingList(currentWeek);
  const body = $('#shopBody');

  if (!itemCount) {
    body.innerHTML = `
      <div class="empty">
        <strong>Nothing to buy yet</strong>
        Plan some meals for this week, then generate the list.
      </div>`;
    return;
  }

  const done = groups.flatMap((g) => g.items).filter((i) => isChecked(currentWeek, i.key)).length;

  body.innerHTML = `
    <div class="card shop-summary">
      <div><b>${mealCount}</b><span>meals</span></div>
      <div><b>${itemCount}</b><span>items</span></div>
      <div><b>${people}</b><span>${people === 1 ? 'person' : 'people'}</span></div>
      <div style="margin-left:auto;text-align:right"><b>${done}/${itemCount}</b><span>in the basket</span></div>
    </div>
    ${groups.map((group) => `
      <div class="aisle">
        <div class="aisle__head">${esc(AISLE_LABELS[group.aisle] || group.aisle)}</div>
        <div class="card">
          ${group.items.map((item) => `
            <button class="shop-item${isChecked(currentWeek, item.key) ? ' is-done' : ''}" type="button" data-item="${esc(item.key)}">
              <span class="shop-item__box">✓</span>
              <span class="shop-item__name">${esc(item.name)}<small>${esc(item.meals.slice(0, 2).join(' · '))}${item.meals.length > 2 ? ` +${item.meals.length - 2} more` : ''}</small></span>
              <span class="shop-item__qty">${esc(formatQty(item.qty, item.unit))}</span>
            </button>`).join('')}
        </div>
      </div>`).join('')}`;
}

async function copyShoppingList() {
  const text = shoppingListText(currentWeek, weekLabel(currentWeek));
  if (!text) { toast('Nothing to copy yet'); return; }
  try {
    if (navigator.share && /iphone|ipad|android/i.test(navigator.userAgent)) {
      await navigator.share({ title: 'Shopping list', text });
      return;
    }
    await navigator.clipboard.writeText(text);
    toast('Shopping list copied');
  } catch (_) {
    openSheet(`
      <h2>Shopping list</h2>
      <p class="sheet__sub">Select and copy</p>
      <textarea class="input" rows="14" readonly>${esc(text)}</textarea>`);
  }
}

/* -------------------------------------------------------- library view -- */

function renderLibrary() {
  const q = librarySearch.trim().toLowerCase();
  const meals = everyMeal()
    .filter((m) => {
      if (libraryFilter === 'fav' && !isFavourite(m.id)) return false;
      if (libraryFilter === 'mine' && !isCustom(m.id)) return false;
      if (libraryFilter === 'off' && !isHidden(m.id)) return false;
      if (libraryFilter !== 'off' && isHidden(m.id)) return false;
      if (q && !m.name.toLowerCase().includes(q) && !(m.cuisine || '').toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  $$('#mealFilters button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === libraryFilter)));

  $('#mealLibrary').innerHTML = meals.length ? meals.map((m) => `
    <div class="card">
      <div class="meal-row${isHidden(m.id) ? ' is-off' : ''}">
        <button class="meal-row" style="padding:0;background:none;border:none" type="button" data-open="${esc(m.id)}">
          ${artHTML(m)}
          <span class="meal-row__text">
            <b>${esc(m.name)}</b>
            <span>${mealMeta(m)}${isCustom(m.id) ? ' · yours' : ''}</span>
          </span>
        </button>
        <button class="meal-row__fav" type="button" data-fav="${esc(m.id)}" aria-label="Favourite ${esc(m.name)}">
          ${isFavourite(m.id) ? '★' : '☆'}
        </button>
      </div>
    </div>`).join('') : `
    <div class="empty" style="grid-column:1/-1">
      <strong>No meals here</strong>
      ${libraryFilter === 'mine' ? 'Add your own with the button above.' : 'Try another filter or search.'}
    </div>`;
}

function openMealSheet(id) {
  const meal = mealById(id);
  if (!meal) return;
  const people = Math.max(1, Number(getSettings().household) || 1);
  const ingredients = (meal.ingredients || []).map(([name, qty, unit, scale]) => {
    const amount = scale === 'person' ? qty * people : qty;
    return `<li><span>${esc(name)}</span><b>${esc(formatQty(amount, unit))}</b></li>`;
  }).join('');

  openSheet(`
    <div class="detail">
      ${artHTML(meal, 'lg')}
      <div>
        <h2>${esc(meal.name)}</h2>
        <p class="sheet__sub" style="margin:2px 0 0">${mealMeta(meal)}</p>
      </div>
    </div>
    <div class="chips">
      <span class="chip chip--accent">${esc(meal.protein || 'mixed')}</span>
      ${(meal.slots || []).map((s) => `<span class="chip">${SLOT_NAMES[s]}</span>`).join('')}
      <span class="chip chip--green">for ${people}</span>
    </div>
    ${meal.note ? `<p class="note">${esc(meal.note)}</p>` : ''}
    <ul class="ing">${ingredients || '<li><span style="color:var(--muted)">No ingredients listed</span></li>'}</ul>
    <div class="sheet__actions">
      <button class="btn btn--primary btn--wide" data-act="add">📅 Put it in this week</button>
      <button class="btn" data-act="fav">${isFavourite(meal.id) ? '★ Favourited' : '☆ Favourite'}</button>
      <button class="btn" data-act="hide">${isHidden(meal.id) ? '👁️ Unhide' : '🚫 Hide'}</button>
      ${isCustom(meal.id) ? '<button class="btn btn--ghost btn--danger btn--wide" data-act="delete">Delete this meal</button>' : ''}
    </div>
  `, (root) => {
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'fav') { toggleFavourite(meal.id); closeSheet(); }
      if (act.dataset.act === 'hide') { toggleHidden(meal.id); closeSheet(); }
      if (act.dataset.act === 'add') { closeSheet(); openSlotChooser(meal.id); }
      if (act.dataset.act === 'delete') {
        if (confirm(`Delete "${meal.name}"?`)) { deleteMeal(meal.id); closeSheet(); toast('Meal deleted'); }
      }
    });
  });
}

/** "Put it in this week" — pick which day and slot. */
function openSlotChooser(mealId) {
  const meal = mealById(mealId);
  const rows = plannedSlots().map(({ day, slot }) => {
    const entry = getEntry(currentWeek, day, slot);
    const current = entry ? mealById(entry.mealId) : null;
    return `
      <button class="picker-item" type="button" data-day="${day}" data-slot="${slot}">
        ${artHTML(current, 'sm')}
        <div class="picker-item__text">
          <b>${DAY_NAMES[day]} · ${SLOT_NAMES[slot].toLowerCase()}</b>
          <span>${current ? `currently ${esc(current.name)}` : 'free'}</span>
        </div>
        ${entry && entry.locked ? '<span>🔒</span>' : ''}
      </button>`;
  }).join('');

  openSheet(`
    <h2>Where should it go?</h2>
    <p class="sheet__sub">${esc(meal.name)} · ${weekLabel(currentWeek)}</p>
    <div class="picker-list">${rows}</div>
  `, (root) => {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-day]');
      if (!btn) return;
      setEntry(currentWeek, btn.dataset.day, btn.dataset.slot, mealId, { locked: false });
      closeSheet();
      showView('week');
      toast(`Added to ${DAY_NAMES[btn.dataset.day]}`);
    });
  });
}

/* ---------------------------------------------------------- add a meal -- */

function ingredientRow(row = ['', 1, 'g', 'person', 'pantry']) {
  const [name, qty, unit, scale, aisle] = row;
  return `
    <div class="ing-row">
      <input class="input" data-f="name" placeholder="Ingredient" value="${esc(name)}">
      <input class="input" data-f="qty" type="number" min="0" step="any" value="${esc(qty)}" aria-label="Quantity">
      <select class="input" data-f="unit" aria-label="Unit">
        ${UNITS.map((u) => `<option value="${u}"${u === unit ? ' selected' : ''}>${u || 'each'}</option>`).join('')}
      </select>
      <select class="input" data-f="scale" aria-label="Scaling">
        <option value="person"${scale === 'person' ? ' selected' : ''}>per person</option>
        <option value="dish"${scale === 'dish' ? ' selected' : ''}>total</option>
      </select>
      <select class="input" data-f="aisle" aria-label="Aisle">
        ${AISLES.map((a) => `<option value="${a}"${a === aisle ? ' selected' : ''}>${esc(AISLE_LABELS[a] || a)}</option>`).join('')}
      </select>
      <button class="btn btn--ghost btn--sm" type="button" data-remove aria-label="Remove ingredient">✕</button>
    </div>`;
}

function openAddMealSheet() {
  openSheet(`
    <h2>Add a meal</h2>
    <p class="sheet__sub">Stored in this browser, alongside the built-in ones</p>

    <div class="detail" style="margin-bottom:14px">
      <div class="art art--lg" id="previewArt" style="--hue:20">🍽️</div>
      <label class="field" style="flex:1;margin:0">
        <span>Name</span>
        <input class="input" id="mName" placeholder="Grandma's ragù" autocomplete="off">
      </label>
    </div>

    <div class="field-row" style="grid-template-columns:92px 1fr;align-items:end">
      <label class="field" style="margin:0">
        <span>Emoji</span>
        <input class="input" id="mEmoji" value="🍽️" maxlength="4" style="text-align:center">
      </label>
      <label class="field" style="margin:0">
        <span>Colour</span>
        <input class="hue-slider" id="mHue" type="range" min="0" max="360" value="20">
      </label>
    </div>

    <div class="field-row">
      <label class="field"><span>Cuisine</span><input class="input" id="mCuisine" placeholder="Italian" autocomplete="off"></label>
      <label class="field"><span>Main protein</span>
        <select class="input" id="mProtein">${PROTEINS.map((p) => `<option>${p}</option>`).join('')}</select>
      </label>
    </div>

    <div class="field-row">
      <label class="field"><span>Minutes</span><input class="input" id="mTime" type="number" min="5" max="480" value="30"></label>
      <label class="field"><span>How hearty</span>
        <select class="input" id="mWeight">
          <option value="1">Light</option>
          <option value="2" selected>Medium</option>
          <option value="3">Hearty</option>
        </select>
      </label>
    </div>

    <div class="field">
      <span>Good for</span>
      <div class="segmented" id="mSlots">
        <button type="button" data-slot="lunch" aria-pressed="true">Lunch</button>
        <button type="button" data-slot="dinner" aria-pressed="true">Dinner</button>
      </div>
    </div>

    <label class="field"><span>Note (optional)</span>
      <textarea class="input" id="mNote" placeholder="Anything you want to remember about it"></textarea>
    </label>

    <div class="field">
      <span>Ingredients — used for the shopping list</span>
      <div id="ingRows">${ingredientRow()}</div>
      <button class="btn btn--sm" type="button" id="btnAddIng" style="margin-top:8px">＋ Add ingredient</button>
    </div>

    <div class="sheet__actions">
      <button class="btn btn--primary btn--wide" id="btnSaveMeal">Save meal</button>
      <button class="btn btn--ghost btn--wide" id="btnCancelMeal">Cancel</button>
    </div>
  `, (root) => {
    const emoji = $('#mEmoji', root);
    const hue = $('#mHue', root);
    const preview = $('#previewArt', root);
    const sync = () => {
      preview.textContent = emoji.value || '🍽️';
      preview.style.setProperty('--hue', hue.value);
    };
    emoji.addEventListener('input', sync);
    hue.addEventListener('input', sync);

    $('#mSlots', root).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-slot]');
      if (!btn) return;
      btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
    });

    $('#btnAddIng', root).addEventListener('click', () => {
      $('#ingRows', root).insertAdjacentHTML('beforeend', ingredientRow(['', 1, 'g', 'person', 'pantry']));
    });

    $('#ingRows', root).addEventListener('click', (e) => {
      if (!e.target.closest('[data-remove]')) return;
      const rows = $$('.ing-row', root);
      if (rows.length > 1) e.target.closest('.ing-row').remove();
      else rows[0].querySelectorAll('input').forEach((i) => { i.value = i.dataset.f === 'qty' ? '1' : ''; });
    });

    $('#btnCancelMeal', root).addEventListener('click', closeSheet);

    $('#btnSaveMeal', root).addEventListener('click', () => {
      const name = $('#mName', root).value.trim();
      if (!name) { toast('Give the meal a name'); $('#mName', root).focus(); return; }

      const slots = $$('#mSlots [data-slot]', root)
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.dataset.slot);

      const ingredients = $$('.ing-row', root).map((row) => {
        const get = (f) => $(`[data-f="${f}"]`, row).value;
        const ingName = get('name').trim();
        if (!ingName) return null;
        return [ingName, Number(get('qty')) || 1, get('unit'), get('scale'), get('aisle')];
      }).filter(Boolean);

      addMeal({
        name,
        emoji: emoji.value.trim() || '🍽️',
        hue: Number(hue.value) || 20,
        cuisine: $('#mCuisine', root).value.trim() || 'Home cooking',
        protein: $('#mProtein', root).value,
        time: Number($('#mTime', root).value) || 30,
        weight: Number($('#mWeight', root).value) || 2,
        slots: slots.length ? slots : ['lunch', 'dinner'],
        note: $('#mNote', root).value.trim(),
        ingredients,
      });
      closeSheet();
      toast(`"${name}" added`);
    });
  });
}

/* -------------------------------------------------------- settings view -- */

function renderSettings() {
  const s = getSettings();
  $('#peopleValue').textContent = s.household;

  const planned = plannedSlots().length;
  $('#slotToggles').innerHTML = `
    <div class="slotgrid">
      <div class="slotgrid__row slotgrid__row--head">
        <span></span>
        ${DAYS.map((day) => `<span class="slotgrid__day">${DAY_NAMES[day].slice(0, 1)}<small>${DAY_NAMES[day].slice(0, 3)}</small></span>`).join('')}
      </div>
      ${SLOTS.map((slot) => `
        <div class="slotgrid__row">
          <button class="slotgrid__label" type="button" data-slot-all="${slot}"
                  title="Turn ${SLOT_NAMES[slot].toLowerCase()} on or off every day">${SLOT_NAMES[slot]}</button>
          ${DAYS.map((day) => `
            <button class="slotgrid__cell${isSlotOn(day, slot) ? ' is-on' : ''}" type="button"
                    data-cell-day="${day}" data-cell-slot="${slot}"
                    aria-pressed="${isSlotOn(day, slot)}"
                    aria-label="${SLOT_NAMES[slot]} on ${DAY_NAMES[day]}">
              <span aria-hidden="true">${isSlotOn(day, slot) ? '✓' : ''}</span>
            </button>`).join('')}
        </div>`).join('')}
    </div>
    <p class="slotgrid__foot">${planned} ${planned === 1 ? 'meal' : 'meals'} planned each week · tap a row name for the whole week</p>`;

  $('#aiEnabled').checked = !!s.ai.enabled;
  $('#aiFields').hidden = !s.ai.enabled;
  $('#aiKey').value = s.ai.key || '';

  const select = $('#aiModel');
  const known = select.dataset.loaded === '1'
    ? [...select.options].map((o) => ({ id: o.value, name: o.textContent }))
    : FALLBACK_FREE_MODELS;
  const options = known.some((m) => m.id === s.ai.model)
    ? known
    : [{ id: s.ai.model, name: s.ai.model }, ...known];
  select.innerHTML = options.map((m) => `<option value="${esc(m.id)}"${m.id === s.ai.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('');

  try {
    const bytes = new Blob([exportData()]).size;
    $('#storageInfo').textContent = `${(bytes / 1024).toFixed(1)} KB stored locally`;
  } catch (_) { $('#storageInfo').textContent = 'stored locally'; }
}

function setHousehold(delta) {
  update((s) => {
    s.settings.household = Math.min(12, Math.max(1, (Number(s.settings.household) || 2) + delta));
  });
}

/* ---------------------------------------------------------------- views -- */

function showView(view) {
  currentView = view;
  $$('.view').forEach((el) => el.classList.toggle('is-active', el.id === `view-${view}`));
  $$('.tabbar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  $('#weeknav').hidden = !(view === 'week' || view === 'shop');
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  render();
}

function render() {
  if (currentView === 'week') renderWeek();
  if (currentView === 'shop') renderShopping();
  if (currentView === 'meals') renderLibrary();
  if (currentView === 'settings') renderSettings();
}

/* ----------------------------------------------------------------- init -- */

function bindChrome() {
  $('#weeknav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-week]');
    if (!btn) return;
    currentWeek = shiftWeek(currentWeek, Number(btn.dataset.week));
    render();
  });

  $('.tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) showView(btn.dataset.view);
  });

  $('#scrim').addEventListener('click', closeSheet);
  $('#sheetClose').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetIsOpen()) closeSheet(); });

  // Week view
  $('#btnGenerate').addEventListener('click', planWeek);
  $('#btnShopping').addEventListener('click', () => { showView('shop'); toast('Shopping list ready'); });
  $('#btnClear').addEventListener('click', () => {
    if (confirm('Clear this week? Locked meals stay put.')) { clearWeek(currentWeek); toast('Week cleared'); }
  });

  // Shopping view
  $('#btnBuildList').addEventListener('click', () => {
    const { itemCount } = shoppingList(currentWeek);
    if (!itemCount) { toast('Plan some meals first'); showView('week'); return; }
    renderShopping();
    $('#shopBody').classList.add('swap-in');
    setTimeout(() => $('#shopBody').classList.remove('swap-in'), 320);
    toast(`${itemCount} items for ${getSettings().household} ${getSettings().household === 1 ? 'person' : 'people'}`);
  });
  $('#btnCopyList').addEventListener('click', copyShoppingList);
  $('#btnResetTicks').addEventListener('click', () => { resetChecked(currentWeek); toast('All unticked'); });
  $('#shopBody').addEventListener('click', (e) => {
    const item = e.target.closest('[data-item]');
    if (!item) return;
    toggleChecked(currentWeek, item.dataset.item);
    haptic(8);
  });

  // Library
  $('#btnAddMeal').addEventListener('click', openAddMealSheet);
  $('#mealSearch').addEventListener('input', (e) => { librarySearch = e.target.value; renderLibrary(); });
  $('#mealFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    libraryFilter = btn.dataset.filter;
    renderLibrary();
  });
  $('#mealLibrary').addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) { toggleFavourite(fav.dataset.fav); haptic(8); return; }
    const open = e.target.closest('[data-open]');
    if (open) openMealSheet(open.dataset.open);
  });

  // Settings
  $('#peopleUp').addEventListener('click', () => setHousehold(1));
  $('#peopleDown').addEventListener('click', () => setHousehold(-1));
  $('#slotToggles').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-cell-day]');
    if (cell) { toggleDaySlot(cell.dataset.cellDay, cell.dataset.cellSlot); haptic(8); return; }
    const row = e.target.closest('[data-slot-all]');
    if (row) { toggleSlotEveryDay(row.dataset.slotAll); haptic(10); }
  });

  $('#aiEnabled').addEventListener('change', (e) => {
    update((s) => { s.settings.ai.enabled = e.target.checked; });
  });
  $('#aiKey').addEventListener('change', (e) => {
    update((s) => { s.settings.ai.key = e.target.value.trim(); });
    toast('Key saved on this device');
  });
  $('#aiModel').addEventListener('change', (e) => {
    update((s) => { s.settings.ai.model = e.target.value; });
  });

  $('#btnRefreshModels').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.innerHTML;
    btn.innerHTML = '<span class="spin"></span> Loading';
    btn.disabled = true;
    try {
      const models = await fetchFreeModels(getSettings().ai.key);
      if (!models.length) throw new Error('No free models came back.');
      const select = $('#aiModel');
      select.dataset.loaded = '1';
      select.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
      const current = getSettings().ai.model;
      if (models.some((m) => m.id === current)) select.value = current;
      else update((s) => { s.settings.ai.model = models[0].id; });
      toast(`${models.length} free models available`);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  });

  $('#btnTestAI').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.innerHTML;
    btn.innerHTML = '<span class="spin"></span> Testing';
    btn.disabled = true;
    const s = getSettings();
    try {
      const { assignments } = await planWeekWithAI({
        key: s.ai.key,
        model: s.ai.model,
        meals: allMeals().slice(0, 12),
        targets: [{ day: 'Mon', slot: 'dinner' }],
        household: s.household,
      });
      toast(assignments.length ? 'Connected — the model answered correctly' : 'Connected, but the answer was unusable');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  });

  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([exportData()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mealplan-backup-${toISO(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      importData(await file.text());
      toast('Backup restored');
    } catch (err) {
      toast(err.message || 'That file could not be read');
    }
    e.target.value = '';
  });

  $('#btnReset').addEventListener('click', () => {
    if (confirm('Delete every plan, custom meal and setting on this device?')) {
      resetAll();
      currentWeek = weekKey();
      toast('Everything reset');
    }
  });
}

function init() {
  bindChrome();
  bindGestures();
  subscribe(render);
  showView('week');

  // First run: show a planned week rather than an empty grid.
  const somethingPlanned = plannedSlots().some(({ day, slot }) => getEntry(currentWeek, day, slot));
  if (!somethingPlanned && !getState().customMeals.length) {
    applyPlan(currentWeek, generateWeek(currentWeek, { onlyEmpty: true }));
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline mode unavailable', err));
    });
  }
}

init();
