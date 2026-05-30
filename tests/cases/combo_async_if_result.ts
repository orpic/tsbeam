async function fetchScore(): Promise<number> {
  return 75
}

const score = await fetchScore()
if (score > 50) {
  console.log("pass")
} else {
  console.log("fail")
}
