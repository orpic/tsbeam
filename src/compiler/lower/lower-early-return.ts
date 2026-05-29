import * as ts from "typescript"

export function lowerEarlyReturn(sourceFile: ts.SourceFile): ts.SourceFile {
  const result = ts.transform(sourceFile, [transformer])
  const transformed = result.transformed[0] as ts.SourceFile
  result.dispose()
  return transformed
}

const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
  const { factory } = context

  function transformBlock(block: ts.Block): ts.Block {
    const lowered = lowerStatements(Array.from(block.statements))
    return factory.updateBlock(block, lowered)
  }

  // The core rewrite: walk a block's statements front-to-back. When we hit
  // an `if` whose then-branch is a terminal early-return (no else, then-block
  // ends in `return`), absorb the rest of the block into a synthesized
  // else-branch and stop. Otherwise, recurse into nested blocks/branches and
  // keep going.
  function lowerStatements(stmts: ts.Statement[]): ts.Statement[] {
    const out: ts.Statement[] = []

    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]
      const rest = stmts.slice(i + 1)

      if (
        ts.isIfStatement(stmt) &&
        !stmt.elseStatement &&
        thenBranchEndsInReturn(stmt.thenStatement) &&
        rest.length > 0
      ) {
        const synthesizedElse = factory.createBlock(
          lowerStatements(rest),
          true,
        )
        ts.setTextRange(synthesizedElse, {
          pos: rest[0].pos,
          end: rest[rest.length - 1].end,
        })

        const newThen = lowerStatement(stmt.thenStatement)
        const newIf = factory.updateIfStatement(
          stmt,
          stmt.expression,
          newThen,
          synthesizedElse,
        )
        out.push(newIf)
        return out
      }

      out.push(lowerStatement(stmt))
    }

    return out
  }

  function lowerStatement(stmt: ts.Statement): ts.Statement {
    if (ts.isBlock(stmt)) {
      return transformBlock(stmt)
    }
    if (ts.isIfStatement(stmt)) {
      const newThen = lowerStatement(stmt.thenStatement)
      const newElse = stmt.elseStatement
        ? lowerStatement(stmt.elseStatement)
        : undefined
      return factory.updateIfStatement(stmt, stmt.expression, newThen, newElse)
    }
    return stmt
  }

  function thenBranchEndsInReturn(branch: ts.Statement): boolean {
    if (ts.isReturnStatement(branch)) return true
    if (ts.isBlock(branch)) {
      const last = branch.statements[branch.statements.length - 1]
      return last !== undefined && ts.isReturnStatement(last)
    }
    return false
  }

  function visit(node: ts.Node): ts.Node {
    if (ts.isFunctionDeclaration(node) && node.body) {
      const newBody = transformBlock(node.body)
      return factory.updateFunctionDeclaration(
        node,
        node.modifiers,
        node.asteriskToken,
        node.name,
        node.typeParameters,
        node.parameters,
        node.type,
        newBody,
      )
    }
    return ts.visitEachChild(node, visit, context)
  }

  return (sourceFile) => {
    // Top-level statements get the same treatment as function bodies — the
    // emitter synthesizes an implicit main() from them, so the same shape
    // rules apply.
    const loweredTopLevel = lowerStatements(
      Array.from(sourceFile.statements),
    )

    const visited = loweredTopLevel.map(
      (s) => ts.visitNode(s, visit) as ts.Statement,
    )

    return factory.updateSourceFile(sourceFile, visited)
  }
}
