async function classify(x: number): Promise<number> {
  if (x > 10) {
    return 100
  }
  return 0
}

const a = await classify(20)
const b = await classify(5)
console.log(a + b)
