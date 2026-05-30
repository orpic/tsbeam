interface User {
  name: string
  age: number
}

async function makeUser(n: string): Promise<User> {
  return { name: n, age: 30 }
}

const u = await makeUser("alice")
console.log(u.name)
console.log(u.age)
