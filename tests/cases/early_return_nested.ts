function f(a: number, b: number): number {
  if (a < 0) {
    if (b < 0) {
      return -1
    }
    return -2
  }
  return a + b
}
console.log(f(-1, -1))
console.log(f(-1, 5))
console.log(f(3, 4))
