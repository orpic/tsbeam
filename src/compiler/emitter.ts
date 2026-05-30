import * as ts from "typescript"
import { CompileError } from "./errors.js"

type Emitted = string

interface ModuleOutput {
  name: string
  source: string
}

class Emitter {
  // name → arity for every module-level function. Used by emitCall to
  // dispatch `apply 'name'/arity(...)` and by emitExpression to emit
  // `fun 'name'/arity` when the name is referenced as a value.
  private moduleFunctions = new Map<string, number>()

  // interface name → ordered field names. Object literals whose contextual
  // type matches an interface compile to tagged tuples (records), and
  // property access on interface-typed expressions becomes element/N.
  private interfaces = new Map<string, string[]>()

  private asyncFunctions = new Set<string>()

  // Type checker for contextual / declared type queries. Optional; if
  // absent, we fall back to anonymous-map emission.
  private typeChecker: ts.TypeChecker | null = null

  private freshVarCounter = 0

  emitModule(
    sourceFile: ts.SourceFile,
    moduleName: string,
    typeChecker: ts.TypeChecker | null = null,
  ): ModuleOutput {
    const functions: Emitted[] = []
    const topLevelStatements: ts.Statement[] = []

    this.moduleFunctions.clear()
    this.interfaces.clear()
    this.asyncFunctions.clear()
    this.typeChecker = typeChecker
    this.freshVarCounter = 0

    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        this.moduleFunctions.set(stmt.name.text, stmt.parameters.length)
        if (
          stmt.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
          )
        ) {
          this.asyncFunctions.add(stmt.name.text)
        }
      }
      if (ts.isInterfaceDeclaration(stmt)) {
        const fields = stmt.members
          .filter(ts.isPropertySignature)
          .map((m) => {
            if (m.name && ts.isIdentifier(m.name)) return m.name.text
            if (m.name && ts.isStringLiteral(m.name)) return m.name.text
            return null
          })
          .filter((n): n is string => n !== null)
        this.interfaces.set(stmt.name.text, fields)
      }
    }

    for (const stmt of sourceFile.statements) {
      if (ts.isInterfaceDeclaration(stmt)) {
        // Already collected above; skip — interfaces are compile-time only.
        continue
      }
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

    if (this.asyncFunctions.has(name)) {
      return this.emitAsyncFunctionDeclaration(node, name, params, arity)
    }

    const body = this.emitBlock(node.body!)
    return `'${name}'/${arity} =\n    fun (${params.join(", ")}) ->\n${this.indent(body, 1)}`
  }

  private emitAsyncFunctionDeclaration(
    node: ts.FunctionDeclaration,
    name: string,
    params: string[],
    arity: number,
  ): Emitted {
    const callerVar = this.freshName("caller")
    const refVar = this.freshName("ref")
    const funVar = this.freshName("fun")
    const resultVar = this.freshName("result")

    const body = this.emitBlock(node.body!)

    const inner = [
      `let <${callerVar}> = call 'erlang':'self'()`,
      `in let <${refVar}> = call 'erlang':'make_ref'()`,
      `in let <${funVar}> = fun () ->`,
      `    let <${resultVar}> = ${body}`,
      `    in call 'erlang':'!'(${callerVar}, {${refVar}, ${resultVar}})`,
      `in do call 'erlang':'spawn'(${funVar})`,
      `   {${refVar}}`,
    ].join("\n")

    return `'${name}'/${arity} =\n    fun (${params.join(", ")}) ->\n${this.indent(inner, 1)}`
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
      return this.emitStringLiteralAsBinary(expr.text)
    }
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return "'true'"
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return "'false'"
    if (ts.isIdentifier(expr)) {
      const name = expr.text
      // When a module-level function name is referenced as a *value* (e.g.
      // passed to `.map(double)`), emit a fname reference. Calls to module
      // functions take the `apply 'name'/arity(args)` path in emitCall.
      const arity = this.moduleFunctions.get(name)
      if (arity !== undefined) {
        return `'${name}'/${arity}`
      }
      return this.tsIdentifierToCore(name)
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
    if (ts.isTypeOfExpression(expr)) {
      return this.emitTypeOf(expr)
    }
    if (ts.isObjectLiteralExpression(expr)) {
      return this.emitObjectLiteral(expr)
    }
    if (ts.isNewExpression(expr)) {
      return this.emitNewExpression(expr)
    }
    if (ts.isAwaitExpression(expr)) {
      return this.emitAwaitExpression(expr)
    }
    throw new CompileError(
      `unsupported expression: ${ts.SyntaxKind[expr.kind]}`,
    )
  }

  // Returns the interface name (e.g. "User") if `expr`'s type (declared or
  // contextual) matches one of our collected interfaces, else null. Used to
  // route object literals and property access through record emission.
  private interfaceNameFor(expr: ts.Expression): string | null {
    if (!this.typeChecker) return null
    const type =
      this.typeChecker.getContextualType(expr) ??
      this.typeChecker.getTypeAtLocation(expr)
    if (!type) return null
    return this.interfaceNameOfType(type)
  }

  // An async function returning Promise<User> gives a return expression the
  // contextual type `User | Promise<User>`. Scan union members so the
  // object literal still lowers to a record.
  private interfaceNameOfType(type: ts.Type): string | null {
    const symbol = type.aliasSymbol ?? type.symbol
    if (symbol && this.interfaces.has(symbol.name)) {
      return symbol.name
    }
    if (type.isUnion()) {
      for (const member of type.types) {
        const name = this.interfaceNameOfType(member)
        if (name !== null) return name
      }
    }
    return null
  }

  // Lowercase tag matching standard Erlang record convention. Two interfaces
  // can't share a name in the same module, so collisions are impossible.
  private recordTag(interfaceName: string): string {
    return `'${interfaceName.toLowerCase()}'`
  }

  private emitObjectLiteral(node: ts.ObjectLiteralExpression): string {
    const interfaceName = this.interfaceNameFor(node)
    if (interfaceName !== null) {
      return this.emitObjectLiteralAsRecord(node, interfaceName)
    }
    return this.emitObjectLiteralAsMap(node)
  }

  private emitObjectLiteralAsMap(node: ts.ObjectLiteralExpression): string {
    // Partition properties: spreads vs assignments.
    const spreads: ts.SpreadAssignment[] = []
    const entries: { key: string; value: string }[] = []

    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        spreads.push(prop)
        continue
      }
      if (ts.isPropertyAssignment(prop)) {
        const key = this.objectKeyToAtom(prop.name)
        const value = this.emitExpression(prop.initializer)
        entries.push({ key, value })
        continue
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name.text
        const key = `'${name}'`
        const value = this.tsIdentifierToCore(name)
        entries.push({ key, value })
        continue
      }
      throw new CompileError(
        `unsupported object property kind: ${ts.SyntaxKind[prop.kind]}`,
      )
    }

    const pairs = entries.map((e) => `${e.key} => ${e.value}`).join(", ")

    if (spreads.length === 0) {
      return `~{ ${pairs} }~`
    }
    if (spreads.length > 1) {
      throw new CompileError(
        "object literals with multiple spreads are not supported",
      )
    }
    const base = this.emitExpression(spreads[0].expression)
    if (entries.length === 0) return base
    return `~{ ${pairs} | ${base} }~`
  }

  // Emit object literal as a tagged-tuple record. The interface gives us
  // field order: {Tag, F1Value, F2Value, ...}. Tag is the interface name
  // lowercased. Spread updates compose multiple setelement calls on the
  // base expression.
  private emitObjectLiteralAsRecord(
    node: ts.ObjectLiteralExpression,
    interfaceName: string,
  ): string {
    const fields = this.interfaces.get(interfaceName)!
    const tag = this.recordTag(interfaceName)

    // Collect explicit field assignments and (at most one) spread base.
    const provided = new Map<string, string>()
    let baseExpr: string | null = null

    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        if (baseExpr !== null) {
          throw new CompileError(
            "object literals with multiple spreads are not supported",
          )
        }
        baseExpr = this.emitExpression(prop.expression)
        continue
      }
      if (ts.isPropertyAssignment(prop)) {
        const name =
          ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
            ? prop.name.text
            : null
        if (name === null) {
          throw new CompileError(
            "interface-typed object literal keys must be identifiers or string literals",
          )
        }
        provided.set(name, this.emitExpression(prop.initializer))
        continue
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name.text
        provided.set(name, this.tsIdentifierToCore(name))
        continue
      }
      throw new CompileError(
        `unsupported object property kind: ${ts.SyntaxKind[prop.kind]}`,
      )
    }

    // No spread: must provide every field. Build the tuple directly.
    if (baseExpr === null) {
      const slots = fields.map((f) => {
        const v = provided.get(f)
        if (v === undefined) {
          throw new CompileError(
            `interface ${interfaceName} requires field '${f}' but it was not provided`,
          )
        }
        return v
      })
      return `{${tag}, ${slots.join(", ")}}`
    }

    // Spread present: start from base, setelement for each overridden field.
    // Slot index = 1 (tag) + (field-index-in-interface + 1) = fieldIndex + 2.
    let acc = baseExpr
    for (const [fieldName, value] of provided.entries()) {
      const idx = fields.indexOf(fieldName)
      if (idx === -1) {
        throw new CompileError(
          `interface ${interfaceName} has no field '${fieldName}'`,
        )
      }
      const slot = idx + 2
      acc = `call 'erlang':'setelement'(${slot}, ${acc}, ${value})`
    }
    return acc
  }

  private objectKeyToAtom(name: ts.PropertyName): string {
    if (ts.isIdentifier(name)) return `'${name.text}'`
    if (ts.isStringLiteral(name)) return `'${name.text}'`
    if (ts.isNumericLiteral(name)) return name.text
    throw new CompileError(
      `unsupported object key kind: ${ts.SyntaxKind[name.kind]}`,
    )
  }

  private emitNewExpression(node: ts.NewExpression): string {
    if (!ts.isIdentifier(node.expression)) {
      throw new CompileError(
        "only `new Identifier(...)` is supported (e.g. new Map(), new Set())",
      )
    }
    const ctor = node.expression.text
    const args = node.arguments ?? ts.factory.createNodeArray()

    if (ctor === "Map") {
      // new Map() | new Map([[k, v], ...])
      if (args.length === 0) return `~{ }~`
      if (args.length !== 1 || !ts.isArrayLiteralExpression(args[0])) {
        throw new CompileError(
          "new Map(...) requires zero arguments or an array literal of [key, value] pairs",
        )
      }
      const pairs: string[] = []
      for (const el of args[0].elements) {
        if (
          !ts.isArrayLiteralExpression(el) ||
          el.elements.length !== 2
        ) {
          throw new CompileError(
            "new Map(...) entries must be two-element array literals: [key, value]",
          )
        }
        const k = this.emitExpression(el.elements[0])
        const v = this.emitExpression(el.elements[1])
        pairs.push(`{${k}, ${v}}`)
      }
      return `call 'maps':'from_list'([${pairs.join(", ")}])`
    }

    if (ctor === "Set") {
      // new Set() | new Set([1, 2, 3])
      if (args.length === 0) return `~{ }~`
      if (args.length !== 1 || !ts.isArrayLiteralExpression(args[0])) {
        throw new CompileError(
          "new Set(...) requires zero arguments or an array literal of values",
        )
      }
      const pairs: string[] = []
      for (const el of args[0].elements) {
        const v = this.emitExpression(el)
        pairs.push(`{${v}, 'true'}`)
      }
      return `call 'maps':'from_list'([${pairs.join(", ")}])`
    }

    throw new CompileError(
      `unsupported constructor: new ${ctor}() — only Map and Set are supported`,
    )
  }

  // `typeof x` returns one of "number", "string", "boolean", "object",
  // matching TS semantics for our current language. Cases are runtime
  // type-tag checks; the `_V when 'true' -> ...` fallback keeps the case
  // total even when no type matches (e.g. atoms not yet covered).
  private emitTypeOf(expr: ts.TypeOfExpression): string {
    const operand = this.emitExpression(expr.expression)
    // Returns BEAM binaries to match our string representation.
    const numberBin = this.emitStringLiteralAsBinary("number")
    const booleanBin = this.emitStringLiteralAsBinary("boolean")
    const stringBin = this.emitStringLiteralAsBinary("string")
    const objectBin = this.emitStringLiteralAsBinary("object")
    return [
      `case ${operand} of`,
      `  _V when call 'erlang':'is_integer'(_V) -> ${numberBin}`,
      `  _V when call 'erlang':'is_float'(_V) -> ${numberBin}`,
      `  _V when call 'erlang':'is_boolean'(_V) -> ${booleanBin}`,
      `  _V when call 'erlang':'is_binary'(_V) -> ${stringBin}`,
      `  _V when call 'erlang':'is_tuple'(_V) -> ${objectBin}`,
      `  _V when 'true' -> ${objectBin}`,
      `end`,
    ].join("\n")
  }

  private emitAwaitExpression(expr: ts.AwaitExpression): string {
    const operand = this.emitExpression(expr.expression)

    const promiseVar = this.freshName("promise")
    const refVar = this.freshName("ref")
    const matchVar = this.freshName("awaitRef")
    const valVar = this.freshName("val")

    return [
      `let <${promiseVar}> = ${operand}`,
      `in let <${refVar}> = call 'erlang':'element'(1, ${promiseVar})`,
      `in receive`,
      `    <{${matchVar}, ${valVar}}> when call 'erlang':'=:='(${matchVar}, ${refVar}) ->`,
      `\t${valVar}`,
      `after 'infinity' -> 'error'`,
    ].join("\n")
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
    // String indexing: s[i] returns a one-byte binary (matches TS's
    // one-character-string semantics) via binary:part/3.
    if (this.isStringType(expr.expression)) {
      const target = this.emitExpression(expr.expression)
      const index = this.emitExpression(expr.argumentExpression)
      return `call 'binary':'part'(${target}, ${index}, 1)`
    }
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
    // Interface-typed receiver: field access goes through element/N on the
    // tagged-tuple record. Slot = fieldIndex + 2 (slot 1 is the tag).
    const interfaceName = this.interfaceNameFor(expr.expression)
    if (interfaceName !== null) {
      const fields = this.interfaces.get(interfaceName)!
      const idx = fields.indexOf(name)
      if (idx !== -1) {
        const target = this.emitExpression(expr.expression)
        return `call 'erlang':'element'(${idx + 2}, ${target})`
      }
      // Field not in the interface — fall through to map access. Lets
      // generic methods like .size work even on interface-typed values.
    }
    const target = this.emitExpression(expr.expression)
    // `.length` on a string-typed value → byte_size on its binary form.
    // On a tuple (arrays) → tuple_size.
    if (name === "length") {
      if (this.isStringType(expr.expression)) {
        return `call 'erlang':'byte_size'(${target})`
      }
      return `call 'erlang':'tuple_size'(${target})`
    }
    // `.size` is the Map/Set property; lowers to maps:size.
    if (name === "size") {
      return `call 'maps':'size'(${target})`
    }
    // Default: anonymous-map field access. Atom-keyed lookup.
    return `call 'maps':'get'('${name}', ${target})`
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
    // String concatenation: when either operand is string-typed, the +
    // operator builds a new binary instead of doing integer addition.
    if (
      expr.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (this.isStringType(expr.left) || this.isStringType(expr.right))
    ) {
      const left = this.emitExpression(expr.left)
      const right = this.emitExpression(expr.right)
      return this.emitBinaryConcat(left, right)
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
        if (
          this.asyncFunctions.has(name) &&
          !ts.isAwaitExpression(expr.parent)
        ) {
          throw new CompileError(
            `async function '${name}' must be awaited — use: const result = await ${name}(...)`,
          )
        }
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
      set:
        "map.set(k, v) is not supported — TSBeam values are immutable. Build a new map: const m2 = {...m, [k]: v}.",
      add:
        "set.add(x) is not supported — TSBeam values are immutable. Build a new set from an array of values, or use a map with `true` values.",
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
      case "get": {
        // map.get(k) — returns undefined atom on miss, matching TS semantics
        if (args.length !== 1) {
          throw new CompileError(
            `map.get expects exactly 1 argument (the key); got ${args.length}`,
          )
        }
        const key = this.emitExpression(args[0])
        return `call 'maps':'get'(${key}, ${receiver}, 'undefined')`
      }
      case "has": {
        if (args.length !== 1) {
          throw new CompileError(
            `.has expects exactly 1 argument (the key/value); got ${args.length}`,
          )
        }
        const key = this.emitExpression(args[0])
        return `call 'maps':'is_key'(${key}, ${receiver})`
      }
      case "delete": {
        if (args.length !== 1) {
          throw new CompileError(
            `.delete expects exactly 1 argument (the key); got ${args.length}`,
          )
        }
        const key = this.emitExpression(args[0])
        return `call 'maps':'remove'(${key}, ${receiver})`
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

  private freshName(base: string): string {
    return `__${base}_${this.freshVarCounter++}`
  }

  // Emit a string literal as a BEAM binary using Core Erlang's verbose
  // binary-segment syntax. Each character becomes one byte segment.
  // The high-level <<"hello">> shorthand is NOT accepted by erlc +from_core
  // at this level — we have to use the canonical form.
  private emitStringLiteralAsBinary(text: string): string {
    if (text.length === 0) return `#{}#`
    const segments = []
    for (const ch of text) {
      // Treat each codepoint < 256 as one byte. Multi-byte (UTF-8) chars
      // become multiple segments via TextEncoder.
      for (const byte of new TextEncoder().encode(ch)) {
        segments.push(
          `#<${byte}>(8, 1, 'integer', ['unsigned', 'big'])`,
        )
      }
    }
    return `#{${segments.join(", ")}}#`
  }

  // Concatenate two emitted binary expressions into one. Both operands
  // must already be binaries; for string-typed values from emitExpression
  // that's guaranteed.
  private emitBinaryConcat(left: string, right: string): string {
    return [
      `#{`,
      `  #<${left}>('all', 8, 'binary', ['unsigned', 'big']),`,
      `  #<${right}>('all', 8, 'binary', ['unsigned', 'big'])`,
      `}#`,
    ].join("")
  }

  // True if the expression's type (declared or contextual) is a string.
  // Used to route +, .length, indexed access through binary operations.
  private isStringType(expr: ts.Expression): boolean {
    if (!this.typeChecker) return false
    const type = this.typeChecker.getTypeAtLocation(expr)
    if (!type) return false
    return (type.flags & ts.TypeFlags.StringLike) !== 0
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
  typeChecker: ts.TypeChecker | null = null,
): ModuleOutput {
  return new Emitter().emitModule(sourceFile, moduleName, typeChecker)
}
