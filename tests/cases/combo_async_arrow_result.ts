async function getValues(): Promise<number[]> {
  return [1, 2, 3, 4]
}

const xs = await getValues()
const big = xs.filter((x) => x > 2)
console.log(big[0])
console.log(big[1])
