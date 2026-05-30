async function makeArray(n: number): Promise<number[]> {
  return [n, n * 2, n * 3]
}

const xs = await makeArray(5)
console.log(xs[1])
console.log(xs.length)
const doubled = xs.map((x) => x * 10)
console.log(doubled[2])
