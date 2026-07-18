/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const {
    createPreviewProject,
    setPreviewProjectStatus,
    updatePreviewProject,
} = require('../product-preview.ts')

test('creates a paused project for every supported product type', () => {
    for (const type of ['qualification', 'churn', 'survey']) {
        const project = createPreviewProject(`Проект ${type}`, type, 1)
        assert.equal(project.type, type)
        assert.equal(project.status, 'paused')
        assert.equal(project.mockRuns, 0)
    }
})

test('rejects an empty or too-short project name', () => {
    assert.throws(() => createPreviewProject('  ', 'qualification', 1), /минимум 3/)
    assert.throws(() => createPreviewProject('AI', 'survey', 2), /минимум 3/)
})

test('edits a project without changing its identity or run count', () => {
    const project = createPreviewProject('Исходный проект', 'qualification', 1)
    const updated = updatePreviewProject(project, { name: 'Возврат водителей', type: 'churn' })
    assert.equal(updated.id, project.id)
    assert.equal(updated.mockRuns, project.mockRuns)
    assert.equal(updated.name, 'Возврат водителей')
    assert.equal(updated.type, 'churn')
})

test('archive transition is explicit and immutable', () => {
    const project = createPreviewProject('Опрос качества', 'survey', 1)
    const archived = setPreviewProjectStatus(project, 'archived')
    assert.equal(project.status, 'paused')
    assert.equal(archived.status, 'archived')
})
