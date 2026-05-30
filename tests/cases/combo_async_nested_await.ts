async function inc(x: number): Promise<number> {
  return x + 1
}

async function dbl(x: number): Promise<number> {
  return x * 2
}

const result = await dbl(await inc(20))
console.log(result)
