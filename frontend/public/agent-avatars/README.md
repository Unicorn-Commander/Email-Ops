# Agent avatars

Per-agent avatar art, publicly served at `/agent-avatars/<file>` (these files are
also embedded by ABSOLUTE URL in generated outbound agent signatures —
`EMAIL_OPS_PUBLIC_BASE_URL` + path).

**Everything in here today is an explicit PLACEHOLDER** until real art is
supplied: a circular badge, a deterministic per-agent gradient, a geometric
unicorn head + horn, and the agent's initial worked in subtly.

## Replacing a placeholder with real art

Drop the real file in **by key name** — `<agent key>.svg` (e.g. `perry.svg`) —
and every surface (agents page, review-panel chip, generated signatures) picks
it up with no code change. Square art, 128×128 (or any square raster if you
swap the extension — then set the agent's `avatar_url` instead, see below).

Alternatively set the agent's `avatar_url` via the agents API
(`PATCH /workspaces/:ws/agents/:id` with `{"avatar_url": "..."}`) — an explicit
`avatar_url` always wins over the files here.

## Resolution rule (one rule, both sides)

1. `agents.avatar_url` when set;
2. else `/agent-avatars/<key>.svg` — the frontend just tries it and falls back
   `onError`; the backend signature uses the known-keys list in
   `backend/src/agents/agent-avatar.ts` (**add the key there when you add a
   per-key file here** — the backend can't stat this directory at runtime);
3. else `/agent-avatars/default.svg`.

## Generating a new placeholder

Keep future placeholders distinct by deriving the gradient hue from the key
(don't pick hues by hand):

```js
// djb2 over the agent key, golden-ish scramble into hue space
function hueOf(key) {
  let h = 5381;
  for (const c of key) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return (h * 113) % 360;
}
// gradient: hsl(hue 68% 55%) -> hsl(hue+42 72% 38%)
```

Shipped placeholders: `perry` (hue 111), `prudence` (hue 35), `corporal-qwen`
(hue 191), plus the neutral slate `default.svg`. Copy any of them, swap the two
gradient stops + the initial letter + the `id`/`aria-label`, keep the 128×128
viewBox and the shared unicorn paths.
