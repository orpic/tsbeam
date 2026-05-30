import * as path from "node:path"
import * as fs from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TESTS_ROOT = path.resolve(__dirname, "../../tests")
const CASES_DIR = path.join(TESTS_ROOT, "cases")
const REJECTED_DIR = path.join(TESTS_ROOT, "rejected")
const META_DIR = path.join(TESTS_ROOT, "meta")
const WORKER_PATH = path.resolve(__dirname, "./runFixture.js")

type FixtureKind = "positive" | "negative" | "meta"

interface Fixture {
  kind: FixtureKind
  name: string
}

interface FixtureResult {
  kind: FixtureKind
  name: string
  ok: boolean
  reason?: string
  details?: string
  updatedBaseline?: boolean
}

function discover(): Fixture[] {
  const fixtures: Fixture[] = []
  const collect = (dir: string, kind: FixtureKind) => {
    if (!fs.existsSync(dir)) return
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".ts")) {
        fixtures.push({ kind, name: path.basename(f, ".ts") })
      }
    }
  }
  collect(CASES_DIR, "positive")
  collect(REJECTED_DIR, "negative")
  collect(META_DIR, "meta")
  return fixtures.sort((a, b) => a.name.localeCompare(b.name))
}

function runFixtureInChild(
  fixture: Fixture,
  updateBaseline: boolean,
): FixtureResult {
  const args = [
    WORKER_PATH,
    `--kind=${fixture.kind}`,
    fixture.name,
  ]
  if (updateBaseline) args.push("--update")

  const proc = spawnSync(process.execPath, args, { encoding: "utf8" })

  if (proc.status !== 0) {
    return {
      kind: fixture.kind,
      name: fixture.name,
      ok: false,
      reason: `worker process exited ${proc.status}`,
      details: (proc.stderr ?? "") + (proc.stdout ?? ""),
    }
  }

  const line = (proc.stdout ?? "").trim().split("\n").pop() ?? ""
  try {
    return JSON.parse(line) as FixtureResult
  } catch {
    return {
      kind: fixture.kind,
      name: fixture.name,
      ok: false,
      reason: "worker did not emit a valid JSON result",
      details: proc.stdout,
    }
  }
}

function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n")
}

function printResult(r: FixtureResult): void {
  const tag =
    r.kind === "negative"
      ? "[rejected] "
      : r.kind === "meta"
        ? "[meta] "
        : ""
  process.stdout.write(`  ${tag}${r.name} ... `)
  if (r.ok) {
    if (r.updatedBaseline) console.log("ok (baseline written)")
    else console.log("ok")
  } else {
    console.log("FAIL")
    console.log(`    ${r.reason ?? "unknown failure"}`)
    if (r.details) {
      console.log(indent(r.details, "    "))
    }
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const updateBaseline = args.includes("--update")
  const filter = args.find((a) => !a.startsWith("--"))

  const all = discover()
  const fixtures = filter
    ? all.filter((f) => f.name.includes(filter))
    : all

  if (fixtures.length === 0) {
    console.error(`no fixtures matched${filter ? ` filter '${filter}'` : ""}`)
    process.exit(1)
  }

  if (updateBaseline) {
    const nonPositive = fixtures.filter((f) => f.kind !== "positive")
    if (nonPositive.length > 0 && !filter) {
      // Soft warning: --update only touches positive baselines. Negative
      // .error files and meta baselines are never overwritten by tooling.
      console.log(
        "Note: --update only regenerates positive baselines. Negative and meta fixtures are not touched.",
      )
    }
  }

  const results: FixtureResult[] = []
  for (const f of fixtures) {
    const result = runFixtureInChild(f, updateBaseline)
    results.push(result)
    printResult(result)
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(
    `\n${passed} passed, ${failed} failed (${results.length} total)`,
  )

  if (failed > 0 && !updateBaseline) {
    const anyPositive = results.some((r) => !r.ok && r.kind === "positive")
    const anyNegative = results.some((r) => !r.ok && r.kind === "negative")
    if (anyPositive) {
      console.log(
        `\nIf a positive-test failure reflects an intentional change, run:`,
      )
      console.log(`  npm run update-baseline`)
    }
    if (anyNegative) {
      console.log(
        `\nFor negative-test failures, edit the .error file by hand if the message change is intentional.`,
      )
    }
  }

  process.exit(failed === 0 ? 0 : 1)
}

main()
