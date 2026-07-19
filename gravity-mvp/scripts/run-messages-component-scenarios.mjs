import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scenarios = [
  'src/app/messages/components/ContactDriverProfilesPanel.test.tsx',
  'src/app/messages/components/ContactChannelRow.test.tsx',
  'src/app/messages/components/AddPhoneResolutionDialog.test.tsx',
  'src/app/messages/hooks/useContactSearch.test.tsx',
  'src/lib/__tests__/telegram-bot-profile-state.test.ts',
]

console.log('Running Messages component scenarios (Vitest + jsdom).')
console.log('These are component checks, not browser E2E evidence.')

const result = spawnSync(
  process.execPath,
  ['./node_modules/vitest/vitest.mjs', 'run', ...scenarios],
  { cwd: projectRoot, stdio: 'inherit', env: { ...process.env, CI: '1' } },
)

process.exit(result.status ?? 1)
