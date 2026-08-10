import { createHash } from 'node:crypto'

export const SQL_DYNAMIC_MARKER = '__YOKO_DYNAMIC_SQL__'

const IDENTIFIER_START = /[A-Za-z_\p{L}]/u
const IDENTIFIER_PART = /[A-Za-z0-9_$\p{L}\p{N}]/u

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function isIdentifierStart(character) {
    return typeof character === 'string' && IDENTIFIER_START.test(character)
}

function isIdentifierPart(character) {
    return typeof character === 'string' && IDENTIFIER_PART.test(character)
}

/**
 * Tokenize the PostgreSQL surface needed by the architecture scanner. Values,
 * comments and dollar-quoted bodies are deliberately opaque: mutation words
 * inside them must never become architecture findings.
 */
export function tokenizeSql(sql) {
    const tokens = []
    let index = 0

    function push(kind, value, start, end = index, extra = {}) {
        tokens.push({ kind, value, start, end, ...extra })
    }

    while (index < sql.length) {
        const start = index
        const current = sql[index]
        const next = sql[index + 1]

        if (/\s/u.test(current)) {
            index += 1
            continue
        }

        if (current === '-' && next === '-') {
            index += 2
            while (index < sql.length && sql[index] !== '\n') index += 1
            continue
        }

        if (current === '/' && next === '*') {
            index += 2
            let depth = 1
            while (index < sql.length && depth > 0) {
                if (sql[index] === '/' && sql[index + 1] === '*') {
                    depth += 1
                    index += 2
                } else if (sql[index] === '*' && sql[index + 1] === '/') {
                    depth -= 1
                    index += 2
                } else index += 1
            }
            continue
        }

        if (current === "'") {
            index += 1
            while (index < sql.length) {
                if (sql[index] === "'" && sql[index + 1] === "'") index += 2
                else if (sql[index] === "'") {
                    index += 1
                    break
                } else index += 1
            }
            push('value', '<string>', start)
            continue
        }

        if (current === '$') {
            const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(sql.slice(index))?.[0]
            if (tag) {
                index += tag.length
                const closing = sql.indexOf(tag, index)
                const bodyEnd = closing === -1 ? sql.length : closing
                const body = sql.slice(index, bodyEnd)
                index = closing === -1 ? sql.length : closing + tag.length
                push(closing === -1 ? 'invalid' : 'dollar_value', '<dollar-string>', start, index, { body, tag })
                continue
            }
        }

        if (sql.startsWith(SQL_DYNAMIC_MARKER, index)) {
            index += SQL_DYNAMIC_MARKER.length
            push('dynamic', SQL_DYNAMIC_MARKER, start)
            continue
        }

        if (current === '"') {
            index += 1
            let value = ''
            let closed = false
            while (index < sql.length) {
                if (sql[index] === '"' && sql[index + 1] === '"') {
                    value += '"'
                    index += 2
                } else if (sql[index] === '"') {
                    index += 1
                    closed = true
                    break
                } else {
                    value += sql[index]
                    index += 1
                }
            }
            push(closed ? 'identifier' : 'invalid', value, start)
            continue
        }

        if (isIdentifierStart(current)) {
            index += 1
            while (index < sql.length && isIdentifierPart(sql[index])) index += 1
            push('word', sql.slice(start, index), start)
            continue
        }

        if (/[0-9]/u.test(current)) {
            index += 1
            while (index < sql.length && /[0-9.eE+-]/u.test(sql[index])) index += 1
            push('value', '<number>', start)
            continue
        }

        index += 1
        push('symbol', current, start)
    }

    return tokens
}

function upper(token) {
    return token?.kind === 'word' ? token.value.toUpperCase() : null
}

function identifierAt(tokens, start) {
    const first = tokens[start]
    if (!first) return { dynamic: true, next: start, table: null }
    if (first.kind === 'dynamic') return { dynamic: true, next: start + 1, table: null }
    if (first.kind !== 'word' && first.kind !== 'identifier') return { dynamic: true, next: start, table: null }

    const parts = [first.value]
    let cursor = start + 1
    if (tokens[cursor]?.value === '.') {
        const second = tokens[cursor + 1]
        if (!second || (second.kind !== 'word' && second.kind !== 'identifier')) {
            return { dynamic: true, next: cursor + 1, table: null }
        }
        parts.push(second.value)
        cursor += 2
    }
    const table = parts.length === 2 && parts[0].toLowerCase() === 'public'
        ? parts[1]
        : parts.join('.')
    return { dynamic: false, next: cursor, table }
}

function skipWords(tokens, cursor, words) {
    while (words.has(upper(tokens[cursor]))) cursor += 1
    return cursor
}

function mutationRecord(operation, target, token, extra = {}) {
    return {
        operation,
        table: target.table,
        dynamic_target: target.dynamic,
        index: token.start,
        ...extra,
    }
}

function schemaMutationRecord(operation, targetKind, target, token) {
    const relationKinds = new Set(['TABLE', 'VIEW', 'MATERIALIZED_VIEW'])
    return mutationRecord(operation, {
        dynamic: target.dynamic,
        table: relationKinds.has(targetKind) ? target.table : null,
    }, token, {
        target_kind: targetKind,
        object: target.table,
    })
}

function policyMutationRecord(tokens, cursor, keyword, token) {
    if (upper(tokens[cursor + 1]) !== 'POLICY') return null
    let policyCursor = cursor + 2
    if (upper(tokens[policyCursor]) === 'IF' && upper(tokens[policyCursor + 1]) === 'EXISTS') policyCursor += 2
    const policy = identifierAt(tokens, policyCursor)
    let onCursor = policy.next
    while (onCursor < tokens.length && upper(tokens[onCursor]) !== 'ON' && tokens[onCursor]?.value !== ';') onCursor += 1
    const target = upper(tokens[onCursor]) === 'ON'
        ? identifierAt(tokens, onCursor + 1)
        : { dynamic: true, table: null }
    return mutationRecord(`${keyword}_POLICY`, target, token, {
        object: policy.table,
        target_kind: 'TABLE',
    })
}

function analyzeReadSurface(tokens) {
    const readTables = new Set()
    const relationAliases = new Set()
    const selectedColumns = new Set()
    let selectAll = false
    let projectionDynamic = false
    const relationTerminators = new Set([
        'CROSS', 'FULL', 'GROUP', 'HAVING', 'INNER', 'JOIN', 'LEFT', 'LIMIT',
        'OFFSET', 'ON', 'ORDER', 'OUTER', 'RIGHT', 'UNION', 'WHERE',
    ])
    const nonColumnWords = new Set([
        'AS', 'CASE', 'DISTINCT', 'ELSE', 'END', 'FALSE', 'FILTER', 'NULL',
        'OVER', 'THEN', 'TRUE', 'WHEN', 'WHERE',
    ])
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
        const keyword = upper(tokens[cursor])
        if (keyword === 'FROM' || keyword === 'JOIN') {
            if (tokens[cursor + 1]?.value === '(') {
                projectionDynamic = true
                continue
            }
            const target = identifierAt(tokens, cursor + 1)
            if (!target.dynamic && target.table) {
                readTables.add(target.table)
                relationAliases.add(target.table.toLowerCase())
                relationAliases.add((target.table.split('.').at(-1) ?? target.table).toLowerCase())
                let aliasCursor = target.next
                if (upper(tokens[aliasCursor]) === 'AS') aliasCursor += 1
                const alias = tokens[aliasCursor]
                if (
                    alias
                    && (alias.kind === 'word' || alias.kind === 'identifier')
                    && !relationTerminators.has(upper(alias))
                ) relationAliases.add(alias.value.toLowerCase())
            }
        }
    }
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
        const keyword = upper(tokens[cursor])
        if (keyword !== 'SELECT') continue
        for (let selectedCursor = cursor + 1; selectedCursor < tokens.length; selectedCursor += 1) {
            const selected = tokens[selectedCursor]
            if (upper(selected) === 'FROM' || selected.value === ';') break
            if (selected.value === '*') {
                selectAll = true
                continue
            }
            if (selected.kind !== 'word' && selected.kind !== 'identifier') continue
            const selectedKeyword = upper(selected)
            if (nonColumnWords.has(selectedKeyword)) continue
            if (tokens[selectedCursor + 1]?.value === '(') {
                const closing = tokens.findIndex((token, index) => index > selectedCursor + 1 && token.value === ')')
                const argumentsForFunction = closing > selectedCursor
                    ? tokens.slice(selectedCursor + 2, closing)
                    : []
                const safeCount = selectedKeyword === 'COUNT'
                    && argumentsForFunction.every((token) => token.value === '*' || token.value === '1')
                if (!safeCount) projectionDynamic = true
                if (closing > selectedCursor) selectedCursor = closing
                continue
            }
            if (tokens[selectedCursor + 1]?.value === '.' && tokens[selectedCursor + 2]) {
                const field = tokens[selectedCursor + 2]
                if (field.value === '*') selectAll = true
                else if (field.kind === 'word' || field.kind === 'identifier') selectedColumns.add(field.value)
                selectedCursor += 2
            } else if (relationAliases.has(selected.value.toLowerCase())) selectAll = true
            else selectedColumns.add(selected.value)
        }
    }
    return {
        read_tables: [...readTables].sort(),
        selected_columns: [...selectedColumns].sort(),
        select_all: selectAll,
        read_projection_dynamic: projectionDynamic,
    }
}

/**
 * Extract mutation targets without treating SELECT ... FOR UPDATE, foreign-key
 * ON UPDATE clauses or INSERT ... ON CONFLICT DO UPDATE as independent writes.
 * Unknown mutation targets are retained as ambiguous rather than discarded.
 */
export function analyzeSqlMutation(sql, options = {}) {
    if (typeof sql !== 'string') {
        return {
            is_mutation: null,
            ambiguous: true,
            dynamic: true,
            operations: [],
            tables: [],
            read_tables: [],
            selected_columns: [],
            select_all: false,
            read_projection_dynamic: true,
            reasons: ['sql_not_statically_available'],
            sql_sha256: null,
        }
    }

    const tokens = tokenizeSql(sql)
    const operations = []
    const reasons = new Set()
    let indeterminateMutation = false
    let dynamic = Boolean(options.forceDynamic) || tokens.some((token) => token.kind === 'dynamic')
    if (options.forceDynamic) reasons.add('dynamic_sql_fragment')
    if (tokens.some((token) => token.kind === 'dynamic')) reasons.add('dynamic_sql_marker')
    if (tokens.some((token) => token.kind === 'invalid')) {
        dynamic = true
        reasons.add('invalid_sql_token')
    }

    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
        const token = tokens[cursor]
        const keyword = upper(token)
        const previousKeyword = upper(tokens[cursor - 1])

        if (keyword === 'INSERT') {
            let targetCursor = cursor + 1
            targetCursor = skipWords(tokens, targetCursor, new Set(['OR', 'REPLACE', 'IGNORE']))
            if (upper(tokens[targetCursor]) !== 'INTO') continue
            targetCursor += 1
            if (upper(tokens[targetCursor]) === 'ONLY') targetCursor += 1
            const target = identifierAt(tokens, targetCursor)
            operations.push(mutationRecord('INSERT', target, token))
            continue
        }

        if (keyword === 'UPDATE') {
            if (previousKeyword === 'FOR' || previousKeyword === 'ON' || previousKeyword === 'DO') continue
            let targetCursor = cursor + 1
            if (upper(tokens[targetCursor]) === 'OR') targetCursor += 2
            if (new Set(['LOW_PRIORITY', 'IGNORE']).has(upper(tokens[targetCursor]))) {
                dynamic = true
                reasons.add('dialect_update_modifier_requires_review')
                targetCursor = skipWords(tokens, targetCursor, new Set(['LOW_PRIORITY', 'IGNORE']))
            }
            targetCursor = skipWords(tokens, targetCursor, new Set(['ONLY']))
            const target = identifierAt(tokens, targetCursor)
            if (!target.dynamic && new Set(['SET', 'ON', 'OF', 'TABLE']).has(target.table?.toUpperCase())) continue
            operations.push(mutationRecord('UPDATE', target, token))
            continue
        }

        if (keyword === 'DELETE' && upper(tokens[cursor + 1]) === 'FROM') {
            let targetCursor = cursor + 2
            if (upper(tokens[targetCursor]) === 'ONLY') targetCursor += 1
            const target = identifierAt(tokens, targetCursor)
            operations.push(mutationRecord('DELETE', target, token))
            continue
        }

        if (keyword === 'DELETE' && upper(tokens[cursor + 1]) !== 'FROM') {
            let fromCursor = cursor + 1
            while (fromCursor < tokens.length && upper(tokens[fromCursor]) !== 'FROM' && tokens[fromCursor]?.value !== ';') fromCursor += 1
            if (upper(tokens[fromCursor]) === 'FROM') {
                let targetCursor = fromCursor + 1
                if (upper(tokens[targetCursor]) === 'ONLY') targetCursor += 1
                const target = identifierAt(tokens, targetCursor)
                operations.push(mutationRecord('DELETE_MULTI', target, token, { multi_table: true }))
                dynamic = true
                reasons.add('multi_table_delete_requires_review')
            }
            continue
        }

        if (keyword === 'MERGE' && upper(tokens[cursor + 1]) === 'INTO') {
            const target = identifierAt(tokens, cursor + 2)
            operations.push(mutationRecord('MERGE', target, token))
            continue
        }

        if (keyword === 'REPLACE') {
            if (cursor > 0 && tokens[cursor - 1]?.value !== ';') continue
            if (tokens[cursor + 1]?.value === '(') continue
            let targetCursor = cursor + 1
            if (upper(tokens[targetCursor]) === 'INTO') targetCursor += 1
            const target = identifierAt(tokens, targetCursor)
            operations.push(mutationRecord('REPLACE', target, token))
            continue
        }

        if (keyword === 'COPY') {
            let targetCursor = cursor + 1
            if (upper(tokens[targetCursor]) === 'BINARY') targetCursor += 1
            // COPY (SELECT ...) TO ... is a read/export. COPY table FROM ...
            // writes the named table and therefore belongs in the ownership scan.
            if (tokens[targetCursor]?.value === '(') continue
            const target = identifierAt(tokens, targetCursor)
            let directionCursor = target.next
            while (directionCursor < tokens.length && !['FROM', 'TO'].includes(upper(tokens[directionCursor]))) directionCursor += 1
            if (upper(tokens[directionCursor]) === 'FROM') {
                operations.push(mutationRecord('COPY_FROM', target, token))
            }
            continue
        }

        if (keyword === 'CALL') {
            const procedure = identifierAt(tokens, cursor + 1)
            operations.push(mutationRecord('CALL', { dynamic: true, table: null }, token, {
                procedure: procedure.table,
            }))
            reasons.add('called_procedure_effects_unresolved')
            continue
        }

        if (keyword === 'DO') {
            let bodyCursor = cursor + 1
            if (upper(tokens[bodyCursor]) === 'LANGUAGE') bodyCursor += 2
            const bodyToken = tokens[bodyCursor]
            // INSERT ... ON CONFLICT DO UPDATE/NOTHING is handled as the
            // owning INSERT and is not an anonymous procedural block.
            if (bodyToken?.kind !== 'dollar_value') continue
            if (bodyToken?.kind === 'dollar_value') {
                const nested = analyzeSqlMutation(bodyToken.body, { forceDynamic: options.forceDynamic })
                for (const nestedOperation of nested.operations) {
                    operations.push({ ...nestedOperation, container: 'DO', index: token.start + nestedOperation.index })
                }
                for (const reason of nested.reasons) reasons.add(`do_block:${reason}`)
                if (!nested.is_mutation || nested.ambiguous) {
                    operations.push(mutationRecord('DO_BLOCK', { dynamic: true, table: null }, token))
                    reasons.add('do_block_effects_unresolved')
                }
            } else {
                operations.push(mutationRecord('DO_BLOCK', { dynamic: true, table: null }, token))
                reasons.add('do_block_not_statically_available')
            }
            continue
        }

        if (keyword === 'TRUNCATE') {
            let targetCursor = cursor + 1
            if (upper(tokens[targetCursor]) === 'TABLE') targetCursor += 1
            if (upper(tokens[targetCursor]) === 'ONLY') targetCursor += 1
            do {
                if (upper(tokens[targetCursor]) === 'ONLY') targetCursor += 1
                const target = identifierAt(tokens, targetCursor)
                operations.push(mutationRecord('TRUNCATE', target, token))
                targetCursor = target.next
                if (tokens[targetCursor]?.value !== ',') break
                targetCursor += 1
            } while (targetCursor < tokens.length)
            continue
        }

        if (keyword === 'CREATE') {
            const policy = policyMutationRecord(tokens, cursor, keyword, token)
            if (policy) {
                operations.push(policy)
                continue
            }
            let typeCursor = skipWords(tokens, cursor + 1, new Set(['OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'UNIQUE']))
            let type = upper(tokens[typeCursor])
            if (type === 'MATERIALIZED' && upper(tokens[typeCursor + 1]) === 'VIEW') {
                type = 'MATERIALIZED_VIEW'
                typeCursor += 1
            }
            if (type === 'TABLE') {
                let targetCursor = typeCursor + 1
                if (upper(tokens[targetCursor]) === 'IF' && upper(tokens[targetCursor + 1]) === 'NOT' && upper(tokens[targetCursor + 2]) === 'EXISTS') targetCursor += 3
                const target = identifierAt(tokens, targetCursor)
                operations.push(mutationRecord('CREATE_TABLE', target, token))
            } else if (type === 'INDEX') {
                let onCursor = typeCursor + 1
                while (onCursor < tokens.length && upper(tokens[onCursor]) !== 'ON' && tokens[onCursor].value !== ';') onCursor += 1
                if (upper(tokens[onCursor]) === 'ON') {
                    const target = identifierAt(tokens, onCursor + 1)
                    operations.push(mutationRecord('CREATE_INDEX', target, token))
                } else {
                    operations.push(mutationRecord('CREATE_INDEX', { dynamic: true, table: null }, token))
                }
            } else if (new Set(['VIEW', 'MATERIALIZED_VIEW', 'TYPE', 'SEQUENCE', 'SCHEMA', 'DATABASE', 'ROLE', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'EXTENSION']).has(type)) {
                let targetCursor = typeCursor + 1
                if (upper(tokens[targetCursor]) === 'IF' && upper(tokens[targetCursor + 1]) === 'NOT' && upper(tokens[targetCursor + 2]) === 'EXISTS') targetCursor += 3
                const target = identifierAt(tokens, targetCursor)
                operations.push(schemaMutationRecord(`CREATE_${type}`, type, target, token))
            }
            continue
        }

        if (keyword === 'ALTER') {
            const policy = policyMutationRecord(tokens, cursor, keyword, token)
            if (policy) {
                operations.push(policy)
                continue
            }
            let typeCursor = cursor + 1
            let type = upper(tokens[typeCursor])
            if (type === 'MATERIALIZED' && upper(tokens[typeCursor + 1]) === 'VIEW') {
                type = 'MATERIALIZED_VIEW'
                typeCursor += 1
            }
            if (!new Set(['TABLE', 'VIEW', 'MATERIALIZED_VIEW', 'TYPE', 'SEQUENCE', 'SCHEMA', 'DATABASE', 'ROLE', 'FUNCTION', 'PROCEDURE', 'EXTENSION']).has(type)) continue
            let targetCursor = typeCursor + 1
            if (upper(tokens[targetCursor]) === 'IF' && upper(tokens[targetCursor + 1]) === 'EXISTS') targetCursor += 2
            if (upper(tokens[targetCursor]) === 'ONLY') targetCursor += 1
            const target = identifierAt(tokens, targetCursor)
            operations.push(schemaMutationRecord(`ALTER_${type}`, type, target, token))
            continue
        }

        if (keyword === 'DROP') {
            const policy = policyMutationRecord(tokens, cursor, keyword, token)
            if (policy) {
                operations.push(policy)
                continue
            }
            let typeCursor = cursor + 1
            let type = upper(tokens[typeCursor])
            if (type === 'MATERIALIZED' && upper(tokens[typeCursor + 1]) === 'VIEW') {
                type = 'MATERIALIZED_VIEW'
                typeCursor += 1
            }
            if (!new Set(['TABLE', 'VIEW', 'MATERIALIZED_VIEW', 'INDEX', 'TYPE', 'SEQUENCE', 'SCHEMA', 'DATABASE', 'ROLE', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'EXTENSION']).has(type)) continue
            let targetCursor = typeCursor + 1
            if (type === 'INDEX' && upper(tokens[targetCursor]) === 'CONCURRENTLY') targetCursor += 1
            if (upper(tokens[targetCursor]) === 'IF' && upper(tokens[targetCursor + 1]) === 'EXISTS') targetCursor += 2
            if (upper(tokens[targetCursor]) === 'ONLY') targetCursor += 1
            do {
                const target = identifierAt(tokens, targetCursor)
                operations.push(schemaMutationRecord(`DROP_${type}`, type, target, token))
                targetCursor = target.next
                if (tokens[targetCursor]?.value !== ',') break
                targetCursor += 1
            } while (targetCursor < tokens.length)
            continue
        }

        if (keyword === 'REFRESH' && upper(tokens[cursor + 1]) === 'MATERIALIZED' && upper(tokens[cursor + 2]) === 'VIEW') {
            let targetCursor = cursor + 3
            if (upper(tokens[targetCursor]) === 'CONCURRENTLY') targetCursor += 1
            const target = identifierAt(tokens, targetCursor)
            operations.push(schemaMutationRecord('REFRESH_MATERIALIZED_VIEW', 'MATERIALIZED_VIEW', target, token))
            continue
        }

        if (keyword === 'COMMENT' && upper(tokens[cursor + 1]) === 'ON') {
            const type = upper(tokens[cursor + 2])
            if (new Set(['TABLE', 'VIEW', 'MATERIALIZED', 'COLUMN', 'TYPE', 'FUNCTION', 'SCHEMA', 'DATABASE']).has(type)) {
                let targetCursor = cursor + 3
                let targetKind = type
                if (type === 'MATERIALIZED' && upper(tokens[targetCursor]) === 'VIEW') {
                    targetKind = 'MATERIALIZED_VIEW'
                    targetCursor += 1
                }
                const target = identifierAt(tokens, targetCursor)
                operations.push(schemaMutationRecord(`COMMENT_${targetKind}`, targetKind, target, token))
            }
            continue
        }

        if (keyword === 'GRANT' || keyword === 'REVOKE') {
            operations.push(mutationRecord(keyword, { dynamic: true, table: null }, token))
            reasons.add('authorization_target_requires_review')
            continue
        }

        // A SELECT can invoke a user-defined mutating function. Static analysis
        // cannot prove an arbitrary function pure. Preserve the site as an
        // ambiguity instead of silently treating it as a read. Obvious SQL
        // aggregate/scalar built-ins are excluded to keep the signal useful.
        if (keyword === 'SELECT') {
            const SAFE_SELECT_FUNCTIONS = new Set([
                'AVG', 'COALESCE', 'COUNT', 'CURRENT_DATE', 'CURRENT_TIMESTAMP',
                'DATE', 'DATETIME', 'EXISTS', 'JSON_AGG', 'JSON_BUILD_OBJECT',
                'JSONB_AGG', 'JSONB_BUILD_OBJECT', 'LOWER', 'MAX', 'MIN', 'NOW',
                'NULLIF', 'REPLACE', 'ROUND', 'SUM', 'UPPER',
            ])
            for (let lookahead = cursor + 1; lookahead + 1 < tokens.length; lookahead += 1) {
                const lookaheadKeyword = upper(tokens[lookahead])
                if (['FROM', 'INTO', 'UNION', ';'].includes(lookaheadKeyword) || tokens[lookahead]?.value === ';') break
                if (
                    (tokens[lookahead]?.kind === 'word' || tokens[lookahead]?.kind === 'identifier')
                    && tokens[lookahead + 1]?.value === '('
                    && !SAFE_SELECT_FUNCTIONS.has(lookaheadKeyword)
                ) {
                    indeterminateMutation = true
                    reasons.add('select_function_side_effect_unresolved')
                    break
                }
            }
        }
    }

    if (operations.some((operation) => operation.dynamic_target)) {
        dynamic = true
        reasons.add('unresolved_mutation_target')
    }
    const tables = [...new Set(operations.map((operation) => operation.table).filter(Boolean))].sort()
    const readSurface = analyzeReadSurface(tokens)
    return {
        is_mutation: operations.length > 0 ? true : indeterminateMutation ? null : false,
        ambiguous: dynamic || indeterminateMutation || operations.some((operation) => operation.dynamic_target),
        dynamic,
        operations,
        tables,
        ...readSurface,
        reasons: [...reasons].sort(),
        sql_sha256: sha256(sql),
    }
}

export function analyzeSqlScript(sql, options = {}) {
    return analyzeSqlMutation(sql, options)
}
