const xs: number[] = []
const doubled = xs.map(x => x * 2)
const big = xs.filter(x => x > 0)
const total = xs.reduce((acc, x) => acc + x, 100)
console.log(doubled.length)
console.log(big.length)
console.log(total)
