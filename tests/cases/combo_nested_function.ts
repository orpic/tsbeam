function outer(n: number): number {
  const addN = (x: number): number => x + n
  return addN(10)
}

console.log(outer(5))
console.log(outer(100))
