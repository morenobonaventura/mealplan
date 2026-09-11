/**
 * Optional AI week planning through OpenRouter's free model tier.
 *
 * The browser talks to OpenRouter directly — there is no server in this app —
 * so the user's own API key is stored in their browser and sent from their
 * browser. Everything here degrades gracefully: if the key is missing, the
 * model is busy, or the answer is nonsense, the caller falls back to the
 * built-in offline planner.
 */
import { DAY_NAMES, SLOT_NAMES } from './store.js';

const BASE = 'https://openrouter.ai/api/v1';

/** Reasonable free-tier defaults; the Settings screen can refresh this live. */
export const FALLBACK_FREE_MODELS = [
  { id: 'deepseek/deepseek-chat-v3-0324:free', name: 'DeepSeek V3 (free)' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)' },
  { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B (free)' },
  { id: 'qwen/qwen3-235b-a22b:free', name: 'Qwen3 235B (free)' },
  { id: 'mistralai/mistral-small-3.2-24b-instruct:free', name: 'Mistral Small 3.2 (free)' },
];

function friendlyError(status, body) {
  const detail = (body && body.error && body.error.message) || '';
  if (status === 401) return 'OpenRouter rejected the key. Check it in Settings.';
  if (status === 402) return 'That model is not free for this account. Pick another free model.';
  if (status === 429) return 'Rate limited by OpenRouter — wait a moment or try another free model.';
  if (status === 404) return 'That model id does not exist. Refresh the list in Settings.';
  return detail || `OpenRouter returned ${status}.`;
}

/** Public endpoint — works with or without a key. */
export async function fetchFreeModels(key) {
  const res = await fetch(`${BASE}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) throw new Error(friendlyError(res.status, await res.json().catch(() => null)));
  const { data } = await res.json();
  return (data || [])
    .filter((m) => {
      const p = m.pricing || {};
      return Number(p.prompt) === 0 && Number(p.completion) === 0;
    })
    .map((m) => ({ id: m.id, name: m.name || m.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildPrompt({ meals, targets, locked, household, favourites }) {
  const menu = meals
    .map((m) => `- ${m.id} | ${m.name} | ${m.cuisine || 'mixed'} | ${m.protein} | ${m.time || 30} min | ${(m.weight || 2) === 3 ? 'hearty' : (m.weight || 2) === 1 ? 'light' : 'medium'} | fits: ${(m.slots || []).join(',')}`)
    .join('\n');

  const slotList = targets
    .map((t) => `- ${t.day} ${t.slot}  (${DAY_NAMES[t.day]} ${SLOT_NAMES[t.slot].toLowerCase()})`)
    .join('\n');

  const lockedList = locked.length
    ? locked.map((l) => `- ${l.day} ${l.slot}: ${l.name}`).join('\n')
    : '- none';

  return `You are planning a week of home cooking for a household of ${household}.

AVAILABLE MEALS (use these exact ids, nothing else):
${menu}

ALREADY FIXED (do not repeat these dishes elsewhere):
${lockedList}

FAVOURITES (lean towards these): ${favourites.length ? favourites.join(', ') : 'none set'}

FILL THESE SLOTS:
${slotList}

RULES
1. Use each meal at most once in the week.
2. Do not put the same main protein on two days in a row.
3. Keep weekday dinners under 45 minutes; save slow or hearty dishes for Fri/Sat/Sun.
4. Lunches should be lighter and quicker than dinners.
5. Respect the "fits" field — only use a meal in a slot it fits.
6. Vary cuisines across the week.

Reply with JSON only, no prose, no code fences:
{"plan":[{"day":"Mon","slot":"dinner","meal_id":"lasagne"}],"note":"one short sentence about the week"}`;
}

function extractJSON(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_err) {
      return null;
    }
  }
}

/**
 * Ask the model to fill `targets`.
 * Resolves to { assignments, note, skipped } — assignments only ever contains
 * slots and meal ids that were actually offered to the model.
 */
export async function planWeekWithAI({
  key, model, meals, targets, locked = [], household = 2, favourites = [], signal,
}) {
  if (!key) throw new Error('Add an OpenRouter API key in Settings first.');
  if (!targets.length) return { assignments: [], note: 'Nothing to fill — every slot is locked.', skipped: 0 };

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': location.origin,
      'X-Title': 'MealPlan',
    },
    body: JSON.stringify({
      model,
      temperature: 0.85,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: 'You are a practical home-cooking meal planner. You reply with JSON only.' },
        { role: 'user', content: buildPrompt({ meals, targets, locked, household, favourites }) },
      ],
    }),
  });

  if (!res.ok) throw new Error(friendlyError(res.status, await res.json().catch(() => null)));

  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  const parsed = extractJSON(content);
  if (!parsed || !Array.isArray(parsed.plan)) {
    throw new Error('The model did not return a usable plan. Try again or pick another free model.');
  }

  const validIds = new Set(meals.map((m) => m.id));
  const wanted = new Set(targets.map((t) => `${t.day}|${t.slot}`));
  const usedMeals = new Set(locked.map((l) => l.id).filter(Boolean));
  const seen = new Set();
  const assignments = [];

  for (const row of parsed.plan) {
    const day = String(row.day || '').slice(0, 3);
    const slot = String(row.slot || '').toLowerCase();
    const mealId = String(row.meal_id || row.mealId || '');
    const key2 = `${day}|${slot}`;
    if (!wanted.has(key2) || seen.has(key2)) continue;   // not a slot we asked about
    if (!validIds.has(mealId)) continue;                 // invented meal id
    if (usedMeals.has(mealId)) continue;                 // model repeated a dish
    seen.add(key2);
    usedMeals.add(mealId);
    assignments.push({ day, slot, mealId });
  }

  return {
    assignments,
    note: typeof parsed.note === 'string' ? parsed.note : '',
    skipped: targets.length - assignments.length,
  };
}
