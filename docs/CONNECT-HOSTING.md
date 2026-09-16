# Connect hosting so the agent can publish sites

The agent publishes to the **first configured** host. You only need one. Set the variable
wherever the app reads its environment:

* **local machine** — `.env` in the project folder, then restart (`.env` is git-ignored)
* **Render deployment** — service → **Environment** → *Add environment variable* → save
  (Render redeploys automatically)

Check what is connected at any time: `GET /api/publish`, or click the **publish** chip in the
app header.

| Host | Variable | Effort | Can upload arbitrary files? |
|---|---|---|---|
| **Vercel** ← recommended | `VERCEL_TOKEN` | ~2 min, free | **yes** — deploys straight from the API |
| Render | `RENDER_DEPLOY_HOOK_URL` | ~2 min | no — it rebuilds a service that is wired to a repo |
| Render (API) | `RENDER_API_KEY` + `RENDER_SERVICE_ID` | ~3 min | no — same, triggered through the API |
| GitHub Pages | `PUBLISH_GITHUB_REPO=owner/repo` | needs `gh` signed in | pushes the files to a branch, then publishes |

> **Why Vercel is the recommended one:** the agent builds a site *on your machine* and Vercel's
> deploy API accepts those files directly. Render deploy hooks can only re-deploy a service that
> already builds from a Git repo — they cannot receive files. If you prefer Render-only, use the
> GitHub Pages backend to push the built site to a repo, then point a Render **Static Site** at
> that branch and put its deploy hook in `RENDER_DEPLOY_HOOK_URL` (see Option C).

---

## Option A — Vercel (recommended, ~2 minutes)

1. Sign up / log in at <https://vercel.com> (the free *Hobby* plan is enough).
2. Open <https://vercel.com/account/tokens> → **Create Token**
   * Name: `nexus-agent`
   * Scope: your personal account
   * Expiration: *No expiration* (or 1 year — then note the date)
   * **Create** → copy the token (`vercel_…`). It is shown **once**.
3. Add it to the environment:
   * **Render:** Dashboard → your NEXUS service → **Environment** → **Add Environment
     Variable** → Key `VERCEL_TOKEN`, Value `<paste>` → **Save** (it redeploys).
   * **Local:** add `VERCEL_TOKEN=…` to `.env`, restart `npm start`.
4. Optional but nice:
   * `VERCEL_SLUG=my-unique-name` → the site lands on `https://my-unique-name.vercel.app`.
     Without it the project name is derived from the folder the agent built in.
     Vercel project names are global, so a very generic name may already be taken — the run
     reports Vercel's error if that happens; just set `VERCEL_SLUG`.
5. Verify: `GET /api/publish` should now show `"ready":[{"id":"vercel", …}]`, and the header
   chip turns green. Then ask the agent for any website — it publishes automatically and shows
   the URL on a card. You can also say *"publish it"* at any time (tool: `publish_website`).

**What you'll see on the card:** `Published automatically · https://<name>.vercel.app · vercel · N files`.
The first load may take a few seconds while Vercel provisions the deployment.

## Option B — Render only, for the site itself

Render can host the built site, but the files must reach Render through a repo. Two moving
parts, both quick:

1. Publish the built files to a repo/branch with the GitHub backend
   (`PUBLISH_GITHUB_REPO=owner/repo`, branch defaults to `gh-pages`).
   * One-time: `gh auth login` on whatever machine runs the agent (the Render container does
     **not** have `gh` signed in — for a deployment, use Vercel or a repo you push from locally).
2. In Render: **New → Static Site** → pick that repo + branch → Publish directory `/` →
   Create. Copy the site URL.
3. Service → **Settings → Deploy Hook** → copy the URL → add as `RENDER_DEPLOY_HOOK_URL`
   (and `RENDER_SITE_URL=https://your-site.onrender.com` so the agent reports a real link).
4. Now `publish_website` triggers that hook; Render pulls the freshly pushed files and builds.

> The Render *deploy hook of the NEXUS service itself* only redeploys NEXUS — it does not
> publish a built website. Do not use it as the publishing target unless that service is the
> site you want live.

## Option C — GitHub Pages (no Vercel/Render account needed)

1. Create (or reuse) a repo: `PUBLISH_GITHUB_REPO=owner/repo`.
2. Sign the `gh` CLI in on the machine running the agent (`gh auth login`, scope `repo`).
3. Optional: `PUBLISH_GITHUB_BRANCH=gh-pages` (default) and `PUBLISH_GITHUB_CNAME=example.com`.
4. Ask the agent for a site — it uploads the built files to that branch, enables Pages, and
   reports `https://owner.github.io/repo/`. First build takes a minute.

---

## Deploy the new code first (needed for the publish feature)

The live deployment currently serves the older build — `GET /api/publish` returns
`Cannot GET /api/publish`, which means the publish feature is not on that host yet. Pick one:

* **Merge PR #1 into `main`.** If the Render service is connected to this repo (auto-deploy on
  `main`), it redeploys by itself — easiest, permanent.
* **Or temporarily point Render at the branch:** service → **Settings → Build & Deploy →
  Branch** → `arena/01a0a92f-agent` → **Save** (Render deploys it now; switch back whenever).

Then confirm the new build is live:

```bash
curl -s https://<your-app>.onrender.com/api/publish | head -c 400
# → {"backends":[{"id":"vercel","label":"Vercel","ready":false,…}],…}
```

## Verify publishing works, once connected

1. `GET /api/publish` lists your host with `"ready": true`.
2. Ask the agent: *"build me a one-page site for a coffee shop and publish it"*.
3. Watch the run: a `publishing` log line, then a green **Published** card with the URL.
4. Open the URL. If the page is blank, check the run log for `skipped:` lines (files that were
   too big or excluded) — files over 5 MB are not uploaded.
5. Manual retry: *"publish the last site again"* (the `publish_website` tool).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `no publish backend configured` | No variable set — see the table above. |
| Vercel: `403 / invalid token` | Token was copied incompletely or deleted; create a new one. |
| Vercel: `409 project name is already in use` | Set `VERCEL_SLUG` to something unique. |
| `no website found in …` | The folder has no `index.html` and no `package.json` build script — point `publish_website` at the folder that holds the built site. |
| `build failed (exit 1)` | The project's `npm run build` failed; the log in the card shows the last lines. The site is **not** published from stale output. |
| Render hook `404` | The hook URL is wrong or the service was deleted — copy it again from Settings. |
| GitHub backend: `gh: command not found` | `gh` is not installed/authorised on that machine; use Vercel there instead. |
| Site publishes but shows the old version | Set `NEXUS_FORCE_BUILD=true` to rebuild before every deploy, or clear the host's build cache. |
| Publishing takes forever | `NEXUS_PUBLISH_TIMEOUT_MS` (default 150000) caps it; the run reports a timeout instead of hanging. |
| Want it off? | `NEXUS_AUTO_PUBLISH=false` — the agent will only publish when you explicitly ask. |

## Where the tokens live (keep them out of Git)

Tokens belong in the environment only: Render → Environment, or a local `.env`. The repo's
`.gitignore` excludes `.env`, `providers.json` and workspace state, and no token is ever
echoed into the UI or the logs — the publish log lines only mention the file names and the
deployment id.
