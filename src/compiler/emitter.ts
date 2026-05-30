import * as ts from "typescript"
import { CompileError } from "./errors.js"

type Emitted = string

interface ModuleOutput {
  name: string
  source: string
}

class Emitter {
  private moduleFunctions = new Set<string>()

  emitModule(sourceFile: ts.SourceFile, moduleName: string): ModuleOutput {
    const functions: Emitted[] = []
    const topLevelStatements: ts.Statement[] = []

    this.moduleFunctions.clear()
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        this.moduleFunctions.add(stmt.name.text)
      }
    }

    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        functions.push(this.emitFunctionDeclaration(stmt))
      } else {
        topLevelStatements.push(stmt)
      }
    }

    const mainFn = this.emitMain(topLevelStatements)

    const exports = this.collectExports(sourceFile, mainFn !== null)
    const source = this.assembleModule(moduleName, exports, functions, mainFn)
    return { name: moduleName, source }
  }

  private collectExports(sourceFile: ts.SourceFile, hasMain: boolean): string[] {
    const exports: string[] = []
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const arity = stmt.parameters.length
        exports.push(`'${stmt.name.text}'/${arity}`)
      }
    }
    if (hasMain) exports.push("'main'/0")
    exports.push("'module_info'/0", "'module_info'/1")
    return exports
  }

  private assembleModule(
    moduleName: string,
    exports: string[],
    functions: Emitted[],
    mainFn: Emitted | null,
  ): string {
    const exportList = exports.join(",\n\t\t")
    const allFns = [...functions]
    if (mainFn) allFns.push(mainFn)

    const moduleInfoFns = `
'module_info'/0 =
    fun () ->
	call 'erlang':'get_module_info'('${moduleName}')

'module_info'/1 =
    fun (_X) ->
	call 'erlang':'get_module_info'('${moduleName}', _X)
`.trim()

    return [
      `module '${moduleName}' [${exportList}]`,
      `    attributes []`,
      ``,
      allFns.join("\n\n"),
      ``,
      moduleInfoFns,
      ``,
      `end`,
      ``,
    ].join("\n")
  }

  private emitFunctionDeclaration(node: ts.FunctionDeclaration): Emitted {
    const name = node.name!.text
    const params = node.parameters.map((p) => this.tsParamName(p))
    const arity = params.length
    const body = this.emitBlock(node.body!)
    return `'${name}'/${arity} =\n    fun (${params.join(", ")}) ->\n${this.indent(body, 1)}`
  }

  private emitMain(stmts: ts.Statement[]): Emitted | null {
    if (stmts.length === 0) return null
    const body = this.emitStatementSequence(stmts)
    return `'main'/0 =\n    fun () ->\n${this.indent(body, 1)}`
  }

  // Fold a statement sequence into a Core Erlang expression.
  //
  // - `let`/`const` opens a `let <X> = E in <rest>` whose body is the rest of the
  //   sequence — bindings must scope over everything that follows.
  // - The last statement contributes the block's value (Core Erlang has no
  //   "statements," only expressions).
  // - Anything else with a discarded value is sequenced with `do <e> <rest>`.
  private emitStatementSequence(stmts: ts.Statement[]): string {
    if (stmts.length === 0) return "'ok'"

    const [head, ...rest] = stmts

    if (ts.isVariableStatement(head)) {
      return this.emitVariableStatement(head, rest)
    }

    if (rest.length === 0) {
      return this.emitTerminalStatement(head)
    }

    const headExpr = this.emitNonTerminalStatement(head)
    const restExpr = this.emitStatementSequence(rest)
    return `do ${headExpr}\n   ${restExpr}`
  }

  private emitVariableStatement(
    stmt: ts.VariableStatement,
    rest: ts.Statement[],
  ): string {
    const decls = stmt.declarationList.declarations
    // Multi-declarator forms (`let a = 1, b = 2`) nest as successive lets.
    return this.emitDeclarations(Array.from(decls), rest)
  }

  private emitDeclarations(
    decls: ts.VariableDeclaration[],
    rest: ts.Statement[],
  ): string {
    if (decls.length === 0) return this.emitStatementSequence(rest)

    const [decl, ...moreDecls] = decls
    if (!ts.isIdentifier(decl.name)) {
      throw new CompileError("only simple identifier bindings are supported")
    }
    if (!decl.initializer) {
      throw new CompileError(
        `binding '${decl.name.text}' must have an initializer`,
      )
    }
    const name = this.tsIdentifierToCore(decl.name.text)
    const init = this.emitExpression(decl.initializer)
    const body = this.emitDeclarations(moreDecls, rest)
    return `let <${name}> = ${init}\n   in ${body}`
  }

  // A terminal statement (last in its block) contributes the block's value.
  private emitTerminalStatement(stmt: ts.Statement): string {
    if (ts.isReturnStatement(stmt)) {
      return stmt.expression ? this.emitExpression(stmt.expression) : "'ok'"
    }
    if (ts.isExpressionStatement(stmt)) {
      return this.emitExpression(stmt.expression)
    }
    if (ts.isIfStatement(stmt)) {
      return this.emitIf(stmt)
    }
    if (ts.isBlock(stmt)) {
      return this.emitBlock(stmt)
    }
    throw new CompileError(
      `unsupported terminal statement: ${ts.SyntaxKind[stmt.kind]}`,
    )
  }

  // A non-terminal statement is evaluated for its effects; value is discarded.
  private emitNonTerminalStatement(stmt: ts.Statement): string {
    if (ts.isReturnStatement(stmt)) {
      // A `return` mid-block can't be expressed in pure Core Erlang without
      // CPS. Until we need it, treat it as terminal — anything after is dead.
      throw new CompileError(
        "`return` is only supported as the last statement of a block",
      )
    }
    if (ts.isExpressionStatement(stmt)) {
      return this.emitExpression(stmt.expression)
    }
    if (ts.isIfStatement(stmt)) {
      return this.emitIf(stmt)
    }
    if (ts.isBlock(stmt)) {
      return this.emitBlock(stmt)
    }
    throw new CompileError(
      `unsupported statement: ${ts.SyntaxKind[stmt.kind]}`,
    )
  }

  private emitBlock(block: ts.Block): string {
    return this.emitStatementSequence(Array.from(block.statements))
  }

  private emitIf(stmt: ts.IfStatement): string {
    const cond = this.emitExpression(stmt.expression)
    const thenBranch = this.emitBranch(stmt.thenStatement)
    const elseBranch = stmt.elseStatement
      ? this.emitBranch(stmt.elseStatement)
      : "'ok'"
    return [
      `case ${cond} of`,
      `      'true' when 'true' ->`,
      `\t${thenBranch}`,
      `      'false' when 'true' ->`,
      `\t${elseBranch}`,
      `    end`,
    ].join("\n")
  }

  private emitBranch(stmt: ts.Statement): string {
    if (ts.isBlock(stmt)) return this.emitBlock(stmt)
    return this.emitTerminalStatement(stmt)
  }

  private emitExpression(expr: ts.Expression): string {
    if (ts.isNumericLiteral(expr)) {
      return expr.text
    }
    if (ts.isStringLiteral(expr)) {
      return JSON.stringify(expr.text)
    }
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return "'true'"
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return "'false'"
    if (ts.isIdentifier(expr)) {
      return this.tsIdentifierToCore(expr.text)
    }
    if (ts.isBinaryExpression(expr)) {
      return this.emitBinary(expr)
    }
    if (ts.isCallExpression(expr)) {
      return this.emitCall(expr)
    }
    if (ts.isParenthesizedExpression(expr)) {
      return this.emitExpression(expr.expression)
    }
    if (ts.isPrefixUnaryExpression(expr)) {
      return this.emitPrefixUnary(expr)
    }
    if (ts.isArrayLiteralExpression(expr)) {
      return this.emitArrayLiteral(expr)
    }
    if (ts.isElementAccessExpression(expr)) {
      return this.emitElementAccess(expr)
    }
    if (ts.isPropertyAccessExpression(expr)) {
      return this.emitPropertyAccess(expr)
    }
    if (ts.isArrowFunction(expr)) {
      return this.emitArrowFunction(expr)
    }
    throw new CompileError(
      `unsupported expression: ${ts.SyntaxKind[expr.kind]}`,
    )
  }

  private emitArrowFunction(node: ts.ArrowFunction): string {
    const params = node.parameters.map((p) => this.tsParamName(p))
    const body = ts.isBlock(node.body)
      ? this.emitBlock(node.body)
      : this.emitExpression(node.body)
    return `fun (${params.join(", ")}) -> ${body}`
  }

  private emitArrayLiteral(expr: ts.ArrayLiteralExpression): string {
    const elements = expr.elements.map((e) => this.emitExpression(e))
    return `{${elements.join(", ")}}`
  }

  private emitElementAccess(expr: ts.ElementAccessExpression): string {
    const tuple = this.emitExpression(expr.expression)
    const index = this.emitOneIndexedIndex(expr.argumentExpression)
    return `call 'erlang':'element'(${index}, ${tuple})`
  }

  // TS indices are 0-based; Core Erlang `element/2` is 1-based.
  // Constant-fold numeric literals so 0 → 1 directly instead of `0 + 1`.
  private emitOneIndexedIndex(arg: ts.Expression): string {
    if (ts.isNumericLiteral(arg)) {
      const n = Number(arg.text)
      return String(n + 1)
    }
    const expr = this.emitExpression(arg)
    return `call 'erlang':'+'(${expr}, 1)`
  }

  private emitPropertyAccess(expr: ts.PropertyAccessExpression): string {
    const name = expr.name.text
    if (name === "length") {
      const target = this.emitExpression(expr.expression)
      return `call 'erlang':'tuple_size'(${target})`
    }
    throw new CompileError(
      `unsupported property access: .${name}`,
    )
  }

  private emitPrefixUnary(expr: ts.PrefixUnaryExpression): string {
    const operand = this.emitExpression(expr.operand)
    switch (expr.operator) {
      case ts.SyntaxKind.MinusToken:
        return `call 'erlang':'-'(${operand})`
      case ts.SyntaxKind.PlusToken:
        return operand
      case ts.SyntaxKind.ExclamationToken:
        return `call 'erlang':'not'(${operand})`
      default:
        throw new CompileError(
          `unsupported unary operator: ${ts.SyntaxKind[expr.operator]}`,
        )
    }
  }

  private emitBinary(expr: ts.BinaryExpression): string {
    if (
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(expr.left)
    ) {
      throw new CompileError(
        "arr[i] = x is not supported — TSBeam arrays are immutable. Build a new array with the change applied (array spread coming soon).",
      )
    }
    const op = this.binaryOpToErlang(expr.operatorToken.kind)
    const left = this.emitExpression(expr.left)
    const right = this.emitExpression(expr.right)
    return `call 'erlang':'${op}'(${left}, ${right})`
  }

  private binaryOpToErlang(kind: ts.SyntaxKind): string {
    switch (kind) {
      case ts.SyntaxKind.PlusToken:
        return "+"
      case ts.SyntaxKind.MinusToken:
        return "-"
      case ts.SyntaxKind.AsteriskToken:
        return "*"
      case ts.SyntaxKind.SlashToken:
        return "/"
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        // TS `==` is loose; we map both to Erlang's `=:=` (exact equality).
        // For Phase 1 numeric/string/bool scope this matches TS semantics.
        return "=:="
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return "=/="
      case ts.SyntaxKind.LessThanToken:
        return "<"
      case ts.SyntaxKind.GreaterThanToken:
        return ">"
      case ts.SyntaxKind.LessThanEqualsToken:
        return "=<"
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return ">="
      default:
        throw new CompileError(
          `unsupported binary operator: ${ts.SyntaxKind[kind]}`,
        )
    }
  }

  private emitCall(expr: ts.CallExpression): string {
    // console.log(x) → call 'io':'format'("~p~n", [x|[]])
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === "console" &&
      expr.expression.name.text === "log"
    ) {
      const args = expr.arguments.map((a) => this.emitExpression(a))
      const list = this.toCoreList(args)
      return `call 'io':'format'("~p~n", ${list})`
    }

    // x.method(...) — array methods or rejected mutators
    if (ts.isPropertyAccessExpression(expr.expression)) {
      return this.emitMethodCall(expr, expr.expression)
    }

    // f(args) — call by identifier
    if (ts.isIdentifier(expr.expression)) {
      const name = expr.expression.text
      const args = expr.arguments.map((a) => this.emitExpression(a))
      // Module-level FunctionDeclaration: apply 'name'/arity(args)
      if (this.moduleFunctions.has(name)) {
        return `apply '${name}'/${args.length}(${args.join(", ")})`
      }
      // Otherwise: a let-bound fun value (arrow, captured fun, etc).
      // Apply the value directly: apply _name(args).
      const coreName = this.tsIdentifierToCore(name)
      return `apply ${coreName}(${args.join(", ")})`
    }

    throw new CompileError("unsupported call expression")
  }

  private emitMethodCall(
    callExpr: ts.CallExpression,
    propAccess: ts.PropertyAccessExpression,
  ): string {
    const methodName = propAccess.name.text
    const receiver = this.emitExpression(propAccess.expression)
    const args = callExpr.arguments

    // Rejected mutators — fail with a helpful error
    const mutatorMessages: Record<string, string> = {
      push:
        "arr.push(x) is not supported — TSBeam arrays are immutable. Use [...arr, x] to build a new array (array spread coming soon).",
      pop:
        "arr.pop() is not supported — TSBeam arrays are immutable. Build a new array without the last element (spread support coming soon).",
      shift:
        "arr.shift() is not supported — TSBeam arrays are immutable. Build a new array without the first element (spread support coming soon).",
      unshift:
        "arr.unshift(x) is not supported — TSBeam arrays are immutable. Use [x, ...arr] (array spread coming soon).",
    }
    if (methodName in mutatorMessages) {
      throw new CompileError(mutatorMessages[methodName])
    }

    switch (methodName) {
      case "map":
      case "filter":
      case "forEach": {
        if (args.length !== 1) {
          throw new CompileError(
            `arr.${methodName} expects exactly 1 argument (the callback); got ${args.length}`,
          )
        }
        const callback = this.emitExpression(args[0])
        const listsFn =
          methodName === "map"
            ? "map"
            : methodName === "filter"
              ? "filter"
              : "foreach"
        const inner = `call 'lists':'${listsFn}'(${callback}, call 'erlang':'tuple_to_list'(${receiver}))`
        if (methodName === "forEach") return inner
        return `call 'erlang':'list_to_tuple'(${inner})`
      }
      case "reduce": {
        if (args.length !== 2) {
          throw new CompileError(
            "arr.reduce requires both a callback and an initial value (e.g. arr.reduce(f, 0)); the one-argument form is not supported",
          )
        }
        const callback = this.emitExpression(args[0])
        const init = this.emitExpression(args[1])
        return `call 'lists':'foldl'(${callback}, ${init}, call 'erlang':'tuple_to_list'(${receiver}))`
      }
      case "indexOf": {
        if (args.length !== 1) {
          throw new CompileError(
            `arr.indexOf expects exactly 1 argument (the target); got ${args.length}`,
          )
        }
        const target = this.emitExpression(args[0])
        return this.emitIndexOf(receiver, target)
      }
    }

    throw new CompileError(`unsupported method: .${methodName}`)
  }

  private emitIndexOf(receiver: string, target: string): string {
    // Walk the list with a foldl. Accumulator is a tagged tuple:
    // {'searching', I} until we hit the target; {'found', I} after.
    // Result: the found index, or -1.
    return [
      `case call 'lists':'foldl'(`,
      `       fun (_E, _Acc) ->`,
      `         case _Acc of`,
      `           {'found', _I} when 'true' -> _Acc`,
      `           {'searching', _I} when 'true' ->`,
      `             case call 'erlang':'=:='(_E, ${target}) of`,
      `               'true' when 'true' -> {'found', _I}`,
      `               'false' when 'true' -> {'searching', call 'erlang':'+'(_I, 1)}`,
      `             end`,
      `         end,`,
      `       {'searching', 0},`,
      `       call 'erlang':'tuple_to_list'(${receiver})) of`,
      `  {'found', _I} when 'true' -> _I`,
      `  {'searching', _} when 'true' -> call 'erlang':'-'(1)`,
      `end`,
    ].join("\n")
  }

  private toCoreList(items: string[]): string {
    // Core Erlang list syntax: [a|[b|[c|[]]]]
    let result = "[]"
    for (let i = items.length - 1; i >= 0; i--) {
      result = `[${items[i]}|${result}]`
    }
    return result
  }

  private tsParamName(p: ts.ParameterDeclaration): string {
    if (!ts.isIdentifier(p.name)) {
      throw new CompileError("only simple identifier parameters are supported")
    }
    return this.tsIdentifierToCore(p.name.text)
  }

  private tsIdentifierToCore(name: string): string {
    // Core Erlang variables must start with uppercase or _.
    // We prefix with _ to mirror typical compiler output and avoid clashes.
    return `_${name}`
  }

  private indent(text: string, level: number): string {
    const pad = "\t".repeat(level)
    return text
      .split("\n")
      .map((line) => (line.length ? pad + line : line))
      .join("\n")
  }
}

export function emitCoreErlang(
  sourceFile: ts.SourceFile,
  moduleName: string,
): ModuleOutput {
  return new Emitter().emitModule(sourceFile, moduleName)
}
