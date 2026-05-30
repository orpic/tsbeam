const xs: number[] = [10, 20, 30]
const baseline = xs[0]
const addBaseline = (n: number): number => n + baseline
console.log(addBaseline(5))
console.log(addBaseline(xs[2]))
