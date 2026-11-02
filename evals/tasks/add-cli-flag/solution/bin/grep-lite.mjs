#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const USAGE = 'usage: grep-lite [-i] [-c|--count] <pattern> <file>'

const ignoreCaseFlags = new Set(['-i', '--ignore-case'])
const countFlags = new Set(['-c', '--count'])
let ignoreCase = false
let countOnly = false
const positional = []
for (const arg of process.argv.slice(2)) {
  if (ignoreCaseFlags.has(arg)) ignoreCase = true
  else if (countFlags.has(arg)) countOnly = true
  else if (arg.startsWith('-') && arg !== '-') {
    console.error(`grep-lite: unknown option ${arg}`)
    console.error(USAGE)
    process.exit(2)
  } else positional.push(arg)
}
if (positional.length !== 2) {
  console.error(USAGE)
  process.exit(2)
}

const [pattern, file] = positional
const needle = ignoreCase ? pattern.toLowerCase() : pattern
let lines
try {
  lines = readFileSync(file, 'utf8').split('\n')
} catch (error) {
  console.error(`grep-lite: cannot read ${file}: ${error.message}`)
  process.exit(2)
}
if (lines[lines.length - 1] === '') lines.pop()

let matched = 0
for (const line of lines) {
  const hay = ignoreCase ? line.toLowerCase() : line
  if (hay.includes(needle)) {
    if (!countOnly) console.log(line)
    matched++
  }
}
if (countOnly) console.log(matched)
process.exit(matched > 0 ? 0 : 1)
