# CLAUDE.md

Working notes for Claude. Read once at the start of a session and follow
without being reminded.

## Source of truth

- [`README.md`](./README.md) (root) and per-package READMEs are the
  human-facing docs. **Update them whenever you make a non-trivial
  change** — new script, new env var, new package, new module under
  `src/`, restructured directories, changed dev/prod workflow, etc.
  Trivial changes (typo fixes, internal refactors with no external
  surface) do not need a README update.

## Style

- British English in all prose (code, comments, docs, commit messages).
- Default to writing no code comments. Only add one when the *why* is
  non-obvious.
- JSDoc paragraph rule: no newlines inside a JSDoc comment except to
  separate paragraphs. Applies to both Drizzle and GraphQL schemas.

## Schema

- DB schema (Drizzle, TS): document every column/table with JSDoc unless
  the purpose is obvious from the name. Never reference implementation
  details that callers don't need to know.
- GraphQL schema (grats): document every type/field/argument with JSDoc
  unless obvious. Never reference implementation details or anything the
  client doesn't need to know.
- GraphQL nullability: mutations always return non-null; queries always
  return nullable.
- Mutation noop return type: `type Void { _: Boolean }`.

## Tests

- Use `fastify.inject` to drive GraphQL operations end-to-end.
- Do not import implementation modules from tests. Assert only on
  observable HTTP/GraphQL responses. Tests are behavioural.
- **Never mock our own modules.** Don't `vi.mock('./foo.js')` on any
  in-repo module — that couples the test to the module's public API
  rather than its behaviour. If a test needs to observe a side effect
  (e.g. "ffmpeg was spawned exactly once"), mock at the syscall/Node
  boundary instead (`vi.mock('node:child_process', ...)` with
  passthrough, then assert on call counts). The rule of thumb: mocks
  belong at the edge of the system, never inside it.

## Frontend

- GraphQL documents are colocated with their consumer (no central
  `queries.ts`). Each operation and fragment is bound to a JS const
  suffixed `Document`; the GraphQL operation/fragment name itself does
  **not** carry the suffix (`const PlaybackBarDocument = graphql(\`fragment PlaybackBar on Track { ... }\`)`).
  Each consumer declares a fragment with exactly the fields it needs and
  reads them via `readFragment(FragmentDocument, ref)` — never use
  `@_unmask`. Parent documents compose by spreading the child fragments
  and listing them as dependencies in the `graphql()` second argument.
