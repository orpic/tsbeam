async function greet(name: string): Promise<string> {
  return "Hello, " + name
}

const msg = await greet("world")
console.log(msg)
