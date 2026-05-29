function first(arr: number[]): number {
  return arr[0]
}

function makeArray(): number[] {
  return [100, 200, 300]
}

console.log(first(makeArray()))
console.log(first([7, 8, 9]))
