// Errors that represent user-facing compile-time rejections — bad TS code,
// unsupported features, semantic violations. The test harness uses
// `instanceof CompileError` to distinguish these from internal bugs (which
// stay as plain Error and indicate a TSBeam-side problem).
export class CompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CompileError"
  }
}
