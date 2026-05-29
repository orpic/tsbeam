function f(n: number): number {
  const doubled = n * 2
  if (doubled > 100) {
    return 100
  }
  return doubled
}
console.log(f(7))
console.log(f(60))
