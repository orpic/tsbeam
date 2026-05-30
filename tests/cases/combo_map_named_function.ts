function double(n: number): number {
  return n * 2
}

const xs: number[] = [1, 2, 3]
const doubled = xs.map(double)
console.log(doubled[0])
console.log(doubled[1])
console.log(doubled[2])
