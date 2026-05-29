import * as ts from "typescript"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function parseFile(filePath: string): ts.SourceFile {
  const program = ts.createProgram([filePath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    strict: true,
    noEmit: true,
  })

  const sourceFile = program.getSourceFile(filePath)
  if (!sourceFile) {
    throw new Error(`could not load source file: ${filePath}`)
  }
  return sourceFile
}

function printAst(node: ts.Node, sourceFile: ts.SourceFile, depth = 0): void {
  const indent = "  ".repeat(depth)
  const kind = ts.SyntaxKind[node.kind]
  const text = node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 60)
  console.log(`${indent}${kind}  ⟶  ${text}`)
  node.forEachChild((child) => printAst(child, sourceFile, depth + 1))
}

function main(): void {
  const target =
    process.argv[2] ??
    path.resolve(__dirname, "../../test/fixtures/hello.ts")

  const absolute = path.resolve(target)
  console.log(`parsing: ${absolute}\n`)

  const sourceFile = parseFile(absolute)
  printAst(sourceFile, sourceFile)
}

main()
