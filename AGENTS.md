# Development principles

## Workflow: Design before implementation

When user asks for a change or new feature, do NOT jump straight to proposing implementation details or code. Instead:

1. **Ask clarifying questions** - understand the full scope and intent
2. **Discuss design options** - present tradeoffs, get user's preference
3. **Firm up requirements** - agree on behavior, edge cases, UX details
4. **Only then implement** - after the user explicitly says to proceed

Do not conflate "here's how I'd do it" with "let me do it now". The user wants to think through the design collaboratively before any code is written.

## Design/Development Philosophy

- **Do the right thing** - Never avoid a refactor because "it's minimal lines" or "it doesn't fix a bug". Correctness, clarity and proper design matter regardless of scope. This project is both a product and a learning tool
- Read before writing
- Verify completeness
- Ask when uncertain
- Be systematic, not selective

## Communication style

- **Keep replies short** - Long answers are hard to read. Prefer the minimum needed to convey the point. If the reply gets long anyway, summarize your reply at the end with a TLDR section so user doesn't have to go through the whole thing.
- **Pause for input** - When you need a decision or clarification from the user, stop there and ask. Do not assume an answer and proceed

## Code style rules

- **No non-ASCII characters in code** - Use only ASCII in source files (comments, strings, identifiers). Use plain dashes (`-`) instead of em-dashes, straight quotes instead of curly quotes, etc.
- **Preserve existing comments** - When rewriting on refactoring code, do not remove comments that are still relevant (TODOs, explanation of quirks, workaround notes, commented-out code with rationale). Only remove a comment if the code it describes no longer exists or the concern is fully resolved

## Commit message format

- The user always commits manually. Do NOT run `git commit` (or `git add`/`git push`) unless explicitly asked. Prepare and describe the changes; leave the actual commit to the user.
- When asked for a commit message:
  * Start with the scope prefix indicating what changed: `web:`, `go-server:` or combined (e.g. `g-server+web:`)
  * Use `go-server:` for any change under `go-server/` (the Go backend, which is what is current). The bare `server:` prefix referred to the retired Note.js `server/` and shot no longer be used
  * After the prefix, capitalize the first word and state which component/module the change is in (e.g. `In pl-album-name,`)
  * Follow this with a short summary (imperative mood)
  * Use the body for details if needed
  * Keep it short. Prefer single summary line; only add a brief body when it genuinely aids understanding. Avoid long, exhaustive bullet lists of every touched file -- summarize the change, not the diff
  * For any agentic changes, use `agents:` as the prefix

## Database migrations

- DDL changes (new/dropped/renamed tables or columns) go in a NEW versioned file under `go-server/internal/database/migrations` (e.g. `013-new-feature.sql`), embedded via `//go:embed`.
- Never edit a committed migration file -- it's frozen. Keep iterating on the current new file until done
- Data migrations (INSERT/UPDATE backfills) are one-time manual scripts prefixed with the version number in `0xx` format (e.g. `012-backfill-capture-time`).
- Fresh installs apply all DDL migrations in order
- To add one: create `NNN-<name>.sql`, then add `{version: N, filename: "migrations/NNN-<name>.sql"}` to the `migrations` slice in `runMigrations()` (`internal/database/database.go`). Each run in a transaction when `PRAGMA user_version < N`; `user_version` is set to `N` after commit (SQLite cannot set it inside a transaction)
- FTS5 tables (`metadata_fts_porter`, `metadata_fts_unicode`) don't support ALTER TABLE -- adding columns means drop+recreate. No rebuild helper exists yet; create one when needed.

## Service Worker version bump (web changes)

Any change under `web/` requires bumping the `VERSION` constant in `web/sw.mjs` to trigger the PWA "New version available" banner. This applies on the dev box too -- the service worker uses the version to detect changes, so bumping is the way to pick up updates without manually refreshing the browser.

- **Patch (1.0.X)** - bug fixes, small style/copy tweaks, no-behavior-change refactors
- **Minor (1.X.0)** - new features/components, additive UI, non-breaking behavior changes
- **Major (X.0.0)** - breaking changes, removed features, large redesigns

Rules: 
- bump in the same commit as the web change
- bump every time a web file changes (each distinct change gets its own bump)
- no skipping versions
- ask if unsure patch vs minor
- server-only changes need no bump

