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

## How to open a design conversation

When you're about to bring a multi-option design question to the user
(any new feature, new construct, new pipeline stage, anything in the
"ask before doing" list), follow this script. The user is the
architect; you're the engineer. Make a specific proposal, name what
you're giving up, and invite pushback on the load-bearing assumption.

### The script

1. **Read first.** Read `plans/<related-area>/discussion_*.md` and
   `plan_*.md`. Read the design principle above and the "what's
   currently rejected" section below. Read recent commits in the
   relevant area. Most of the time some options drop out immediately
   because they violate the principle or contradict prior decisions —
   that's the point of having those documents.

2. **Pre-filter.** Apply the principle and the prior decisions to the
   option space. Options that conflict with either are **ruled out
   silently** — don't present them as live options in the discussion.
   You can mention them in a one-liner "options ruled out: X (violates
   complexity-contract), Y (contradicts plans/foo decision)" but they
   don't take up airtime.

3. **Recommend one direction.** Of the surviving options, commit to
   one. Write 2-4 sentences explaining why it follows from the
   principles. Be specific — name the BEAM primitive it lowers to, the
   TS surface syntax, the user-visible behavior.

4. **Name what you're giving up.** Briefly list what the
   recommendation rules out (other surviving options, future
   extensibility, etc.) so the user knows the cost.

5. **Surface ONE genuinely-open question.** Pick the single
   load-bearing assumption your recommendation depends on. If that
   assumption is wrong, the whole recommendation flips. Ask the user
   to pressure-test specifically that point. Not five questions; one.

6. **Be explicit about your uncertainty.** Format like "the
   load-bearing assumption is X. If X is wrong (e.g., you actually
   want Y), the recommendation flips to Z." The user can quickly
   confirm or redirect.

### What this is NOT

- ❌ A neutral menu: "Option A, Option B, Option C, Option D — which
  resonates?" That's not facilitation; it's outsourcing the design
  work back to the user. If you're tempted to format like this, you
  haven't done step 1 (read first) and step 2 (pre-filter) yet.

- ❌ False humility: "I'm not sure but maybe X." If you've read the
  prior work and applied the principles, you almost certainly have a
  view. Have it. Be explicit about where you're uncertain (step 6),
  not vague about the whole proposal.

- ❌ Confident-but-shallow: a recommendation that doesn't ground in the
  principles, prior decisions, or BEAM/TS specifics. If you can't
  point at the "why" from existing constraints, you haven't earned the
  recommendation.

### When the principles genuinely don't decide

Rare, but real. Examples: a decision that changes the principles
themselves (we had this for the Phase 2 complexity-contract
conversation), a tradeoff where two principles point in different
directions, an architectural choice with no prior context.

In that case, **say so explicitly**: "The principles don't decide
between X and Y because [reason]. Here's the tradeoff..." and then
ask the user. The neutral-menu format is appropriate ONLY here, where
the user genuinely is the only person who can pick.

### Worked example: how Phase 3 would open

Bad opening (what to avoid):

> Phase 3 has four options: A) async/await mapped to processes,
> B) explicit process API, C) actor classes, D) hybrid. Which feels
> right for TSBeam's identity?

Good opening (what to do):

> Phase 3 step 1 should be **`async`/`await` lowering each call to a
> fresh BEAM process**, with `await` becoming a `receive`. This
> follows from the principle: TS programmers expect `async` to give
> them concurrency without learning a new model, and BEAM gives us
> "millions of processes" for free — that's the positive shock we
> advertise.
>
> Ruled out by principle: requiring users to learn `spawn`/`send`/
> `receive` to write concurrent TS (negative shock; idiomatic TS uses
> `async`). Ruled out by current scope: actor/GenServer classes
> (need classes first; Phase 4 work).
>
> The load-bearing assumption: each `async` call spawning a real BEAM
> process is right. The alternatives are coroutines-in-one-process
> (lighter, loses parallelism) or CPS-on-a-scheduler (reinvents what
> BEAM does badly). I think process-per-call is correct, but if you'd
> rather match Node's exact single-threaded async semantics, that
> flips the design entirely. Where do you want to land?

The second version takes the same amount of reading time but does the
design work the user is paying you to do.

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

One feature per single-feature fixture. If you need to test two
features together, that's a `combo_` fixture.

### Combination coverage — the full interaction matrix

**TSBeam is being built for real-world complex TypeScript backend
code, not toy programs.** Real backends use features in combination:
`async` functions that return objects, arrays of promises, recursive
functions that handle interface-typed values, closures that capture
strings, generic methods that work over any element type, and so on.
Bugs live in those interactions, not in features used alone.

So the rule is stronger than "add a combo fixture":

**For every new construct, add combination fixtures pairing it with
every existing feature it could plausibly interact with — not just
one, the whole matrix.**

When adding a new construct (call it `X`), enumerate the existing
features it touches at the language level:

- Does `X` produce values? → combo with arrays-of-X, objects with X
  fields, maps/sets keyed/valued by X, X passed as function arg,
  returned from functions, captured by arrows, awaited if relevant.
- Does `X` accept values? → combo with each value-producing construct
  flowing in.
- Does `X` introduce control flow? → combo with `if/else`, early
  return, recursion, existing lowering passes.
- Does `X` introduce a new type? → combo with interfaces declaring
  fields of that type, generic-shaped containers holding it.
- Does `X` have a TS-side surface other constructs reference (e.g.
  `await` referenced from inside an arrow body)? → combo with each
  such referencing construct.

The matrix is finite per new feature, usually 5-15 combos. If a combo
isn't plausibly real-world code, skip it. If you can imagine a
backend developer writing it, **include it.**

**Document the matrix you considered in the plan.** Each plan's test
case section should list the combination axes you enumerated, with a
fixture name for each (or an explicit reason for skipping). Future
agents doing similar work see the pattern and follow it.

A combo fixture that surfaces a bug is the round's responsibility to
fix — that's the "fix bugs in this round, no deferring" rule from the
testing harness work (see `plans/testing/discussion_2026-05-30_1034.md`).

#### Ownership: the agent who builds the feature owns the matrix

The agent who introduces a new construct **writes the combination
matrix as part of the same work**, not as a follow-up and not
inherited by the next agent. The work is incomplete without it.

This is non-negotiable. If you've added a new emitter branch, new
lowering pass, or new test fixture for a single-feature win condition,
and you're about to consider the work "done" before adding the combo
matrix, **you're not done.** The combo matrix is part of the
definition of done, not bonus polish.

If a later auditor (you or another agent) finds combos missing from
a previous round, the right response is: **ask the agent who built
the feature to add them**, or if that's not possible (different
session, different model), explicitly own the work as a follow-up
under your name. Do NOT silently backfill — the rule only changes
behavior if the agent who *should have written the combos* feels the
gap.

#### Definition of done for a new-feature plan

A plan covering a new construct or feature is "done" only when ALL
of these are true:

1. Win-condition fixture(s) pass.
2. The combination matrix is enumerated in the plan and the relevant
   combos are written as fixtures, with baselines committed.
3. Any combo fixture that surfaced a real bug is fixed in the same
   round.
4. README claims about the feature are demonstrated by at least one
   fixture (see the next subsection).
5. The plan's "Implementation notes" section is filled in with
   surprises encountered during the work.
6. `npm test` is green.

If any of 1-6 is missing, the work is in progress, not done.

### Documentation claims must be exercised by fixtures

If a README, AGENTS, or CONTRIBUTING claim describes runtime behavior
("X is O(1)", "Y runs in parallel", "Z preserves immutability"), at
least one fixture must demonstrate it. Don't write marketing copy
your fixtures can't support.

Example: if README says "each async call spawns a real BEAM process,
giving you true parallelism," there must be a fixture that exercises
parallelism (e.g., two concurrent slow tasks completing faster than
their sequential sum, or a `Promise.all`-style speedup demo). A
fixture that *just calls* an async function and awaits it doesn't
demonstrate parallelism — it demonstrates correctness of the
async/await protocol. Both are valuable; only one matches the claim.

If you write a claim and can't yet build the fixture, either:

- Rephrase the claim to match what's actually tested (e.g., "async
  calls compile to BEAM spawn; parallelism becomes observable with
  `Promise.all` in step 3"), OR
- Build the fixture first, then write the claim.

Never the other way around.

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

"Doubt" comes in two flavors with different responses:

**Doubt about implementation** ("how does Core Erlang express this?",
"what's the right slot index?"): resolve it yourself first. Hand-write
the target shape in `local_sandbox/`, read the prior plans, grep the
emitter for similar constructs. Most implementation doubt dissolves
once you've done the sandbox-first dance.

**Doubt about direction** ("which API surface should this expose?",
"how should this feature interact with existing principles?"): apply
the "How to open a design conversation" script above. The default is
**recommend, don't survey**. Ask the user only when:

- A decision touches the design principle itself.
- A decision changes the "currently rejected" list.
- Two principles point in genuinely different directions on the same
  question.
- The decision would add a top-level directory or runtime dependency.
- The decision would touch AGENTS.md, LICENSE, or `package.json`
  scripts.

In all other cases, do the work: pre-filter against principles, form
a recommendation, name what it rules out, surface one open question.
The cost of pausing on every multi-option design is high — it pushes
the design work onto the user. The cost of a confident-but-wrong
recommendation is lower than it looks, because step 5 of the script
explicitly invites pushback on the load-bearing assumption.

If you find this file is missing something an agent should know, **flag
it and propose the addition**. Don't edit silently.
