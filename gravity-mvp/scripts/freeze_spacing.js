/**
 * freeze_spacing.js — одноразовая миграция Tailwind spacing-классов.
 *
 * Контекст: в globals.css @theme переопределял --spacing-{2,4,8,12,16,24,32}
 * на буквальные пиксели (1 unit = 1px вместо стандартных 4px). Весь UI
 * вёрстан под этой шкалой. Скрипт замораживает текущий вид: заменяет
 * затронутые классы на arbitrary-значения с фактическими пикселями
 * (gap-2 -> gap-[2px]), после чего @theme-переопределения можно удалить
 * и вернуть стандартную шкалу Tailwind для нового кода.
 *
 * Исключение: shadcn-примитивы в src/components/ui (lowercase-файлы) —
 * они спроектированы под стандартную шкалу и после удаления токенов
 * должны вернуться к нормальным размерам.
 *
 * Запуск: node scripts/freeze_spacing.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const DRY = process.argv.includes('--dry');

// shadcn-примитивы — НЕ замораживать (вернутся к стандартной шкале)
const SHADCN_EXCLUDE = new Set([
  'avatar.tsx', 'badge.tsx', 'button.tsx', 'card.tsx', 'checkbox.tsx',
  'dialog.tsx', 'dropdown-menu.tsx', 'input.tsx', 'label.tsx', 'select.tsx',
  'separator.tsx', 'sheet.tsx', 'skeleton.tsx', 'sonner.tsx', 'switch.tsx',
  'table.tsx', 'tabs.tsx', 'tooltip.tsx',
]);

// Утилиты на spacing-шкале. Порядок: длинные раньше коротких,
// чтобы min-h матчился раньше h, px раньше p и т.д.
const UTILS = [
  'min-h', 'min-w', 'max-h', 'max-w',
  'gap-x', 'gap-y', 'space-x', 'space-y',
  'inset-x', 'inset-y', 'inset',
  'translate-x', 'translate-y',
  'scroll-mt', 'scroll-mb', 'scroll-ml', 'scroll-mr', 'scroll-mx', 'scroll-my', 'scroll-m',
  'scroll-pt', 'scroll-pb', 'scroll-pl', 'scroll-pr', 'scroll-px', 'scroll-py', 'scroll-p',
  'basis', 'size', 'start', 'end',
  'top', 'bottom', 'left', 'right',
  'px', 'py', 'pt', 'pb', 'pl', 'pr', 'p',
  'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'm',
  'gap', 'h', 'w',
];
// Сломанные значения: N unit рендерился как N px
const NUMS = ['12', '16', '24', '32', '2', '4', '8'];

const RE = new RegExp(
  `(?<![\\w-])(-?)(${UTILS.join('|')})-(${NUMS.join('|')})(?![\\w./%\\]-])`,
  'g'
);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts|jsx|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

const isShadcn = (f) =>
  f.includes(path.join('components', 'ui') + path.sep) &&
  SHADCN_EXCLUDE.has(path.basename(f));

let totalRepl = 0;
let totalFiles = 0;
const perUtil = {};

for (const file of walk(SRC)) {
  if (isShadcn(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  let count = 0;
  const next = src.replace(RE, (full, neg, util, num) => {
    count++;
    perUtil[`${util}-${num}`] = (perUtil[`${util}-${num}`] || 0) + 1;
    return `${neg}${util}-[${num}px]`;
  });
  if (count > 0) {
    totalFiles++;
    totalRepl += count;
    if (!DRY) fs.writeFileSync(file, next, 'utf8');
    console.log(`${count}\t${path.relative(SRC, file)}`);
  }
}

console.log(`\n${DRY ? '[DRY RUN] ' : ''}Total: ${totalRepl} replacements in ${totalFiles} files`);
console.log('\nPer-utility:');
Object.entries(perUtil)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k}: ${v}`));
