import * as ts from "typescript"
import { lowerEarlyReturn } from "./lower-early-return.js"

export type LoweringPass = (sourceFile: ts.SourceFile) => ts.SourceFile

const passes: LoweringPass[] = [lowerEarlyReturn]

export function lower(sourceFile: ts.SourceFile): ts.SourceFile {
  return passes.reduce((sf, pass) => pass(sf), sourceFile)
}
