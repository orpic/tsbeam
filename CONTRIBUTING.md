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

Each test is a pair of files:

- `tests/cases/<name>.ts` — the input program
- `tests/baselines/<name>.out` — the exact stdout the compiled program should
  produce on BEAM

The runner ([tests/run.ts](tests/run.ts)):

1. Discovers every `*.ts` in `tests/cases/`.
2. Compiles it through tsbeam into `tests/.build/<name>/` (isolated per case).
3. Runs the resulting `.beam` on BEAM.
4. Diffs captured stdout against `tests/baselines/<name>.out`.

A test fails on missing baseline, output mismatch, or non-zero exit. The
runner prints a unified diff on mismatch and exits non-zero if anything
failed.

### Adding a test

1. Add `tests/cases/my_feature.ts`. Keep it small — one feature per file. End
   with `console.log(...)` so it prints something distinguishing.
2. Run `npm run test:update` to generate the baseline.
3. Inspect the baseline. If it's what you expected, commit both files. If not,
   fix the code (or the emitter) and re-run.
4. From then on, `npm test` will catch regressions in this case.

### Naming cases

Name after the feature, not the program:

- ✓ `arithmetic.ts`, `let_binding.ts`, `if_else.ts`, `string_concat.ts`
- ✗ `hello.ts`, `test1.ts`, `example.ts`

## Working on the emitter

The emitter is in [src/compiler/emitter.ts](src/compiler/emitter.ts). It's a
straightforward AST walker that pattern-matches TypeScript node kinds and
returns Core Erlang text.

Core Erlang reference (the source of truth for output format):
<https://www.erlang.org/doc/apps/compiler/cerl.html>.

**Useful trick when adding a feature:** before touching the emitter, write
the Core Erlang you *want* by hand and confirm `erlc` accepts it:

```bash
mkdir -p /tmp/cerl-experiment && cd /tmp/cerl-experiment
# write foo.core
erlc +from_core foo.core
erl -noshell -pa . -eval 'foo:main(), halt().'
```

Once you've got a working hand-written target, mirror that shape from the
emitter, then add a test case.

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
