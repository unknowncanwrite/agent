# NEXUS architecture

## Stack choice

| Layer | Tech | Why |
|---|---|---|
| Frontend | Vanilla JS + CSS, single view | Zero build step, instant load, no framework overhead |
| Backend | Node + Express (ESM) | Streams SSE well; already battle-tested here |
| OS control | **Python sidecar** (`os_control.py`) | pyautogui is the best cross-platform cursor/keyboard lib |
| Browser vision | Playwright Chromium | Auto-installed on demand |
| Desktop shell | Optional Electron wrapper | The web UI works standalone; Electron is just packaging |

**Why not a full Electron/Tauri rewrite?** The Node core is verified working (self-modification,
parallel tools, failover). Rewriting would discard that. The Python sidecar adds the one thing
Node genuinely can't do well — physical cursor control — without touching what already works.

## Multi-agent flow

```
user message
     │
     ▼
┌──────────────┐  0ms heuristic, else a small fast model
│   ROUTER     │  router.js
└──────┬───────┘
       │  chat ──────────► fast model, streamed straight back
       │
       └─ agent ────────► full loop (agent.js)
                            ├─ plan model      (reasoning tier)
                            ├─ code model      (coder tier)
                            ├─ vision model    (screenshots)
                            └─ think_parallel / delegate_parallel
                               → up to 8 models concurrently
```

**Speed measures**
- Heuristic routing returns in **0ms** for obvious cases; only ambiguous input costs a model call
- Read-only tools run **concurrently** (measured 3.9x on an 8-task batch)
- 20s hard request timeout + 12s first-token stall guard, so a dead model never hangs the UI
- TTL caches on file reads (15s), dir trees (8s), web search (5min)
- Context auto-compaction (227k → 8k tokens measured)

## Files

| File | Role |
|---|---|
| `server.js` | HTTP + SSE endpoints, log bus, health |
| `router.js` | Fast chat-vs-agent classification |
| `models.js` | Model registry, free-first ranking, failover, stall guards |
| `agent.js` | Tool definitions + autonomous loop |
| `workers.js` | Worker pool, tool scheduling, context compaction |
| `jarvis.js` | OS control via native shells (apps, clipboard, power, speech) |
| `oscontrol.js` | Bridge to the Python sidecar |
| `os_control.py` | pyautogui: cursor, keyboard, screen capture, windows |
| `selfedit.js` | Self-modification with git snapshots + auto-revert |
| `publish.js` | Auto-publish a built website (Vercel / Render / GitHub Pages) |
| `browser.js` | Playwright vision tools |
| `start.js` | Supervisor: preflight checks, crash limits, restart |

## Enabling cursor control

```bash
pip install pyautogui pillow
# optional, for image-based find/click:
pip install opencv-python
```
Or click **Settings → 🖱 Enable cursor control**.

Golden rule the agent follows: `cursor_screenshot` → locate target → convert image coords to
real coords → click → screenshot again to verify.
