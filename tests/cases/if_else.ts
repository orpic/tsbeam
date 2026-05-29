function classify(n: number): number {
  if (n > 0) {
    return 1
  } else {
    return 0
  }
}

const a: number = classify(7)
const b: number = classify(-3)
console.log(a)
console.log(b)
