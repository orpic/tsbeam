# AGENTS.md

Operating instructions for any AI coding agent (Claude Code, Cursor, Aider,
Copilot, etc.) entering this repository. Read this file in full before
making changes. It's the canonical source of truth for *how to work here*.

Cross-references:

- [README.md](README.md) — what TSBeam is + currently supported language
  features (read second; it tells you what *runs* today)
- [CONTRIBUTING.md](CONTRIBUTING.md) — local dev setup, prerequisites
- `plans/<area>/discussion_*.md` paired with `plan_*.md` — *why* we made
  each architecture decision and what we explicitly rejected (read these
  before designing in the same area)

---

## What TSBeam is

A TypeScript-to-BEAM compiler. Pipeline:

```text
.ts source ─► TypeScript Compiler API ─► AST
           ─► lowering passes (src/compiler/lower/)
           ─► Core Erlang emitter (src/compiler/emitter.ts)
           ─► erlc +from_core
           ─► .beam bytecode
           ─► BEAM VM
```

The output is **pure BEAM bytecode**. There is no Node.js at runtime and
no Elixir anywhere — `erlc` is invoked as a build tool, not a language we
write.

Node is used at compile time only (to run our own TypeScript compiler
source, which is itself written in TypeScript and transpiled to JS via
`tsc`). The runtime artifact is `.beam` files that run on the BEAM VM.

---

## Figuring out the current state (read this first)

Don't assume any specific feature is implemented. Before designing work,
confirm what's actually there:

1. **Read `plans/`** — every non-trivial work area has a paired
   `plan_<timestamp>.md` and `discussion_<timestamp>.md` capturing what
   we built and why. The most recent timestamps tell you what's most
   recently finished. Plans contain an "Implementation notes" section
   with surprises discovered during the work.
2. **Read `git log --oneline -30`** — commits describe what landed and
   how, in commit-message bodies. Look for "Phase N step M" markers.
3. **Read [README.md](README.md)** — the "Supported today" section lists
   what compiles and runs end-to-end.
4. **Run `npm test`** — if it's green, the compiler is in a working state.
   The number of passing fixtures is a rough measure of breadth.
5. **Read `src/compiler/emitter.ts`** — for any specific TS construct,
   grep for its `ts.is*` predicate in the emitter. If it's there, it
   compiles. If it's not, it's rejected with "unsupported expression"
   (or similar).

If you can't tell from the above whether something works, **write a tiny
fixture under `local_sandbox/` and run it through `npm run tsbeam -- run
local_sandbox/foo.ts`**. That's the authoritative answer.

---

## The dev loop

```bash
npm test                              # run the whole test suite
npm test -- arithmetic                # filter: run cases matching 'arithmetic'
npm run update-baseline               # regenerate POSITIVE baselines from current output
npm run tsbeam -- run path/to/foo.ts  # compile path/to/foo.ts and run on BEAM
npm run tsbeam -- build path/to/foo.ts  # produce .beam in ./build/
```

`npm test` is the source of truth for "is the compiler working?". Each
fixture runs in an isolated Node child process for state isolation —
this catches cross-test state leaks that single-process suites miss.

When iterating, leave `npx tsc --watch` in one terminal and run the
runner / tsbeam CLI in another.

### Run-from-project-root invariant

The harness, the CLI, and the build artifacts all assume the current
working directory is the project root. **If you `cd` into a subdirectory
(e.g. `local_sandbox/` for a sanity check), `cd` back before running
`npm test` or the CLI.** Several past sessions have wasted time chasing
"cannot find module" errors caused by drifted cwd.

---

## The design principle (binding)

TSBeam's user-facing contract:

> A TypeScript programmer writing idiomatic TS should never have a
> **worse** runtime experience on TSBeam than on Node. Surprises in the
> *good* direction (faster, more parallel, more robust) are welcome and
> advertised. Surprises in the *bad* direction (slower than equivalent
> TS) are avoided where BEAM allows it, and documented honestly where it
> doesn't.

Three concrete corollaries:

**Match TS complexity where BEAM can.** Phase 2 decisions all follow
this:

| TS construct                  | BEAM target          | Why                              |
| ----------------------------- | -------------------- | -------------------------------- |
| `Array<T>` indexed access     | BEAM tuple           | O(1) read matches TS             |
| `interface`-typed object      | BEAM record (tagged tuple) | O(1) field access matches TS hidden class |
| Anonymous `{a: 1}` literal    | BEAM map             | Flexible shape, O(log n) access  |
| `Map<K,V>` / `Set<T>`         | BEAM map             | Closest available; O(log n) documented as gap from TS's O(1) |
| `string` literal              | BEAM binary          | O(1) `.length`, O(1) `s[i]`, O(n+m) concat |
| `number`                      | BEAM integer/float   | Free upgrade: arbitrary precision |
| `enum`                        | atoms                | Better than TS's underlying numbers |

**Lean into BEAM wins.** Big integers (arbitrary precision), TCO
(recursive code that stack-overflows on Node runs fine on BEAM),
immutability by default, native pattern match, lightweight processes.
Don't artificially hold ourselves back to TS's worse choices.

**Enforce idiomatic immutable TS.** Modern TS code is functionally
written: `arr.map`, `[...arr, x]`, `{...obj, k: v}`. We reject the
in-place mutators that idiomatic TS already avoids:

- `arr.push(x)`, `.pop()`, `.shift()`, `.unshift(x)` — use `[...arr, x]`
- `arr[i] = x` — use spread + rebuilt array
- `map.set(k, v)` — use `{...m, [k]: v}` or build from an iterable
- `set.add(x)` — same: build from an iterable

Each rejection is a compile-time `CompileError` with a message pointing
at the immutable alternative. The principle is "if your TS code is
idiomatic, it works; if it's idiomatic-but-mutable, the compiler tells
you what to write instead."

**This principle is binding.** If you're about to add a feature that
conflicts with it (e.g. accepting `.push` even silently), **stop and ask
the user**. Don't quietly change the principle.

---

## Hard rules

These have surfaced enough times to warrant explicit calling-out. Most
are protective; violating them quietly will degrade the project.

1. **Never push without explicit user approval.** Commit freely once
   we've agreed the work is right. Don't push.
2. **Never force-push, rebase published commits, or `git reset --hard`**
   without explicit approval.
3. **Never modify `LICENSE`.** Apache 2.0 is settled; matches the rest
   of the BEAM and TS ecosystems (Erlang/OTP, Elixir, Gleam, TypeScript
   are all Apache 2.0).
4. **Never add a runtime Node.js or Elixir dependency.** Compile-time
   tooling can use Node freely. The runtime artifact must be `.beam`
   only.
5. **Never re-introduce `scratch/`, `examples/`, or per-source-file
   `build/` directories.** All deliberately removed.
6. **Never add an `examples/` directory inside this repo.** Demo
   programs live in separate repos (Gleam's pattern). This repo is the
   compiler.
7. **Sandbox-first for emitter changes.** Before adding new Core Erlang
   emission (any new `ts.is*` branch, any new lowering, any new
   construct), write the target Core Erlang by hand in `local_sandbox/`
   and confirm `erlc +from_core` accepts it and the runtime produces
   the expected output. THEN write the emitter code. This rule exists
   because Core Erlang has multiple subtle gotchas the documentation
   doesn't surface (the canonical binary syntax, the absence of `<<>>`
   shorthand at this level, list comprehensions not parsing here,
   `fname/N` vs `fun fname/N` distinction). Several past sessions wasted
   hours emitting Core Erlang that `erlc` rejected because they skipped
   this step.
8. **Don't change AGENTS.md silently.** If you find something missing
   or stale here, flag it to the user and ask before editing. This
   document is meant to be authoritative; agents that mutate it
   unilaterally erode that authority.

---

## Layout

```text
src/
  compiler/
    parser.ts       # debug-only: prints the TS AST for a file
    lower/
      index.ts          # composes lowering passes
      lower-*.ts        # one file per construct that needs lowering
    emitter.ts      # AST → Core Erlang text (the main pass)
    errors.ts       # CompileError class (see Error conventions below)
    build.ts        # compile + run primitives, used by CLI + tests
  cli/
    index.ts        # tsbeam CLI entrypoint

tests/
  cases/            # positive fixtures (one .ts per feature)
  baselines/        # expected stdout, sibling to each case
  rejected/         # negative fixtures (.ts + .error pair)
  meta/             # harness self-check (don't add casually)
  run.ts            # orchestrator
  runFixture.ts     # per-fixture worker (spawned by run.ts)

plans/              # committed; paired plan_<ts>.md + discussion_<ts>.md
  cps/              # mid-block return lowering work
  phase2/           # data structure work (arrays, methods, objects, etc.)
  testing/          # the regression-coverage round

dist/               # gitignored — tsc output for OUR compiler source
build/              # gitignored — user-facing tsbeam output (per CWD)
tests/.build/       # gitignored — isolated build dir per test case
local_sandbox/      # gitignored — your private scratchpad (see below)

README.md           # public-facing overview
AGENTS.md           # this file
CONTRIBUTING.md     # local dev workflow
LICENSE             # Apache 2.0
```

**Two different "build" concepts** — don't confuse them:

- `dist/` = our compiler's TypeScript source transpiled to JS by `tsc`.
- `build/` = `.beam` and `.core` files tsbeam emits for user `.ts` files.

### `local_sandbox/` — your private scratchpad

A gitignored directory for throwaway work. Use it when:

- You want to hand-write a Core Erlang file and feed it through `erlc`
  to sanity-check the shape *before* changing the emitter (mandatory per
  hard rule 7).
- You want to run a small TS snippet through tsbeam without polluting
  `tests/cases/`.
- You're exploring something that isn't ready to become a test case.

Nothing in `local_sandbox/` is ever committed. Don't reference files
inside it from any committed code or docs. Safe to delete at any time.

---

## Pipeline architecture

The compiler has three stages today:

```text
parse  ─►  lower  ─►  emit  ─►  erlc  ─►  .beam
```

**parse**: TypeScript Compiler API. Free — `ts.createProgram` does the
work. We also extract a `ts.TypeChecker` here for downstream stages that
need type information.

**lower**: AST-to-AST rewrites that translate TS constructs without a
direct Core Erlang counterpart into shapes the emitter can handle. Each
construct that needs lowering gets its own file in `src/compiler/lower/`
(e.g. `lower-early-return.ts`). Composed by `src/compiler/lower/index.ts`.
Add new lowering files; don't write monolithic passes.

**emit**: walks the (lowered) AST and produces Core Erlang text. Most of
the compiler's surface area is here. Uses the type checker (via
`isStringType`, `interfaceNameFor`, etc.) to make type-directed
decisions: an interface-typed object literal becomes a record, a
string-typed `+` becomes binary concat, and so on.

### The lowering pass is always complete for the language we accept

We do **not** add lowering for constructs the parser/emitter don't
accept yet. That would be orphan code making design decisions about
constructs that don't exist in the compiled language. Each new construct
adds parser + (lowering if needed) + emitter handling in one logical
batch — never one without the others.

### Type checker integration

The emitter accepts an optional `ts.TypeChecker` and uses it for
type-directed dispatch in:

- `interfaceNameFor(expr)` — does this expression have a known interface
  type? If yes, lower as record (tagged tuple); else as anonymous map.
- `isStringType(expr)` — is this expression's type `string`-like? If
  yes, route through binary operations (byte_size, binary:part,
  `<<A/binary, B/binary>>`).

If the type checker is absent (null) or returns no type info, the
emitter **falls back to anonymous-map / non-string paths**. This
fallback is what keeps the compiler working for edge cases. **Don't
remove the null-checks**; they're load-bearing.

---

## Error conventions

The compiler throws two kinds of errors:

- **`CompileError`** (`src/compiler/errors.ts`): user-facing
  rejections. The user wrote TS we can't (or won't) compile. Examples:
  `arr.push(x)` rejected, unsupported AST node, missing initializer.
  Test harness uses `instanceof CompileError` to verify negative
  fixtures produce the right error.
- **Plain `Error`**: internal compiler bugs. The compiler hit a state
  it shouldn't have reached. Examples: `erlc failed with status N`
  (means we produced invalid Core Erlang — our bug), `erl terminated by
  signal`.

**When adding a new throw**: if it's because the user wrote something
we don't support, use `CompileError` with a message that names the TS
construct and (if applicable) points at the supported alternative. If
it's an internal invariant violation, use plain `Error` with a `BUG:`
prefix.

---

## Test fixtures — three kinds

The harness recognises three fixture kinds, each in its own directory.

**Positive** (most common): `tests/cases/<name>.ts` paired with
`tests/baselines/<name>.out`. The program compiles, runs on BEAM,
produces the exact stdout in the baseline file. **Stderr must be
empty.**

**Negative**: `tests/rejected/<name>.ts` paired with
`tests/rejected/<name>.error`. The compile **must fail** with a
`CompileError` whose message contains the substring in the `.error`
file (substring match, not exact — error messages can legitimately
grow trailing context).

**Meta**: `tests/meta/<name>.ts` paired with `tests/meta/<name>.out`.
Harness self-check. Baseline is deliberately wrong; fixture passes when
output does **NOT** match. Verifies the mismatch-detection actually
works. One meta fixture exists; don't add more without strong reason.

### Failure-mode semantics

`npm test` exits non-zero if any fixture fails. The summary tells you
how many passed and how many failed. The diff (for positive failures)
is printed inline.

When a failure reflects an intentional behavior change:

- **Positive**: run `npm run update-baseline`. Inspect each updated
  baseline before committing.
- **Negative**: edit `tests/rejected/<name>.error` by hand. Never
  automated.

### Naming

Name fixtures after the feature being tested, not the program. Several
existing naming conventions:

- `feature_basic.ts` — minimal exercise of a single feature
- `combo_<a>_<b>.ts` — combination of two features (real bugs hide here)
- `<thing>_rejected.ts` — negative fixture under `tests/rejected/`

Don't name fixtures `hello.ts`, `test1.ts`, `example.ts`,
`myprogram.ts`. When the suite fails, the fixture name should tell you
which feature regressed.

One feature per fixture. If you need to test two features together,
that's a `combo_` fixture.

---

## What's currently rejected (full list)

This is the authoritative list of TS constructs TSBeam rejects at
compile time with helpful errors. Each rejection is deliberate; don't
quietly add support without checking with the user first.

Mutation rejections (deliberate enforcement of immutable style):

- `arr.push(x)` — use `[...arr, x]` (array spread coming)
- `arr.pop()` — use `arr.slice(0, -1)` (slice coming)
- `arr.shift()` — use `arr.slice(1)` (slice coming)
- `arr.unshift(x)` — use `[x, ...arr]`
- `arr[i] = x` — index assignment is mutation; build a new array with
  the change applied
- `map.set(k, v)` — silent footgun on `const m`; use `{...m, [k]: v}`
- `set.add(x)` — same; build the Set from an iterable

Semantic rejections (the form is ambiguous or unsupported):

- `arr.reduce(f)` without initial value — ambiguous on empty arrays;
  always provide an initial: `arr.reduce(f, init)`
- `xs.map((x, i, arr) => ...)` (multi-arg callback) — only
  single-arg callbacks supported currently; use a closure for the
  index if needed
- `return` mid-block in shapes the CPS lowering doesn't reach — see
  `src/compiler/lower/lower-early-return.ts`; the `if`-then-rest case
  is lowered, everything else rejects

Deferred to future plans (not "won't do," just "not yet"):

- Computed property keys `{ [expr]: val }` — use literal keys for now
- Generic interfaces `interface Box<T>` — use concrete interfaces
- Interface inheritance / intersection types — use flat interfaces
- Optional properties `name?: string` — all fields currently required
- Function expressions in non-arrow form — use arrow functions

If a user hits a rejection that's missing from this list, the message
will say something like `unsupported expression: <SyntaxKind>` — that
means the emitter has no branch for it. Adding support is a real
language extension; consult plans + ask the user.

---

## Style: code

- TypeScript, strict mode. Don't relax `tsconfig.json`.
- **Default to no comments.** Add a comment only when the WHY is
  non-obvious (hidden constraint, subtle invariant, workaround). Don't
  explain WHAT the code does — names should already do that.
- No multi-line docstrings or comment blocks. One short line max.
- No "added for X" or "used by Y" comments. Those belong in commit
  messages and PR descriptions.
- No emojis in code unless the user explicitly asks.
- Don't add features, refactors, or abstractions beyond what the
  current task requires. A bug fix doesn't need cleanup; a one-shot
  doesn't need a helper.
- Don't add error handling, fallbacks, or validation for impossible
  cases. Trust internal code. Only validate at system boundaries (user
  input, external APIs).
- Type-checker fallbacks (the `if (!this.typeChecker) return false`
  pattern) ARE at a system boundary and must stay.

---

## Style: commits

- Subject: imperative mood, ≤72 chars. "Add early-return lowering" not
  "Added" or "Adding".
- Body: explain WHY when it's non-obvious. Match the style of existing
  commits.
- One commit per logical change. A new feature with its test case +
  baseline is one commit, not three.
- **Splitting work into multiple commits**: stage exactly the files for
  each commit via `git add <paths>`, then commit. Don't shuffle files
  through `/tmp`, don't `git stash` cycle, don't `git checkout HEAD --`
  to "save and restore" pieces. The working tree always contains all
  changes; commits are formed by selecting subsets.

---

## Planning convention

For each non-trivial work area, TSBeam keeps two paired files under
`plans/<area>/`:

- `plan_<YYYY-MM-DD_HHMM>.md` — agent/coder-consumable steps. Scope,
  architecture, ordered implementation steps, test cases, success
  criteria. Terse and scannable. The "Implementation notes" section
  gets filled in as work progresses.
- `discussion_<YYYY-MM-DD_HHMM>.md` — the human "why we got here" file.
  What was considered, what was rejected and why, the conversation
  that produced the plan. Prose, not bullet points.

Both files share the same timestamp suffix so they pair up. Future
plans for the same area get later timestamps under the same
subdirectory.

**Before designing a new feature, read the most recent discussion file
in the relevant `plans/<area>/` directory.** It captures the decisions
that constrain what you can do.

When you finish work, **fill in the plan's "Implementation notes"
section** with surprises, decisions changed during implementation, and
anything future agents working in the same area should know.

---

## What requires asking before doing

- Adding any top-level directory.
- Adding a new dependency (production or dev).
- Renaming or moving anything in `src/`.
- Changing the public CLI surface (`tsbeam build`, `tsbeam run`).
- Changing test case names or rejecting baselines without re-running.
- Anything touching `package.json`'s `bin` or `scripts`.
- Removing or relaxing any "currently rejected" entry above.
- Changing the design principle in any direction.
- Editing this file (AGENTS.md).

---

## What you can do freely

- Add new test cases for features that already work (or for features
  you're adding in the same commit).
- Refactor *within* a file when the change is local and
  behavior-preserving.
- Add type annotations to make existing code stricter.
- Improve error messages (but for rejected constructs, keep the
  immutable-alternative hint in the message — that's part of the
  contract with users).
- Fix typos in docs or comments.
- Update positive baselines via `npm run update-baseline` after a
  deliberate behavior change — commit the new baseline in the same
  change as the code.
- Hand-write Core Erlang in `local_sandbox/` to verify shapes before
  emitting (and indeed, you should — see hard rule 7).

---

## When in doubt

Ask the human. The cost of pausing is low; the cost of an unwanted
architectural change is high. Particularly:

- Anything that touches the design principle.
- Anything that changes the "currently rejected" list.
- Anything that adds a top-level directory or dependency.
- Anything that touches AGENTS.md, LICENSE, or `package.json` scripts.

If you find this file is missing something an agent should know, **flag
it and propose the addition**. Don't edit silently.
