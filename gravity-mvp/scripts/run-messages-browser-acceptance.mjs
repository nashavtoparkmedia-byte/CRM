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

console.log('Running isolated Messages UI acceptance fixtures (Vitest + jsdom).')
console.log('Scenarios: Remezov, Shaburov, provider channels, add-phone ownership, search, Telegram bot.')

const result = spawnSync(
  process.execPath,
  ['./node_modules/vitest/vitest.mjs', 'run', ...scenarios],
  { cwd: projectRoot, stdio: 'inherit', env: { ...process.env, CI: '1' } },
)

process.exit(result.status ?? 1)
