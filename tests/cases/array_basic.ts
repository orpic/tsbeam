const xs: number[] = [10, 20, 30]
console.log(xs[0])
console.log(xs[2])
console.log(xs.length)

function sum(arr: number[]): number {
  return arr[0] + arr[1] + arr[2]
}
console.log(sum(xs))
