const xs: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const total = xs
  .filter(x => x > 3)
  .map(x => x * 2)
  .reduce((acc, x) => acc + x, 0)
console.log(total)
