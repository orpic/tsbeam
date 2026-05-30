# Contributing to TSBeam

Thanks for being here this early. This doc covers prerequisites, the dev
loop, and how to add tests.

## Prerequisites

| Tool           | Why                                   | Minimum |
| -------------- | ------------------------------------- | ------- |
| **Node.js**    | Runs the compiler during development  | 22.x    |
| **Erlang/OTP** | `erlc` builds `.beam`; `erl` runs it  | 26      |

Check both:

```bash
node --version    # v22.x.x
erl -version      # ... emulator version 14.x.y (= OTP 26+)
```

There is no Elixir dependency, and there never will be. `erlc` ships with
Erlang/OTP.

### Installing

- **Node.js** — [nvm](https://github.com/nvm-sh/nvm),
  [fnm](https://github.com/Schniz/fnm), or the official installer.
- **Erlang/OTP** — [asdf](https://asdf-vm.com) with the `erlang` plugin, or
  Homebrew (`brew install erlang`) on macOS.

## One-time setup

```bash
git clone <repo>
cd tsbeam
npm install
```

## The dev loop

The compiler is written in TypeScript. `tsc` transpiles `src/` → `dist/`, and
we run the resulting JS:

```bash
npm test                              # run the whole test suite
npm test -- arithmetic                # run cases matching 'arithmetic'
npm run tsbeam -- run my.ts           # compile + run any .ts file
npm run tsbeam -- build my.ts         # produce ./build/my.beam
```

For active iteration, leave `tsc --watch` in one terminal and re-run tests
from another:

```bash
npx tsc --watch
# in another terminal:
node dist/tests/run.js
```

### Inspecting intermediate output

To see the TypeScript AST for a file:

```bash
node dist/src/compiler/parser.js path/to/file.ts
```

To see the generated Core Erlang:

```bash
npm run tsbeam -- build path/to/file.ts
cat build/file.core
```

To disassemble the BEAM bytecode:

```bash
erl -noshell -eval 'beam_disasm:file("build/file.beam"), halt().'
```

## How the test suite works

There are three kinds of test fixtures:

**Positive** (`tests/cases/<name>.ts` + `tests/baselines/<name>.out`) — the
program must compile, run on BEAM, and produce the exact stdout in the
baseline. Stderr must be empty.

**Negative** (`tests/rejected/<name>.ts` + `tests/rejected/<name>.error`) —
the program must fail to compile with a `CompileError` whose message
contains the substring in the `.error` file. Matches the rejection paths
that enforce TSBeam's idiomatic rules (e.g. `arr.push(x)` rejected; use
`[...arr, x]`).

**Meta** (`tests/meta/<name>.ts` + `tests/meta/<name>.out`) — the harness's
own self-check. The baseline is *deliberately wrong*; the harness PASSES
the meta fixture when the output does NOT match. Verifies that the
mismatch-detection logic actually works. Don't add new meta fixtures
casually — one is enough.

The runner ([tests/run.ts](tests/run.ts)) is an orchestrator that spawns
a separate `node dist/tests/runFixture.js` child process per fixture.
**Process isolation is the default**, not opt-in: each fixture gets a
fresh process with no shared compiler state. Catches cross-test leak
bugs (we almost had one with `moduleFunctions` in the emitter).

A test fails on: missing baseline, output mismatch, non-zero exit,
unexpected stderr, wrong/missing CompileError for negative fixtures,
matching baseline for meta fixtures.

### Adding a positive test

1. Add `tests/cases/my_feature.ts`. Keep it small — one feature per file. End
   with `console.log(...)` so it prints something distinguishing.
2. Run `npm run update-baseline` to generate the baseline.
3. Inspect the baseline. If it's what you expected, commit both files. If not,
   fix the code (or the emitter) and re-run.
4. From then on, `npm test` will catch regressions in this case.

### Adding a negative test

1. Add `tests/rejected/my_rejection.ts` — the smallest program that
   should trigger the rejection.
2. Add `tests/rejected/my_rejection.error` containing a substring of the
   expected `CompileError` message (one line, minimal).
3. Run `npm test`. The fixture should pass (i.e., the rejection fires
   with the expected message). If not, the rejection isn't firing or the
   message changed — fix the emitter or update the substring.

Negative `.error` files are **never auto-regenerated**. `npm run
update-baseline` only touches positive baselines. If you intentionally
change an error message, edit the `.error` file by hand.

### Naming fixtures

Name after the feature, not the program:

- ✓ `arithmetic.ts`, `let_binding.ts`, `if_else.ts`, `combo_recursion.ts`,
  `push_rejected.ts`
- ✗ `hello.ts`, `test1.ts`, `example.ts`

## Working on the emitter

The emitter is in [src/compiler/emitter.ts](src/compiler/emitter.ts). It's a
straightforward AST walker that pattern-matches TypeScript node kinds and
returns Core Erlang text.

Core Erlang reference (the source of truth for output format):
<https://www.erlang.org/doc/apps/compiler/cerl.html>.

**Useful trick when adding a feature:** before touching the emitter, write
the Core Erlang you *want* by hand and confirm `erlc` accepts it. Use the
gitignored `local_sandbox/` directory at the repo root for this — that's
exactly what it's for.

```bash
mkdir -p local_sandbox
# write local_sandbox/foo.core
cd local_sandbox && erlc +from_core foo.core
erl -noshell -pa . -eval 'foo:main(), halt().'
```

Once you've got a working hand-written target, mirror that shape from the
emitter, then add a test case under `tests/cases/`.

`local_sandbox/` is your private scratchpad. Nothing in it is ever
committed; safe to delete at any time. Don't reference files in it from
committed code or docs.

## Submitting changes

1. Branch.
2. Add a test case for any new feature.
3. Confirm `npm test` is green.
4. Open a PR describing the feature and including the baseline of the new
   case in the description.

## Where to look first

- New to the project: [README.md](README.md).
- New to BEAM: the Core Erlang reference linked above is enough to follow the
  emitter; [Learn You Some Erlang](https://learnyousomeerlang.com/) for
  broader context.
- New to the TypeScript Compiler API: <https://ts-ast-viewer.com> is
  invaluable for spotting node kinds.
