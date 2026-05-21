---
name: commit
description: Use whenever creating a git commit in this repo. Enforces Conventional Commits with short subjects and an optional body for the why.
---

# commit

Format: `<type>(<scope>)?: <imperative subject>` — lowercase, no full
stop, ≤ 50 chars, British English. Breaking change: `type!:`.

Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`,
`chore`, `style`, `revert`. Scopes are monorepo packages (`backend`,
`ui`) or areas (`db`, `infra`, `plan`).

Body (optional, blank line after subject, ~72 char wrap): explain *why*
when non-obvious. Don't narrate the diff. Skip for trivial commits.

```
feat(backend): add tracks schema and migrator wiring
```

```
fix(playback): reject signed URLs with mismatched options

HMAC was computed over `id` only; clients could swap `options` without
invalidating the signature. Now signs `{options}/{id}`.
```

Use a HEREDOC for multiline `-m`. No AI attribution. No `--amend` /
`--no-verify` unless the user asks.
