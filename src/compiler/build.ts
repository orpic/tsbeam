import * as ts from "typescript"
import * as path from "node:path"
import * as fs from "node:fs"
import { spawnSync } from "node:child_process"
import { emitCoreErlang } from "./emitter.js"
import { lower } from "./lower/index.js"
import { CompileError } from "./errors.js"

export interface BuildOptions {
  outDir?: string
}

export interface BuildResult {
  moduleName: string
  outDir: string
  corePath: string
  beamPath: string
}

export interface RunResult {
  stdout: string
  stderr: string
  status: number
}

interface ParsedSource {
  sourceFile: ts.SourceFile
  typeChecker: ts.TypeChecker
}

function parseSourceFile(filePath: string): ParsedSource {
  const program = ts.createProgram([filePath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    strict: true,
    noEmit: true,
  })
  const sourceFile = program.getSourceFile(filePath)
  if (!sourceFile) {
    throw new CompileError(`could not load source file: ${filePath}`)
  }
  return { sourceFile, typeChecker: program.getTypeChecker() }
}

export function build(tsPath: string, opts: BuildOptions = {}): BuildResult {
  const absolute = path.resolve(tsPath)
  if (!fs.existsSync(absolute)) {
    throw new CompileError(`file not found: ${absolute}`)
  }

  const moduleName = path.basename(absolute, path.extname(absolute))
  const outDir = path.resolve(opts.outDir ?? path.join(process.cwd(), "build"))
  fs.mkdirSync(outDir, { recursive: true })

  const { sourceFile, typeChecker } = parseSourceFile(absolute)
  const lowered = lower(sourceFile)
  const { source } = emitCoreErlang(lowered, moduleName, typeChecker)

  const corePath = path.join(outDir, `${moduleName}.core`)
  fs.writeFileSync(corePath, source, "utf8")

  const erlc = spawnSync(
    "erlc",
    ["+from_core", "-o", outDir, corePath],
    { stdio: "inherit" },
  )
  if (erlc.status !== 0) {
    throw new Error(`erlc failed with status ${erlc.status}`)
  }

  const beamPath = path.join(outDir, `${moduleName}.beam`)
  return { moduleName, outDir, corePath, beamPath }
}

export interface RunOptions extends BuildOptions {
  capture?: boolean
}

export function run(tsPath: string, opts: RunOptions = {}): RunResult {
  const { moduleName, outDir } = build(tsPath, opts)
  const erl = spawnSync(
    "erl",
    ["-noshell", "-pa", outDir, "-eval", `${moduleName}:main(), halt().`],
    opts.capture
      ? { encoding: "utf8" }
      : { stdio: "inherit", encoding: "utf8" },
  )
  if (erl.status === null) {
    throw new Error("erl terminated by signal")
  }
  return {
    stdout: erl.stdout ?? "",
    stderr: erl.stderr ?? "",
    status: erl.status,
  }
}
