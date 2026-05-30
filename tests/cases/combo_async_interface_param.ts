interface Box {
  width: number
  height: number
}

async function area(b: Box): Promise<number> {
  return b.width * b.height
}

const box: Box = { width: 4, height: 5 }
const a = await area(box)
console.log(a)
