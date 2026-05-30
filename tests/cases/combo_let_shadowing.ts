function compute(): number {
  const x = 10
  const inner = (): number => {
    const x = 100
    return x
  }
  return x + inner()
}

console.log(compute())
