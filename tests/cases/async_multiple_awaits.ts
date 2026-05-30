async function add(a: number, b: number): Promise<number> {
  return a + b
}

const x = await add(10, 11)
const y = await add(3, 4)
console.log(x + y)
