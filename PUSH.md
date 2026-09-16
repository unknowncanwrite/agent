# Pushing to https://github.com/unknowncanwrite/agent

The commit is already made locally. Pick whichever is easiest.

## Option A — push from this folder (fastest)

```bash
cd agent
git push -u origin main
```

Git will ask for your username and password. **The password must be a Personal Access
Token, not your GitHub password.** Create one at:
https://github.com/settings/tokens  → *Generate new token (classic)* → tick **repo** scope.

If the repo already has commits and it rejects the push:
```bash
git pull --rebase origin main
git push -u origin main
```

To avoid retyping the token:
```bash
git config --global credential.helper store   # or 'manager' on Windows
```

## Option B — token in the URL (one-liner)

```bash
git remote set-url origin https://<YOUR_TOKEN>@github.com/unknowncanwrite/agent.git
git push -u origin main
```
Then reset it so the token isn't stored in plain text:
```bash
git remote set-url origin https://github.com/unknowncanwrite/agent.git
```

## Option C — GitHub CLI

```bash
gh auth login
git push -u origin main
```

## Option D — from the bundle

If you'd rather start from a clean clone:
```bash
git clone nexus-agent.bundle agent
cd agent
git remote set-url origin https://github.com/unknowncanwrite/agent.git
git push -u origin main
```

---

**Before you push:** `.env` is gitignored, but that API key was shared in chat —
rotate it and put the new one in your local `.env`.
