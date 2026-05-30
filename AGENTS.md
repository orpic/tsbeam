# AGENTS.md

Instructions for AI coding agents (Claude Code, Cursor, Aider, etc.) working in
this repository. Read this in full before making changes.

## What TSBeam is

A TypeScript-to-BEAM compiler. Pipeline: `.ts` source → TypeScript Compiler API
→ AST → Core Erlang emitter → `erlc +from_core` → `.beam` → BEAM VM.

There is **no Node.js or Elixir at runtime.** The output is pure BEAM bytecode.
Node is used only during development (to run our own TypeScript compiler
source), and `erlc` is invoked as a build tool — it's never a language we
write in.

## Where to look first

1. [README.md](README.md) — the public-facing overview and quick start.
2. This file — agent-specific rules.
3. [CONTRIBUTING.md](CONTRIBUTING.md) — the dev loop, prerequisites, how to
   add tests.
4. The most recent file in `plans/<area>/discussion_*.md` for the reasoning
   behind current architecture decisions. Read the paired `plan_*.md` for
   *what* we're building; read `discussion_*.md` for *why* we chose it.

## The dev loop

```bash
npm test                              # run the whole test suite
npm test -- arithmetic                # run cases matching 'arithmetic'
npm run update-baseline               # regenerate baselines (snapshot update)
npm run tsbeam -- run path/to/foo.ts  # compile + run on BEAM
npm run tsbeam -- build path/to/foo.ts
```

`npm test` is the source of truth. If it's green, the compiler works for the
constructs covered by current cases. If it's red, fix that before doing
anything else.

When iterating, `npx tsc --watch` in one terminal while running the runner in
another is the right setup.

## Hard rules

1. **Never push without explicit user approval.** Commit freely once we've
   agreed the work is right. Don't push.
2. **Never force-push, rebase published commits, or `reset --hard`** without
   explicit approval.
3. **Never modify `LICENSE`.** Apache 2.0 is settled.
4. **Never add a runtime Node.js or Elixir dependency.** TSBeam's value
   proposition is that the output is pure BEAM. Compile-time tooling can use
   Node freely.
5. **Never re-introduce `scratch/`, `examples/`, or per-source-file `build/`
   directories.** These were deliberately removed; see "Layout" below.
6. **Never add an `examples/` directory inside this repo.** Demo programs
   live in separate repos (Gleam's pattern). The compiler repo is for the
   compiler.

## Layout

```text
src/
  compiler/
    parser.ts     # debug: TS Compiler API → AST dump
    emitter.ts    # AST → Core Erlang text
    build.ts      # build/run primitives (used by CLI + tests)
  cli/
    index.ts      # tsbeam CLI entrypoint

tests/
  cases/          # .ts inputs — ONE FEATURE PER FILE
  baselines/      # expected stdout, sibling to each case
  run.ts          # test harness (compile + run + diff)

dist/             # gitignored — tsc output for OUR compiler source
build/            # gitignored — user-facing tsbeam output (per CWD)
tests/.build/     # gitignored — isolated build dir per test case
local_sandbox/    # gitignored — your private scratchpad (see below)

plans/            # committed — paired plan + discussion per work area
```

**Two different "build" concepts** — don't confuse them:

- `dist/` = tsc's output, our TypeScript compiler source transpiled to JS.
- `build/` = what tsbeam emits for users compiling their `.ts` files.

### `local_sandbox/` — your private scratchpad

`local_sandbox/` is a gitignored directory for throwaway work inside the
project. Use it when:

- You want to hand-write a Core Erlang file and feed it through `erlc` to
  sanity-check the shape *before* changing the emitter. This is the
  pattern we used for CPS and arrays: target shape first, emitter second.
- You want to run a small TS snippet through tsbeam without polluting
  `tests/cases/`.
- You're exploring something that isn't ready to become a real test case.

Nothing in `local_sandbox/` is ever committed. Safe to delete at any time.
Don't reference files in `local_sandbox/` from any committed code or docs
— they may not exist in a fresh clone.

## Test fixtures — three kinds

The harness recognises three fixture kinds, each in its own directory.

**Positive** (most common): `tests/cases/<name>.ts` + `tests/baselines/<name>.out`.
The program compiles, runs on BEAM, produces the exact stdout in the
baseline. Stderr must be empty.

**Negative**: `tests/rejected/<name>.ts` + `tests/rejected/<name>.error`.
The program must fail to compile with a `CompileError` containing the
substring in the `.error` file. For rejection paths like `arr.push(x)`.

**Meta**: `tests/meta/<name>.ts` + `tests/meta/<name>.out`. Harness
self-check. Baseline is deliberately wrong; fixture passes when output
does NOT match. Used to verify the mismatch-detection actually works.
Don't add new meta fixtures casually — one is enough.

The harness is an orchestrator + per-fixture worker. Each fixture runs
in a separate Node process for state isolation (default, not opt-in).
`npm test` runs everything; `npm test -- <filter>` runs a subset;
`npm run update-baseline` regenerates positive baselines only — never
touches `.error` or meta files.

**Name fixtures after the feature being tested, not the program.**

- ✓ `arithmetic.ts`, `let_binding.ts`, `if_else.ts`, `combo_recursion.ts`,
  `push_rejected.ts`
- ✗ `hello.ts`, `test1.ts`, `example.ts`, `myprogram.ts`

One feature per fixture. Don't bundle multiple features into one case —
when a test fails, the case name should tell you which feature regressed.

When a `npm test` failure reflects an intentional behavior change:

- Positive: run `npm run update-baseline` (regenerates the `.out` from
  actual output). Inspect the diff before committing.
- Negative: edit `tests/rejected/<name>.error` by hand. Never automated.

## Compiler architecture conventions

The compiler is currently a two-stage pipeline:

```text
TS source ─► parse (TS Compiler API) ─► emit (Core Erlang) ─► erlc ─► .beam
```

A third stage — **lowering** — is being added to handle constructs like
early `return` that don't have a direct Core Erlang counterpart. When you see
a lowering pass in `src/compiler/lower/`, the pipeline becomes:

```text
parse ─► lower ─► emit
```

Each construct that needs lowering gets its own file in `src/compiler/lower/`
(e.g. `lower-if-early-return.ts`). Don't write monolithic lowering passes.

**The pass is always complete for the language TSBeam currently accepts.**
We don't write lowering code for constructs the parser hasn't been taught
to accept yet — that would be orphaned code making design decisions without
co-evolved parser/emitter context.

When extending the language with a new construct (e.g. `while`):

1. Add parser handling (often free — TS Compiler API already parses it).
2. Decide if the construct needs lowering. If yes, add `lower-<construct>.ts`.
3. Add emitter handling.
4. Add a test case + baseline.

Parser, lowering (if needed), and emitter additions go in the same PR. Never
ship one without the others.

## Style: code

- TypeScript, strict mode. Match existing tsconfig — no relaxing.
- **Default to no comments.** Add a comment only when the WHY is non-obvious
  (a hidden constraint, a subtle invariant, a workaround). Don't explain WHAT
  the code does — names should already do that.
- No multi-line docstrings or comment blocks. One short line max.
- No "added for X" or "used by Y" comments. Those belong in the commit
  message and PR description.
- No emojis in code unless the user explicitly asks for them.
- Don't add features, refactors, or abstractions beyond what the current task
  requires. A bug fix doesn't need cleanup; a one-shot doesn't need a helper.
- Don't add error handling, fallbacks, or validation for impossible cases.
  Trust internal code. Only validate at system boundaries.

## Style: commits

- Subject: imperative mood, ≤72 chars. "Add early-return lowering" not
  "Added" or "Adding."
- Body: explain WHY when it's non-obvious. Match the style of existing
  commits in this repo.
- One commit per logical change. A new feature with its test case + baseline
  is one commit, not three.

## Decisions live outside the repo

`plans/` is gitignored — it contains planning and discussion files that capture
the reasoning behind architecture choices, but isn't published. If you're
working in a fresh clone, you won't see those files.

**Current binding decisions** (load-bearing, applies regardless of whether you
have `plans/` locally):

- Compiler pipeline is parse → (lower) → emit. Lowering is added per
  construct, only after the parser + emitter accept it.
- Core Erlang is the IR target. Don't propose emitting raw BEAM bytecode or
  Elixir.
- Tests use the baseline-snapshot pattern (`tests/baselines/<case>.out`).
  Don't add a different test framework alongside.
- Apache 2.0 is the license. Don't propose changes.
- No `examples/` directory in this repo.
- No runtime Node.js or Elixir dependency.

If you're about to make an architecture-level change (new pipeline stage,
new IR, new test framework, new top-level directory), **stop and ask** —
those decisions usually have context in `plans/` that you may not have.

## Things to ask before doing

- Adding any top-level directory.
- Adding a new dependency (production or dev).
- Renaming or moving anything in `src/`.
- Changing the public CLI surface (`tsbeam build`, `tsbeam run`).
- Changing test case names or baselines without re-running the suite.
- Anything touching `package.json`'s `bin` or `scripts`.

## Things you can do freely

- Add new test cases for features that already work (or that you're adding).
- Refactor *within* a file when the change is local and behavior-preserving.
- Add type annotations to make existing code stricter.
- Improve error messages.
- Fix typos in docs or comments.
- Update `tests/baselines/*.out` via `npm run update-baseline` after a deliberate
  change — but commit the new baseline in the same change as the code.

## When in doubt

Ask the human. The cost of pausing is low; the cost of an unwanted
architectural change is high.
