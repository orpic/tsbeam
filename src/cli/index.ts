import { build, run } from "../compiler/build.js"

function usage(): never {
  console.error("usage: tsbeam <build|run> <file.ts> [--out-dir <dir>]")
  process.exit(1)
}

interface ParsedArgs {
  cmd: string
  file: string
  outDir?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  let outDir: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--out-dir") {
      outDir = argv[++i]
      if (!outDir) usage()
    } else if (arg.startsWith("--out-dir=")) {
      outDir = arg.slice("--out-dir=".length)
    } else {
      positional.push(arg)
    }
  }

  const [cmd, file] = positional
  if (!cmd || !file) usage()
  return { cmd, file, outDir }
}

function main(): void {
  const { cmd, file, outDir } = parseArgs(process.argv.slice(2))

  try {
    if (cmd === "build") {
      const result = build(file, { outDir })
      console.log(`✓ ${result.beamPath}`)
    } else if (cmd === "run") {
      const result = run(file, { outDir })
      if (result.status !== 0) process.exit(result.status)
    } else {
      usage()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`tsbeam: ${msg}`)
    process.exit(1)
  }
}

main()
