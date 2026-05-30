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
- Mid-block `return` (lowered to nested `if/else`)
- Binary arithmetic: `+`, `-`, `*`, `/`
- Comparisons: `==`, `===`, `!=`, `!==`, `<`, `>`, `<=`, `>=`
- Unary `-`, `+`, `!`
- Numeric and string literals, booleans
- Arrays (`Array<T>` / `T[]`) — compile to BEAM tuples, O(1) read and `.length`
- Indexed access (`arr[i]`)
- Array methods: `.map`, `.filter`, `.reduce`, `.forEach`, `.indexOf`
- Arrow functions (`(x) => x * 2`) with lexical capture
- Local function calls
- `console.log(...)` → `io:format/2`

### Rejected with a helpful error

These compile-time errors enforce idiomatic immutable style:

- `arr.push(x)`, `.pop()`, `.shift()`, `.unshift(x)` — use array spread
  (`[...arr, x]`) when it lands
- `arr[i] = x` — same reason

### Not yet

- Array spread (`[...a, ...b]`), rest parameters
- More array methods (`.find`, `.some`, `.every`, `.slice`, `.includes`, etc.)
- Objects / interfaces
- `Map<K,V>`, `Set<T>`
- Loops, `break`, `continue`
- `try`/`catch`/`throw`
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
    lower/        # AST-to-AST rewrites before emission
      index.ts
      lower-early-return.ts
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
