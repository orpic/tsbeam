async function makeObj(n: number): Promise<{ count: number }> {
  return { count: n }
}

const o = await makeObj(7)
console.log(o.count)
