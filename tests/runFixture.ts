import * as path from "node:path"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"
import { run, build } from "../src/compiler/build.js"
import { CompileError } from "../src/compiler/errors.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TESTS_ROOT = path.resolve(__dirname, "../../tests")

type FixtureKind = "positive" | "negative" | "meta"

interface FixtureResult {
  kind: FixtureKind
  name: string
  ok: boolean
  reason?: string
  details?: string
  updatedBaseline?: boolean
}

function emit(result: FixtureResult): never {
  process.stdout.write(JSON.stringify(result) + "\n")
  process.exit(0)
}

function runPositive(name: string, updateBaseline: boolean): FixtureResult {
  const tsPath = path.join(TESTS_ROOT, "cases", `${name}.ts`)
  const baselinePath = path.join(TESTS_ROOT, "baselines", `${name}.out`)
  const buildDir = path.join(TESTS_ROOT, ".build", name)

  fs.rmSync(buildDir, { recursive: true, force: true })

  let stdout: string
  try {
    const result = run(tsPath, { outDir: buildDir, capture: true })
    if (result.status !== 0) {
      return {
        kind: "positive",
        name,
        ok: false,
        reason: `erl exited with status ${result.status}`,
        details: result.stderr,
      }
    }
    if (result.stderr.trim().length > 0) {
      return {
        kind: "positive",
        name,
        ok: false,
        reason: "unexpected stderr output",
        details: result.stderr,
      }
    }
    stdout = result.stdout
  } catch (err) {
    return {
      kind: "positive",
      name,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  if (updateBaseline) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
    fs.writeFileSync(baselinePath, stdout, "utf8")
    return { kind: "positive", name, ok: true, updatedBaseline: true }
  }

  if (!fs.existsSync(baselinePath)) {
    return {
      kind: "positive",
      name,
      ok: false,
      reason: `missing baseline ${path.relative(TESTS_ROOT, baselinePath)} — run \`npm run update-baseline\` if this is intentional`,
      details: stdout,
    }
  }

  const expected = fs.readFileSync(baselinePath, "utf8")
  if (stdout === expected) return { kind: "positive", name, ok: true }

  return {
    kind: "positive",
    name,
    ok: false,
    reason: "output does not match baseline",
    details: simpleDiff(expected, stdout),
  }
}

function runNegative(name: string): FixtureResult {
  const tsPath = path.join(TESTS_ROOT, "rejected", `${name}.ts`)
  const errorPath = path.join(TESTS_ROOT, "rejected", `${name}.error`)
  const buildDir = path.join(TESTS_ROOT, ".build", `rejected__${name}`)

  fs.rmSync(buildDir, { recursive: true, force: true })

  if (!fs.existsSync(errorPath)) {
    return {
      kind: "negative",
      name,
      ok: false,
      reason: `missing expected-error file ${path.relative(TESTS_ROOT, errorPath)}`,
    }
  }

  const expectedSubstring = fs.readFileSync(errorPath, "utf8").trim()

  try {
    // Negative fixtures must FAIL to compile. If `build()` succeeds, the
    // rejection didn't fire — that's a regression.
    build(tsPath, { outDir: buildDir })
    return {
      kind: "negative",
      name,
      ok: false,
      reason: "expected compile-time rejection, but compilation succeeded",
    }
  } catch (err) {
    if (!(err instanceof CompileError)) {
      return {
        kind: "negative",
        name,
        ok: false,
        reason: `expected CompileError, got ${err instanceof Error ? err.constructor.name : typeof err}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (!err.message.includes(expectedSubstring)) {
      return {
        kind: "negative",
        name,
        ok: false,
        reason: `error message did not contain expected substring`,
        details: `expected substring: ${expectedSubstring}\nactual message:    ${err.message}`,
      }
    }
    return { kind: "negative", name, ok: true }
  }
}

function runMeta(name: string): FixtureResult {
  // Meta fixtures live under tests/meta/ with a deliberately-wrong baseline.
  // Pass condition: the underlying positive-style run reports a mismatch.
  // Any other outcome means the harness itself is broken.
  const tsPath = path.join(TESTS_ROOT, "meta", `${name}.ts`)
  const baselinePath = path.join(TESTS_ROOT, "meta", `${name}.out`)
  const buildDir = path.join(TESTS_ROOT, ".build", `meta__${name}`)

  fs.rmSync(buildDir, { recursive: true, force: true })

  let stdout: string
  try {
    const result = run(tsPath, { outDir: buildDir, capture: true })
    if (result.status !== 0) {
      return {
        kind: "meta",
        name,
        ok: false,
        reason: `meta fixture should compile and run; erl exited ${result.status}`,
        details: result.stderr,
      }
    }
    stdout = result.stdout
  } catch (err) {
    return {
      kind: "meta",
      name,
      ok: false,
      reason: `meta fixture should compile and run; threw ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!fs.existsSync(baselinePath)) {
    return {
      kind: "meta",
      name,
      ok: false,
      reason: `missing meta baseline ${path.relative(TESTS_ROOT, baselinePath)} (a meta fixture needs a deliberately-wrong baseline)`,
    }
  }

  const expected = fs.readFileSync(baselinePath, "utf8")
  if (stdout === expected) {
    return {
      kind: "meta",
      name,
      ok: false,
      reason: "meta fixture matched its baseline — the harness should have flagged a mismatch but did not (harness self-check failed)",
    }
  }
  return { kind: "meta", name, ok: true }
}

function simpleDiff(expected: string, actual: string): string {
  const exp = expected.split("\n")
  const act = actual.split("\n")
  const out: string[] = []
  const max = Math.max(exp.length, act.length)
  for (let i = 0; i < max; i++) {
    const e = exp[i] ?? "∅"
    const a = act[i] ?? "∅"
    if (e === a) out.push(`  ${e}`)
    else {
      out.push(`- ${e}`)
      out.push(`+ ${a}`)
    }
  }
  return out.join("\n")
}

function main(): void {
  const args = process.argv.slice(2)
  const kindArg = args.find((a) => a.startsWith("--kind="))
  const updateBaseline = args.includes("--update")
  const name = args.find((a) => !a.startsWith("--"))

  if (!kindArg || !name) {
    process.stderr.write(
      `usage: runFixture --kind=positive|negative|meta <name> [--update]\n`,
    )
    process.exit(2)
  }

  const kind = kindArg.slice("--kind=".length) as FixtureKind

  let result: FixtureResult
  if (kind === "positive") result = runPositive(name, updateBaseline)
  else if (kind === "negative") result = runNegative(name)
  else if (kind === "meta") result = runMeta(name)
  else {
    process.stderr.write(`unknown kind: ${kind}\n`)
    process.exit(2)
  }

  emit(result)
}

main()
