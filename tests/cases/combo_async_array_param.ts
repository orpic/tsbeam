async function sumFirst(xs: number[]): Promise<number> {
  return xs[0] + xs[1]
}

const total = await sumFirst([10, 20, 30])
console.log(total)
