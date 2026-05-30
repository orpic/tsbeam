async function makeMap(): Promise<Map<string, number>> {
  return new Map([["a", 1], ["b", 2]])
}

const m = await makeMap()
console.log(m.get("b"))
console.log(m.has("a"))
