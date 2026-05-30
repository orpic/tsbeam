async function double(x: number): Promise<number> {
  return x * 2
}

const result = await double(21)
console.log(result)
