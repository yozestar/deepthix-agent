---
name: commit-crafter
description: Write commit messages that explain WHY, not just WHAT. Auto-applied when running `git commit`.
---

# Commit Crafter

Write commit messages that focus on the **why** of a change, not the what — readers can already see what changed in the diff.

## Process

1. Run `git diff --staged` to see what's staged.
2. Read the diff carefully. Look for:
   - Bug fixes → what was broken, what's the symptom
   - Features → what user need or workflow this enables
   - Refactors → what tension this resolves
3. Pick a single short title (max 70 chars). Format: `type(scope): summary`. Type one of:
   - `feat` — new functionality
   - `fix` — bug fix
   - `refactor` — internal restructuring, no behavior change
   - `docs` — docs only
   - `test` — test changes only
   - `chore` — tooling, deps, config
4. Body (optional, only if needed): explain the WHY in 1-3 sentences. No bullet lists of what changed — the diff has that.

## Examples

Good:

```
fix(auth): clear session on browser back from oauth redirect

Users who hit Back after the oauth callback would land on a stale
session that thought it was authenticated but had no valid token,
causing a 500 on the first API call. Now the session is cleared on
unmount of the redirect page.
```

Bad:

```
Updated AuthService.ts and SessionManager.ts to clear the session
in the unmount hook when the user comes from the oauth callback.
```

(The bad version repeats the diff. The good version explains the bug.)

## Anti-patterns to avoid

- "Fix bug" — too vague
- "Update X.ts" — file names belong in the diff, not the title
- Long bullet lists — if you need bullets, the commit is too big; split it
- Mentioning the issue tracker number alone — link IS context, but not the only context
