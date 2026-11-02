import { readFileSync } from 'node:fs'
import { loadConfig } from './config.mjs'

export function start(configPath) {
  const config = loadConfig(readFileSync(configPath, 'utf8'))
  console.log(`listening on ${config.port}, ${config.allowedHosts.length} allowed hosts`)
  return config
}
