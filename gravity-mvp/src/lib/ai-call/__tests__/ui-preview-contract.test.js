/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const gravityRoot = path.resolve(__dirname, '..', '..', '..', '..')
const read = (relative) => fs.readFileSync(path.join(gravityRoot, relative), 'utf8')

test('/ai-calls route renders the isolated product preview', () => {
    const source = read('src/app/ai-calls/page.tsx')
    assert.match(source, /AiCallsProductPreview/)
    assert.doesNotMatch(source, /ContactService|MessageService|prisma/)
})

test('product shell exposes all five operator pages', () => {
    const source = read('src/components/ai-calls/AiCallsProductPreview.tsx')
    for (const label of ['Проекты', 'Сценарий', 'Тестовый запуск', 'Результат', 'Настройки']) {
        assert.match(source, new RegExp(label))
    }
})

test('preview components do not call network, SIP, provider or production APIs', () => {
    const directory = path.join(gravityRoot, 'src', 'components', 'ai-calls')
    const combined = fs.readdirSync(directory)
        .filter((file) => file.endsWith('.tsx'))
        .map((file) => fs.readFileSync(path.join(directory, file), 'utf8'))
        .join('\n')
    for (const forbidden of ['fetch(', 'WebSocket(', '/api/', 'process.env', 'originateAiCall', 'prisma.']) {
        assert.equal(combined.includes(forbidden), false, `forbidden preview surface: ${forbidden}`)
    }
})

test('operator UI hides raw model JSON and keeps technical IDs in details', () => {
    const results = read('src/components/ai-calls/ResultsPreviewPanel.tsx')
    assert.doesNotMatch(results, /JSON\.stringify/)
    assert.match(results, /<details/)
    assert.match(results, /Технические данные/)
})

test('projects include create, edit, archive, validation and empty state', () => {
    const projects = read('src/components/ai-calls/AiCallsProductPreview.tsx')
    for (const marker of ['Создать проект', 'Изменить', 'Архивировать', 'Проектов пока нет']) {
        assert.match(projects, new RegExp(marker))
    }
    const core = read('src/lib/ai-call/product-preview.ts')
    assert.match(core, /минимум 3 символа/)
})
