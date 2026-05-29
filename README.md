# TSBeam

> A TypeScript-to-BEAM compiler. Write TypeScript, run on the BEAM VM. No Elixir.

TSBeam compiles `.ts` source into BEAM bytecode by way of Core Erlang — the
same IR Elixir, Gleam, and LFE target. The output runs on the BEAM VM with no
Node.js or Elixir at runtime.

```
TypeScript  ──►  Core Erlang  ──►  .beam  ──►  BEAM VM
```

## Status

Early. Phase 1 is working end-to-end on three test cases
([tests/cases/](tests/cases/)).

```typescript
function add(a: number, b: number): number {
  return a + b
}

console.log(add(1, 2))   // 3, computed on BEAM
```

### Supported today

- Function declarations with typed parameters (`number`)
- `let` / `const` bindings
- `if` / `else`
- Binary arithmetic: `+`, `-`, `*`, `/`
- Comparisons: `==`, `===`, `!=`, `!==`, `<`, `>`, `<=`, `>=`
- Unary `-`, `+`, `!`
- Numeric and string literals, booleans
- Local function calls
- `console.log(...)` → `io:format/2`

### Not yet

- Mid-block `return` (CPS lowering — coming next)
- Interfaces, arrays, maps
- Concurrency, OTP

## Quick start

Prerequisites: **Node.js 22+** and **Erlang/OTP 26+**.

```bash
git clone <repo>
cd tsbeam
npm install
npm test        # runs the test suite
```

To compile your own file:

```bash
echo 'console.log(1 + 2)' > main.ts
npm run tsbeam -- run main.ts       # prints 3
npm run tsbeam -- build main.ts     # writes ./build/main.beam
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full local workflow.

## How it works

1. **Parse** — the TypeScript Compiler API parses `.ts` into a typed AST.
2. **Emit** — [src/compiler/emitter.ts](src/compiler/emitter.ts) walks the AST
   and emits Core Erlang text.
3. **Compile** — `erlc +from_core` turns Core Erlang into `.beam` bytecode.
4. **Run** — `erl -noshell -eval '<module>:main(), halt().'` executes it on
   the BEAM VM.

Core Erlang is the right IR target because it's stable across OTP versions,
documented, and the same target every BEAM language uses.

## Project layout

```text
src/
  compiler/
    parser.ts     # debug: TS Compiler API → AST dump
    emitter.ts    # AST → Core Erlang text
    build.ts      # build/run primitives (used by CLI + tests)
  cli/
    index.ts      # tsbeam CLI entrypoint

tests/
  cases/          # .ts inputs — one feature per file
  baselines/      # expected stdout, sibling to each case
  run.ts          # test harness (compile + run + diff)
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
