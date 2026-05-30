const xs: number[] = [1, 2, 3, 4]
const sum = xs.reduce((acc, x) => acc + x, 0)
const product = xs.reduce((acc, x) => acc * x, 1)
console.log(sum)
console.log(product)
