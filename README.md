# MealPlan

A weekly meal planner that is just a web page. No account, no server, no build
step — open `index.html` and it works. Your plan, your meals and your settings
live in your browser's local storage and never leave the device.

<sub>Plan lunches and dinners for the week · swipe a meal sideways to swap it ·
press and hold to drag it to another day · generate a shopping list scaled to
however many people are eating · add your own meals · install it on your iPhone
home screen · optionally let a free LLM plan the week for you.</sub>

## Using it

| | |
|---|---|
| **Plan my week** | Fills every empty, unlocked slot. Balances proteins and cuisines, keeps weekday dinners quick, saves the slow cooking for the weekend. |
| **Swipe a meal** | Drag a meal card left or right and let go — it is replaced with another meal that fits that slot. |
| **Press and hold** | Lifts the card so you can drop it on another day and swap the two meals. |
| **Tap a meal** | Opens its card: ingredients scaled to your household, lock, favourite, replace or clear. |
| **Lock 🔒** | A locked meal stays put when you re-plan the week. |
| **Shopping list** | Rolls every planned meal into one list, grouped by aisle, scaled to the number of people in Settings. Tick items off as you shop; copy or share the whole list as text. |
| **Meals per day** | A compact week grid in Settings: switch lunch and dinner on or off for each day individually, or tap a row name to set the whole week. Days with nothing planned drop out of the week, the planner and the shopping list. |
| **Meals** | 31 built-in dishes plus anything you add. Favourite the ones you like (the planner leans towards them), hide the ones you don't. |

Weeks are stored separately, so you can plan ahead with the ‹ › arrows and come
back to an earlier week with everything still there.

## Running it

It is a static site — any static host or local server will do:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

To publish on GitHub Pages: repository **Settings → Pages → Source: Deploy from
a branch**, pick the branch and the `/ (root)` folder. A service worker and
home-screen install both need HTTPS (or `localhost`), which Pages gives you.

## Installing on an iPhone

Open the page in **Safari** → tap **Share** ↑ → **Add to Home Screen**.

It then launches full screen with its own icon, works with no connection at all,
and keeps your plan on the phone. The same works on Android via Chrome's
"Install app".

## Optional: let a free LLM plan the week

**Settings → AI planning** can hand the week over to a free model on
[OpenRouter](https://openrouter.ai) instead of the built-in planner.

1. Create a free OpenRouter account and an API key.
2. Paste the key into Settings and press **Refresh free models** — it lists
   every model OpenRouter currently prices at $0 (DeepSeek, Llama, Gemma, Qwen,
   Mistral and friends), so the list stays right even as models come and go.
3. Press **Test connection**, then plan a week as usual.

The model is given your meal catalogue, the slots to fill, your favourites and
your locked meals, and must answer with meal ids from that catalogue — it cannot
invent dishes. Anything it gets wrong (an unknown id, a repeated dish, a missing
slot, a rate limit, a bad key) is dropped and quietly filled in by the offline
planner, so the button always produces a full week.

> **About the key:** there is no backend here, so the key is stored in this
> browser and sent straight from your device to openrouter.ai. Use a free-tier
> key you are happy to keep on your phone. Clearing the field, or
> **Reset everything**, removes it.

## Your data

Everything lives under one `mealplan.v1` key in `localStorage`. **Settings → Your
data** can export it as a JSON file, import it back on another device, or wipe
it. Nothing is ever sent anywhere except the optional OpenRouter request above.

## How it is put together

No framework, no bundler, no dependencies — ES modules straight from the page.

```
index.html               markup shell for all four screens
manifest.webmanifest     PWA manifest (name, icons, standalone display)
sw.js                    service worker: caches the shell for offline use
icons/                   generated app icons, including the iOS touch icon
assets/css/style.css     the whole design, light and dark
assets/js/
  meals.js               the built-in meal catalogue
  store.js               state + localStorage + week maths (the only writer)
  planner.js             offline meal picking and shopping-list aggregation
  ai.js                  OpenRouter free-model planning (optional)
  app.js                 rendering, sheets, and the swipe/drag gestures
```

Ingredients are tuples of `[name, qty, unit, scale, aisle]`, where `scale` is
`person` (multiplied by household size) or `dish` (fixed) — which is all the
shopping list needs to add up correctly for two people or for six.
