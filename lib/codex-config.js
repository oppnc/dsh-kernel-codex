// Minimal reader for the user's Codex CLI config: the top-level `model` key of
// ~/.codex/config.toml (CODEX_HOME honored). Used to pick the persona upstream
// would actually serve for that model (models.json instructions_template).
// Mirrors the mesh's own config.toml parse; duplicated here so this package
// stays dependency-free.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function readCodexConfigModel() {
  try {
    const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.codex')
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8')
    const m = toml.match(/^model\s*=\s*"([^"]+)"/m)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}
