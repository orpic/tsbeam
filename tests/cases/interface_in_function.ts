interface Point {
  x: number
  y: number
}

function distSquared(p: Point): number {
  return p.x * p.x + p.y * p.y
}

const a: Point = { x: 3, y: 4 }
console.log(distSquared(a))
