import { build } from 'vite'
import { cp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Never copy to or delete the configured Pengu installation during this build.
process.chdir(fileURLToPath(new URL('..', import.meta.url)))
process.env.SONA_BUILD_ONLY = '1'
await build({ build: { outDir: 'dist/custom/plugins/sona' } })
const plugins = new URL('../dist/custom/plugins/', import.meta.url)
await mkdir(plugins, { recursive: true })
await cp(new URL('../sona-chat-bridge/', import.meta.url), new URL('sona-chat-bridge/', plugins), { recursive: true })
await cp(new URL('../CUSTOM.md', import.meta.url), new URL('../INSTALL.md', plugins))
console.log('Custom package ready: dist/custom/ (two sibling plugin folders)')
