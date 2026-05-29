import * as path from "node:path"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"
import { run } from "../src/compiler/build.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TESTS_ROOT = path.resolve(__dirname, "../../tests")
const CASES_DIR = path.join(TESTS_ROOT, "cases")
const BASELINES_DIR = path.join(TESTS_ROOT, "baselines")
const BUILD_DIR = path.join(TESTS_ROOT, ".build")

interface CaseResult {
  name: string
  ok: boolean
  reason?: string
  diff?: string
}

function discoverCases(): string[] {
  return fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.basename(f, ".ts"))
    .sort()
}

function runCase(name: string, updateBaselines: boolean): CaseResult {
  const tsPath = path.join(CASES_DIR, `${name}.ts`)
  const baselinePath = path.join(BASELINES_DIR, `${name}.out`)
  const caseBuildDir = path.join(BUILD_DIR, name)

  fs.rmSync(caseBuildDir, { recursive: true, force: true })

  let actual: string
  try {
    const result = run(tsPath, { outDir: caseBuildDir, capture: true })
    if (result.status !== 0) {
      return {
        name,
        ok: false,
        reason: `erl exited with status ${result.status}`,
        diff: result.stderr,
      }
    }
    actual = result.stdout
  } catch (err) {
    return {
      name,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  if (updateBaselines) {
    fs.mkdirSync(BASELINES_DIR, { recursive: true })
    fs.writeFileSync(baselinePath, actual, "utf8")
    return { name, ok: true, reason: "baseline written" }
  }

  if (!fs.existsSync(baselinePath)) {
    return {
      name,
      ok: false,
      reason: `missing baseline ${path.relative(TESTS_ROOT, baselinePath)} — run with --update to create it`,
      diff: actual,
    }
  }

  const expected = fs.readFileSync(baselinePath, "utf8")
  if (actual === expected) return { name, ok: true }

  return {
    name,
    ok: false,
    reason: "output does not match baseline",
    diff: simpleDiff(expected, actual),
  }
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
  const updateBaselines = args.includes("--update")
  const filter = args.find((a) => !a.startsWith("--"))

  const allCases = discoverCases()
  const cases = filter
    ? allCases.filter((c) => c.includes(filter))
    : allCases

  if (cases.length === 0) {
    console.error(`no cases matched${filter ? ` filter '${filter}'` : ""}`)
    process.exit(1)
  }

  const results: CaseResult[] = []
  for (const name of cases) {
    process.stdout.write(`  ${name} ... `)
    const result = runCase(name, updateBaselines)
    results.push(result)
    if (result.ok) {
      console.log(result.reason ? `ok (${result.reason})` : "ok")
    } else {
      console.log("FAIL")
      console.log(`    ${result.reason ?? "unknown failure"}`)
      if (result.diff) {
        console.log(result.diff.split("\n").map((l) => `    ${l}`).join("\n"))
      }
    }
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(`\n${passed} passed, ${failed} failed (${results.length} total)`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
