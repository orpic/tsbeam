async function transform(xs: number[]): Promise<number> {
  return xs.map((x) => x * 2).reduce((a, b) => a + b, 0)
}

const result = await transform([1, 2, 3])
console.log(result)
