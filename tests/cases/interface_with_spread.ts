interface User {
  name: string
  age: number
}

const alice: User = { name: "alice", age: 30 }
const older: User = { ...alice, age: 31 }
console.log(alice.age)
console.log(older.age)
console.log(older.name)
