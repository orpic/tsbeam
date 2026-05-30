// Meta fixture for the test harness. This program prints 42, but the
// baseline file contains a deliberately-wrong value (999). The harness
// recognises this case as a meta fixture and PASSES when the output does
// NOT match the baseline — proving the harness can actually detect
// mismatches. If this meta fixture ever reports "ok" without a mismatch,
// the harness itself is broken.
console.log(42)
