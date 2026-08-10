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
    let mysqlDelimiter = ';'

    function push(kind, value, start, end = index, extra = {}) {
        tokens.push({ kind, value, start, end, ...extra })
    }

    function relocateToken(token, offset, extra = {}) {
        return {
            ...token,
            start: token.start + offset,
            end: token.end + offset,
            ...(typeof token.body_start === 'number' ? { body_start: token.body_start + offset } : {}),
            ...extra,
        }
    }

    function statementIsCopyFromStdin() {
        // The just-emitted terminator is the final token; inspect back to the
        // preceding top-level statement boundary.
        let start = tokens.length - 2
        while (start >= 0 && tokens[start]?.value !== ';') start -= 1
        const statement = tokens.slice(start + 1, -1)
        const copy = statement.findIndex((token) => token.kind === 'word' && token.value.toUpperCase() === 'COPY')
        const from = statement.findIndex((token, position) => (
            position > copy && token.kind === 'word' && token.value.toUpperCase() === 'FROM'
        ))
        return copy !== -1 && from !== -1 && statement.slice(from + 1).some((token) => (
            token.kind === 'word' && token.value.toUpperCase() === 'STDIN'
        ))
    }

    while (index < sql.length) {
        const start = index
        const current = sql[index]
        const next = sql[index + 1]

        const lineStart = sql.lastIndexOf('\n', index - 1) + 1
        if (/^\s*$/u.test(sql.slice(lineStart, index))) {
            const delimiterDirective = /^DELIMITER[ \t]+(\S+)[^\r\n]*(?:\r?\n|$)/iu.exec(sql.slice(index))
            if (delimiterDirective) {
                mysqlDelimiter = delimiterDirective[1]
                index += delimiterDirective[0].length
                continue
            }
            const psqlDisplayCommand = /^\\(?:echo|qecho|warn)\b[^\r\n]*(?:\r?\n|$)/iu.exec(sql.slice(index))
            if (psqlDisplayCommand) {
                index += psqlDisplayCommand[0].length
                continue
            }
        }

        if (mysqlDelimiter !== ';' && sql.startsWith(mysqlDelimiter, index)) {
            index += mysqlDelimiter.length
            push('symbol', ';', start)
            continue
        }

        if (/\s/u.test(current)) {
            index += 1
            continue
        }

        if (current === '-' && next === '-') {
            if (!/\s/u.test(sql[index + 2] ?? '')) {
                // PostgreSQL accepts `--` without following whitespace;
                // MySQL does not and can execute the remainder as arithmetic
                // followed by another statement. Preserve that code and mark
                // the dialect split rather than hiding a possible mutation.
                index += 2
                push('ambiguity', '<dialect-dash-comment>', start, index, {
                    dialect_ambiguity_reason: 'dialect_dependent_dash_comment',
                })
                continue
            }
            index += 2
            while (index < sql.length && sql[index] !== '\n') index += 1
            continue
        }

        if (current === '/' && next === '*' && sql[index + 2] === '!') {
            index += 3
            const bodyStartCandidate = index
            while (/[0-9]/u.test(sql[index] ?? '')) index += 1
            if (index > bodyStartCandidate) while (/[ \t]/u.test(sql[index] ?? '')) index += 1
            const bodyStart = index
            const close = sql.indexOf('*/', index)
            const bodyEnd = close === -1 ? sql.length : close
            const nested = tokenizeSql(sql.slice(bodyStart, bodyEnd))
            tokens.push(...nested.map((token) => relocateToken(token, bodyStart, {
                dialect_ambiguity_reason: 'mysql_executable_comment',
            })))
            index = close === -1 ? sql.length : close + 2
            if (close === -1) push('invalid', '<unterminated-mysql-executable-comment>', start, index)
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

        if (current === '#' && next !== '>' && next !== '-') {
            // MySQL treats `#` as a line comment. PostgreSQL also has `#`
            // operators, so retain an ambiguity marker when the token could
            // instead be an inline operator; words in the MySQL comment must
            // never become confident SQL operations.
            const lineStart = sql.lastIndexOf('\n', start - 1) + 1
            const inline = /\S/u.test(sql.slice(lineStart, start))
            index += 1
            while (index < sql.length && sql[index] !== '\n') index += 1
            if (inline) {
                push('ambiguity', '<mysql-hash-comment>', start, index, {
                    dialect_ambiguity_reason: 'dialect_dependent_hash_comment',
                })
            }
            continue
        }

        if (current === "'") {
            const escapeStringPrefix = /[Ee]/u.test(sql[start - 1] ?? '')
                && (start < 2 || !isIdentifierPart(sql[start - 2]))
            if (
                escapeStringPrefix
                && tokens.at(-1)?.kind === 'word'
                && tokens.at(-1)?.value.toUpperCase() === 'E'
                && tokens.at(-1)?.end === start
            ) tokens.pop()
            let dialectDependentEscape = false
            let closed = false
            index += 1
            while (index < sql.length) {
                if (sql[index] === "'" && sql[index + 1] === "'") index += 2
                else if (sql[index] === '\\' && index + 1 < sql.length) {
                    // PostgreSQL requires E'' for backslash escapes while
                    // default-mode MySQL accepts them in ordinary strings.
                    // Parse the MySQL-safe extent and mark the dialect split
                    // instead of emitting its contents as confident SQL.
                    dialectDependentEscape ||= !escapeStringPrefix
                    index += 2
                }
                else if (sql[index] === "'") {
                    index += 1
                    closed = true
                    break
                } else index += 1
            }
            push(closed ? 'value' : 'invalid', closed ? '<string>' : '<unterminated-string>', start, index, dialectDependentEscape ? {
                dialect_ambiguity_reason: 'dialect_dependent_string_escape',
            } : {})
            continue
        }

        if (current === '$') {
            const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(sql.slice(index))?.[0]
            if (tag) {
                index += tag.length
                const closing = sql.indexOf(tag, index)
                const bodyEnd = closing === -1 ? sql.length : closing
                const body = sql.slice(index, bodyEnd)
                const bodyStart = index
                index = closing === -1 ? sql.length : closing + tag.length
                push(closing === -1 ? 'invalid' : 'dollar_value', '<dollar-string>', start, index, {
                    body,
                    body_start: bodyStart,
                    tag,
                })
                continue
            }
        }

        if (sql.startsWith(SQL_DYNAMIC_MARKER, index)) {
            index += SQL_DYNAMIC_MARKER.length
            push('dynamic', SQL_DYNAMIC_MARKER, start)
            continue
        }

        if (current === '"' || current === '`' || current === '[') {
            const close = current === '[' ? ']' : current
            index += 1
            let value = ''
            let closed = false
            let dialectDependentEscape = false
            while (index < sql.length) {
                if (sql[index] === close && sql[index + 1] === close) {
                    value += close
                    index += 2
                } else if (current === '"' && sql[index] === '\\' && index + 1 < sql.length) {
                    // PostgreSQL treats double quotes as identifiers, whereas
                    // default-mode MySQL treats them as strings and accepts
                    // backslash escapes. Consume the MySQL-safe extent and
                    // retain the dialect split instead of exposing its body as
                    // confident SQL.
                    dialectDependentEscape = true
                    index += 2
                } else if (sql[index] === close) {
                    index += 1
                    closed = true
                    break
                } else {
                    value += sql[index]
                    index += 1
                }
            }
            push(closed ? 'identifier' : 'invalid', dialectDependentEscape ? '<dialect-double-quoted>' : value, start, index, dialectDependentEscape ? {
                dialect_ambiguity_reason: 'dialect_dependent_double_quote_string',
            } : {})
            continue
        }

        if (isIdentifierStart(current)) {
            index += 1
            while (index < sql.length && isIdentifierPart(sql[index])) index += 1
            push('word', sql.slice(start, index), start)
            continue
        }

        if (/[0-9]/u.test(current)) {
            const numeric = /^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/u.exec(sql.slice(index))?.[0] ?? current
            index += numeric.length
            push('value', '<number>', start)
            continue
        }

        index += 1
        push('symbol', current, start)
        if (current === ';' && statementIsCopyFromStdin()) {
            const terminator = /(?:^|\n)[ \t]*\\\.[ \t]*(?:\r?\n|$)/gu
            terminator.lastIndex = index
            const match = terminator.exec(sql)
            if (match) index = match.index + match[0].length
            else {
                push('invalid', '<unterminated-copy-stdin>', index, sql.length)
                index = sql.length
            }
        }
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

function analyzeStatementReadSurface(tokens) {
    const readTables = new Set()
    const relationAliases = new Map()
    const selectedColumns = new Set()
    const selectedColumnSources = new Map()
    let selectAll = false
    let projectionDynamic = false
    const relationTerminators = new Set([
        'CROSS', 'FULL', 'GROUP', 'HAVING', 'INNER', 'JOIN', 'LEFT', 'LIMIT',
        'OFFSET', 'ON', 'ORDER', 'OUTER', 'RETURNING', 'RIGHT', 'SET',
        'UNION', 'USING', 'WHEN', 'WHERE',
    ])
    const nonColumnWords = new Set([
        'AS', 'CASE', 'DISTINCT', 'ELSE', 'END', 'FALSE', 'FILTER', 'NULL',
        'OVER', 'THEN', 'TRUE', 'WHEN', 'WHERE',
    ])
    const cteNames = new Set()
    if (upper(tokens[0]) === 'WITH') {
        let cursor = upper(tokens[1]) === 'RECURSIVE' ? 2 : 1
        while (cursor < tokens.length) {
            const cte = identifierAt(tokens, cursor)
            if (cte.dynamic || !cte.table) break
            cteNames.add(cte.table.toLowerCase())
            cursor = cte.next
            if (tokens[cursor]?.value === '(') {
                let depth = 1
                cursor += 1
                while (cursor < tokens.length && depth > 0) {
                    if (tokens[cursor]?.value === '(') depth += 1
                    if (tokens[cursor]?.value === ')') depth -= 1
                    cursor += 1
                }
            }
            if (upper(tokens[cursor]) !== 'AS' || tokens[cursor + 1]?.value !== '(') break
            cursor += 2
            let depth = 1
            while (cursor < tokens.length && depth > 0) {
                if (tokens[cursor]?.value === '(') depth += 1
                if (tokens[cursor]?.value === ')') depth -= 1
                cursor += 1
            }
            if (tokens[cursor]?.value !== ',') break
            cursor += 1
        }
    }
    const relationNames = new Set()
    function registerRelation(target, alias) {
        if (target.dynamic || !target.table) {
            projectionDynamic = true
            return
        }
        if (cteNames.has(target.table.toLowerCase())) {
            projectionDynamic = true
            if (alias) relationAliases.set(alias.toLowerCase(), null)
            relationAliases.set(target.table.toLowerCase(), null)
            return
        }
        readTables.add(target.table)
        relationNames.add(target.table.toLowerCase())
        relationNames.add((target.table.split('.').at(-1) ?? target.table).toLowerCase())
        relationAliases.set(target.table.toLowerCase(), target.table)
        relationAliases.set((target.table.split('.').at(-1) ?? target.table).toLowerCase(), target.table)
        if (alias) {
            const normalizedAlias = alias.toLowerCase()
            relationNames.add(normalizedAlias)
            const prior = relationAliases.get(normalizedAlias)
            if (prior && prior !== target.table) {
                // Nested query blocks can shadow an outer alias.  The token
                // scanner does not claim a false table in that case: retain
                // the field as unqualified and make the projection
                // explicitly fail closed.
                relationAliases.set(normalizedAlias, null)
                projectionDynamic = true
            } else if (!relationAliases.has(normalizedAlias)) {
                relationAliases.set(normalizedAlias, target.table)
            }
        }
    }
    function addSelectedColumn(field, table = null) {
        selectedColumns.add(field)
        const key = `${field.toLowerCase()}:${table?.toLowerCase() ?? ''}`
        selectedColumnSources.set(key, { field, table })
    }
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
        const keyword = upper(tokens[cursor])
        const dmlUsing = keyword === 'USING'
            && tokens[cursor + 1]?.value !== '('
            && tokens.slice(0, cursor).some((candidate) => new Set(['DELETE', 'MERGE']).has(upper(candidate)))
        if (keyword === 'FROM' || keyword === 'JOIN' || dmlUsing) {
            if (keyword === 'FROM' && upper(tokens[cursor - 1]) === 'DELETE') continue
            if (keyword === 'FROM') {
                let statementStart = cursor - 1
                while (statementStart >= 0 && tokens[statementStart]?.value !== ';') statementStart -= 1
                const prefix = new Set(tokens.slice(statementStart + 1, cursor).map(upper).filter(Boolean))
                if (prefix.has('COPY') && !prefix.has('SELECT')) continue
            }
            let relationCursor = cursor + 1
            do {
                relationCursor = skipWords(tokens, relationCursor, new Set(['LATERAL', 'ONLY']))
                if (tokens[relationCursor]?.value === '(') {
                    projectionDynamic = true
                    break
                }
                const target = identifierAt(tokens, relationCursor)
                let aliasCursor = target.next
                if (upper(tokens[aliasCursor]) === 'AS') aliasCursor += 1
                const alias = tokens[aliasCursor]
                const aliasName = (
                    alias
                    && (alias.kind === 'word' || alias.kind === 'identifier')
                    && !relationTerminators.has(upper(alias))
                    && alias.value !== ','
                ) ? alias.value : null
                registerRelation(target, aliasName)
                relationCursor = aliasName ? aliasCursor + 1 : target.next
                if (tokens[relationCursor]?.value !== ',') break
                relationCursor += 1
            } while (relationCursor < tokens.length)
        }
    }
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
        const keyword = upper(tokens[cursor])
        if (keyword !== 'SELECT') continue
        for (let selectedCursor = cursor + 1; selectedCursor < tokens.length; selectedCursor += 1) {
            const selected = tokens[selectedCursor]
            if (upper(selected) === 'FROM' || upper(selected) === 'INTO' || selected.value === ';') break
            if (selected.value === '*') {
                selectAll = true
                continue
            }
            if (selected.kind !== 'word' && selected.kind !== 'identifier') continue
            const selectedKeyword = upper(selected)
            if (nonColumnWords.has(selectedKeyword)) continue
            if (upper(tokens[selectedCursor - 1]) === 'AS') continue
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
                else if (field.kind === 'word' || field.kind === 'identifier') {
                    addSelectedColumn(field.value, relationAliases.get(selected.value.toLowerCase()) ?? null)
                }
                selectedCursor += 2
            } else if (relationAliases.has(selected.value.toLowerCase())) selectAll = true
            else addSelectedColumn(selected.value, readTables.size === 1 ? [...readTables][0] : null)
        }
    }
    for (let cursor = 0; cursor + 2 < tokens.length; cursor += 1) {
        const receiver = tokens[cursor]
        const field = tokens[cursor + 2]
        if (
            (receiver.kind === 'word' || receiver.kind === 'identifier')
            && relationAliases.has(receiver.value.toLowerCase())
            && tokens[cursor + 1]?.value === '.'
            && (field.kind === 'word' || field.kind === 'identifier')
        ) addSelectedColumn(field.value, relationAliases.get(receiver.value.toLowerCase()))
    }

    // UPDATE/DELETE/MERGE may read unqualified source fields in SET, WHERE or
    // ON expressions.  When there is one source relation, attribute those
    // identifiers to it.  With multiple sources retain an unqualified field
    // and fail closed instead of inventing a table identity.
    const statementKinds = new Set(tokens.map(upper).filter(Boolean))
    if ([...statementKinds].some((word) => new Set(['UPDATE', 'DELETE', 'MERGE']).has(word)) && readTables.size > 0) {
        const ignoredWords = new Set([
            'ALL', 'AND', 'AS', 'ASC', 'BY', 'CASE', 'CONFLICT', 'CROSS', 'CURRENT_DATE',
            'CURRENT_TIMESTAMP', 'DELETE', 'DESC', 'DISTINCT', 'DO', 'ELSE', 'END', 'EXISTS',
            'FALSE', 'FILTER', 'FROM', 'FULL', 'GROUP', 'HAVING', 'IN', 'INNER', 'INTO',
            'IS', 'JOIN', 'LEFT', 'LIKE', 'LIMIT', 'MATCHED', 'MERGE', 'NOT', 'NULL', 'OFFSET',
            'ON', 'ONLY', 'OR', 'ORDER', 'OUTER', 'OVER', 'RETURNING', 'RIGHT', 'SET', 'THEN',
            'TRUE', 'UNION', 'UPDATE', 'USING', 'VALUES', 'WHEN', 'WHERE', 'WITH',
        ])
        const mutationTargets = new Set()
        for (let cursor = 0; cursor < tokens.length; cursor += 1) {
            const keyword = upper(tokens[cursor])
            let targetCursor = null
            if (keyword === 'UPDATE') targetCursor = cursor + 1
            else if (keyword === 'DELETE' && upper(tokens[cursor + 1]) === 'FROM') targetCursor = cursor + 2
            else if (keyword === 'MERGE' && upper(tokens[cursor + 1]) === 'INTO') targetCursor = cursor + 2
            if (targetCursor === null) continue
            const target = identifierAt(tokens, skipWords(tokens, targetCursor, new Set(['ONLY'])))
            if (target.table) {
                mutationTargets.add(target.table.toLowerCase())
                mutationTargets.add((target.table.split('.').at(-1) ?? target.table).toLowerCase())
            }
        }
        for (let cursor = 0; cursor < tokens.length; cursor += 1) {
            const token = tokens[cursor]
            if (token.kind !== 'word' && token.kind !== 'identifier') continue
            const normalized = token.value.toLowerCase()
            if (ignoredWords.has(upper(token)) || relationNames.has(normalized) || mutationTargets.has(normalized)) continue
            if (tokens[cursor - 1]?.value === '.' || tokens[cursor + 1]?.value === '.') continue
            if (tokens[cursor + 1]?.value === '(') continue
            if (upper(tokens[cursor - 1]) === 'AS') continue
            // Assignment targets are writes, not source-field reads.
            if (/^(?:=|\+|-|\*|\/|\||&|\^|%|<|>)$/u.test(tokens[cursor + 1]?.value ?? '')) continue
            const table = readTables.size === 1 ? [...readTables][0] : null
            addSelectedColumn(token.value, table)
            if (!table) projectionDynamic = true
        }
    }
    return {
        read_tables: [...readTables].sort(),
        selected_columns: [...selectedColumns].sort(),
        selected_column_sources: [...selectedColumnSources.values()].sort((left, right) => (
            left.field.localeCompare(right.field) || String(left.table).localeCompare(String(right.table))
        )),
        select_all: selectAll,
        read_projection_dynamic: projectionDynamic,
    }
}

function analyzeReadSurface(tokens) {
    const statements = []
    let current = []
    let depth = 0
    for (const token of tokens) {
        if (token.value === '(') depth += 1
        if (token.value === ')') depth = Math.max(0, depth - 1)
        if (token.value === ';' && depth === 0) {
            if (current.length > 0) statements.push(current)
            current = []
        } else current.push(token)
    }
    if (current.length > 0) statements.push(current)
    if (statements.length === 0) statements.push(tokens)

    const parts = statements.map(analyzeStatementReadSurface)
    return {
        read_tables: [...new Set(parts.flatMap((part) => part.read_tables))].sort(),
        selected_columns: [...new Set(parts.flatMap((part) => part.selected_columns))].sort(),
        selected_column_sources: [...new Map(parts.flatMap((part) => (
            part.selected_column_sources.map((entry) => [`${entry.field.toLowerCase()}:${entry.table?.toLowerCase() ?? ''}`, entry])
        ))).values()].sort((left, right) => (
            left.field.localeCompare(right.field) || String(left.table).localeCompare(String(right.table))
        )),
        select_all: parts.some((part) => part.select_all),
        read_projection_dynamic: parts.some((part) => part.read_projection_dynamic),
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
            written_columns: [],
            read_tables: [],
            selected_columns: [],
            selected_column_sources: [],
            select_all: false,
            read_projection_dynamic: true,
            reasons: ['sql_not_statically_available'],
            sql_sha256: null,
        }
    }

    const tokens = tokenizeSql(sql)
    const dialectReasons = [...new Set(tokens
        .map((token) => token.dialect_ambiguity_reason)
        .filter(Boolean))].sort()
    const statementSpans = []
    let statementDepth = 0
    let statementStart = null
    let statementEnd = null
    let topLevelSelectSeen = false
    let previousToken = null
    for (const token of tokens) {
        const repeatedTopLevelSelect = (
            statementDepth === 0
            && token.kind === 'word'
            && token.value.toUpperCase() === 'SELECT'
            && topLevelSelectSeen
            && !new Set(['EXCEPT', 'INTERSECT', 'UNION']).has(upper(previousToken))
            && /\r?\n/u.test(sql.slice(previousToken?.end ?? token.start, token.start))
        )
        if (repeatedTopLevelSelect && statementStart !== null && statementEnd !== null) {
            // A line comment can hide the preceding semicolon. A fresh
            // top-level SELECT on a later line is still an independently
            // relevant read surface for script inventory; do not let the
            // earlier projection absorb its fields or source position.
            statementSpans.push({ start: statementStart, end: statementEnd })
            statementStart = null
            statementEnd = null
            topLevelSelectSeen = false
        }
        if (statementStart === null && token.value !== ';' && token.kind !== 'ambiguity') statementStart = token.start
        if (statementDepth === 0 && token.kind === 'word' && token.value.toUpperCase() === 'SELECT') {
            topLevelSelectSeen = true
        }
        if (token.value === '(') statementDepth += 1
        if (token.value === ')') statementDepth = Math.max(0, statementDepth - 1)
        if (token.value === ';' && statementDepth === 0) {
            if (statementStart !== null && statementEnd !== null) {
                statementSpans.push({ start: statementStart, end: statementEnd })
            }
            statementStart = null
            statementEnd = null
            topLevelSelectSeen = false
        } else if (statementStart !== null && token.kind !== 'ambiguity') statementEnd = token.end
        previousToken = token
    }
    if (statementStart !== null && statementEnd !== null) {
        statementSpans.push({ start: statementStart, end: statementEnd })
    }
    if (statementSpans.length > 1) {
        const parts = statementSpans.map((span) => ({
            span,
            analysis: analyzeSqlMutation(sql.slice(span.start, span.end), options),
        }))
        const sourceMap = new Map()
        for (const { analysis } of parts) {
            for (const entry of analysis.selected_column_sources ?? []) {
                sourceMap.set(`${entry.field.toLowerCase()}:${entry.table?.toLowerCase() ?? ''}`, entry)
            }
        }
        const anyMutation = parts.some(({ analysis }) => analysis.is_mutation === true)
        const anyIndeterminate = dialectReasons.length > 0 || parts.some(({ analysis }) => analysis.is_mutation === null)
        return {
            is_mutation: anyMutation ? true : anyIndeterminate ? null : false,
            ambiguous: dialectReasons.length > 0 || parts.some(({ analysis }) => analysis.ambiguous),
            dynamic: dialectReasons.length > 0 || parts.some(({ analysis }) => analysis.dynamic),
            operations: parts.flatMap(({ span, analysis }) => analysis.operations.map((operation) => ({
                ...operation,
                index: span.start + operation.index,
            }))).sort((left, right) => left.index - right.index),
            tables: [...new Set(parts.flatMap(({ analysis }) => analysis.tables))].sort(),
            written_columns: [...new Set(parts.flatMap(({ analysis }) => analysis.written_columns ?? []))].sort(),
            read_tables: [...new Set(parts.flatMap(({ analysis }) => analysis.read_tables ?? []))].sort(),
            selected_columns: [...new Set(parts.flatMap(({ analysis }) => analysis.selected_columns ?? []))].sort(),
            selected_column_sources: [...sourceMap.values()].sort((left, right) => (
                left.field.localeCompare(right.field) || String(left.table).localeCompare(String(right.table))
            )),
            select_all: parts.some(({ analysis }) => analysis.select_all),
            read_projection_dynamic: parts.some(({ analysis }) => analysis.read_projection_dynamic),
            reasons: [...new Set([
                ...dialectReasons,
                ...parts.flatMap(({ analysis }) => analysis.reasons ?? []),
            ])].sort(),
            sql_sha256: sha256(sql),
        }
    }
    const operations = []
    const writtenColumns = new Set()
    const reasons = new Set()
    const explicitReadTables = new Set()
    const explicitReadAliases = new Map()
    const explicitSelectedColumns = new Set()
    const explicitSelectedColumnSources = new Map()
    let explicitSelectAll = false
    let explicitReadDynamic = false
    let indeterminateMutation = false
    let dynamic = Boolean(options.forceDynamic) || tokens.some((token) => token.kind === 'dynamic')
    if (options.forceDynamic) reasons.add('dynamic_sql_fragment')
    if (tokens.some((token) => token.kind === 'dynamic')) reasons.add('dynamic_sql_marker')
    if (dialectReasons.length > 0) {
        dynamic = true
        indeterminateMutation = true
        for (const reason of dialectReasons) reasons.add(reason)
    }
    if (tokens.some((token) => token.kind === 'invalid')) {
        dynamic = true
        indeterminateMutation = true
        reasons.add('invalid_sql_token')
    }

    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
        const token = tokens[cursor]
        const keyword = upper(token)
        const previousKeyword = upper(tokens[cursor - 1])

        if (keyword === 'USING') {
            let statementStart = cursor - 1
            while (statementStart >= 0 && tokens[statementStart]?.value !== ';') statementStart -= 1
            const statementKeywords = new Set(tokens.slice(statementStart + 1, cursor).map(upper).filter(Boolean))
            if (statementKeywords.has('DELETE') || statementKeywords.has('MERGE')) {
                let relationCursor = cursor + 1
                do {
                    relationCursor = skipWords(tokens, relationCursor, new Set(['LATERAL', 'ONLY']))
                    if (tokens[relationCursor]?.value === '(') {
                        explicitReadDynamic = true
                        break
                    }
                    const target = identifierAt(tokens, relationCursor)
                    let aliasCursor = target.next
                    if (upper(tokens[aliasCursor]) === 'AS') aliasCursor += 1
                    const alias = tokens[aliasCursor]
                    const aliasName = (
                        alias
                        && (alias.kind === 'word' || alias.kind === 'identifier')
                        && !new Set(['ON', 'RETURNING', 'SET', 'WHEN', 'WHERE']).has(upper(alias))
                    ) ? alias.value : null
                    if (target.dynamic || !target.table) explicitReadDynamic = true
                    else {
                        explicitReadTables.add(target.table)
                        explicitReadAliases.set(target.table.toLowerCase(), target.table)
                        explicitReadAliases.set((target.table.split('.').at(-1) ?? target.table).toLowerCase(), target.table)
                        if (aliasName) explicitReadAliases.set(aliasName.toLowerCase(), target.table)
                    }
                    relationCursor = aliasName ? aliasCursor + 1 : target.next
                    if (tokens[relationCursor]?.value !== ',') break
                    relationCursor += 1
                } while (relationCursor < tokens.length)
            }
        }

        if (keyword === 'RETURNING') {
            const priorOperation = [...operations].reverse().find((operation) => operation.index < token.start && operation.table)
            if (priorOperation?.table) explicitReadTables.add(priorOperation.table)
            for (let fieldCursor = cursor + 1; fieldCursor < tokens.length && tokens[fieldCursor]?.value !== ';'; fieldCursor += 1) {
                const field = tokens[fieldCursor]
                if (field.value === '*') {
                    explicitSelectAll = true
                    continue
                }
                if (field.kind !== 'word' && field.kind !== 'identifier') continue
                if (new Set(['AS', 'NULL']).has(upper(field))) continue
                if (tokens[fieldCursor + 1]?.value === '.' && tokens[fieldCursor + 2]) {
                    const selected = tokens[fieldCursor + 2]
                    if (selected.value === '*') explicitSelectAll = true
                    else if (selected.kind === 'word' || selected.kind === 'identifier') {
                        explicitSelectedColumns.add(selected.value)
                        const table = explicitReadAliases.get(field.value.toLowerCase()) ?? null
                        explicitSelectedColumnSources.set(
                            `${selected.value.toLowerCase()}:${table?.toLowerCase() ?? ''}`,
                            { field: selected.value, table },
                        )
                    }
                    fieldCursor += 2
                } else if (tokens[fieldCursor + 1]?.value === '(') explicitReadDynamic = true
                else {
                    explicitSelectedColumns.add(field.value)
                    explicitSelectedColumnSources.set(
                        `${field.value.toLowerCase()}:${priorOperation?.table?.toLowerCase() ?? ''}`,
                        { field: field.value, table: priorOperation?.table ?? null },
                    )
                }
            }
        }

        if (keyword === 'INSERT') {
            let targetCursor = cursor + 1
            targetCursor = skipWords(tokens, targetCursor, new Set(['OR', 'REPLACE', 'IGNORE']))
            if (upper(tokens[targetCursor]) !== 'INTO') continue
            targetCursor += 1
            if (upper(tokens[targetCursor]) === 'ONLY') targetCursor += 1
            const target = identifierAt(tokens, targetCursor)
            operations.push(mutationRecord('INSERT', target, token))
            let columnCursor = target.next
            if (tokens[columnCursor]?.value === '(') {
                columnCursor += 1
                while (columnCursor < tokens.length && tokens[columnCursor]?.value !== ')') {
                    const column = tokens[columnCursor]
                    if (column.kind === 'word' || column.kind === 'identifier') writtenColumns.add(column.value)
                    columnCursor += 1
                }
            }
            continue
        }

        if (keyword === 'UPDATE') {
            if (previousKeyword === 'FOR' || previousKeyword === 'ON' || previousKeyword === 'DO' || previousKeyword === 'KEY') continue
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
            let setCursor = target.next
            while (setCursor < tokens.length && upper(tokens[setCursor]) !== 'SET' && tokens[setCursor]?.value !== ';') setCursor += 1
            if (upper(tokens[setCursor]) === 'SET') {
                for (let fieldCursor = setCursor + 1; fieldCursor < tokens.length; fieldCursor += 1) {
                    if (new Set(['FROM', 'RETURNING', 'WHERE']).has(upper(tokens[fieldCursor])) || tokens[fieldCursor]?.value === ';') break
                    const field = tokens[fieldCursor]
                    if (
                        (field.kind === 'word' || field.kind === 'identifier')
                        && tokens[fieldCursor + 1]?.value === '='
                    ) writtenColumns.add(field.value)
                    if (
                        (field.kind === 'word' || field.kind === 'identifier')
                        && tokens[fieldCursor + 1]?.value === '.'
                        && (tokens[fieldCursor + 2]?.kind === 'word' || tokens[fieldCursor + 2]?.kind === 'identifier')
                        && tokens[fieldCursor + 3]?.value === '='
                    ) writtenColumns.add(tokens[fieldCursor + 2].value)
                }
            }
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
                const deletionAliases = []
                let aliasCursor = skipWords(tokens, cursor + 1, new Set(['LOW_PRIORITY', 'QUICK', 'IGNORE']))
                while (aliasCursor < fromCursor) {
                    const alias = identifierAt(tokens, aliasCursor)
                    if (!alias.dynamic && alias.table) deletionAliases.push(alias.table)
                    aliasCursor = alias.next
                    if (tokens[aliasCursor]?.value !== ',') break
                    aliasCursor += 1
                }
                const relationAliases = new Map()
                for (let relationCursor = fromCursor; relationCursor < tokens.length; relationCursor += 1) {
                    const relationKeyword = upper(tokens[relationCursor])
                    if (relationKeyword !== 'FROM' && relationKeyword !== 'JOIN' && tokens[relationCursor]?.value !== ',') continue
                    const targetCursor = skipWords(tokens, relationCursor + 1, new Set(['LATERAL', 'ONLY']))
                    const relation = identifierAt(tokens, targetCursor)
                    if (relation.dynamic || !relation.table) continue
                    let declaredAliasCursor = relation.next
                    if (upper(tokens[declaredAliasCursor]) === 'AS') declaredAliasCursor += 1
                    const declaredAlias = tokens[declaredAliasCursor]
                    const declaredAliasName = (
                        declaredAlias
                        && (declaredAlias.kind === 'word' || declaredAlias.kind === 'identifier')
                        && !new Set(['CROSS', 'FULL', 'GROUP', 'INNER', 'JOIN', 'LEFT', 'LIMIT', 'ON', 'ORDER', 'OUTER', 'RIGHT', 'WHERE']).has(upper(declaredAlias))
                    ) ? declaredAlias.value : null
                    relationAliases.set(relation.table.toLowerCase(), relation.table)
                    relationAliases.set((relation.table.split('.').at(-1) ?? relation.table).toLowerCase(), relation.table)
                    if (declaredAliasName) relationAliases.set(declaredAliasName.toLowerCase(), relation.table)
                }
                for (const alias of deletionAliases) {
                    const table = relationAliases.get(alias.toLowerCase()) ?? null
                    operations.push(mutationRecord('DELETE_MULTI', {
                        dynamic: !table,
                        table,
                    }, token, { multi_table: deletionAliases.length > 1, deletion_alias: alias }))
                }
                if (deletionAliases.length === 0) {
                    operations.push(mutationRecord('DELETE_MULTI', { dynamic: true, table: null }, token, { multi_table: true }))
                }
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
                let columnCursor = target.next
                if (tokens[columnCursor]?.value === '(') {
                    columnCursor += 1
                    while (columnCursor < tokens.length && tokens[columnCursor]?.value !== ')') {
                        const column = tokens[columnCursor]
                        if (column.kind === 'word' || column.kind === 'identifier') writtenColumns.add(column.value)
                        columnCursor += 1
                    }
                }
            } else if (upper(tokens[directionCursor]) === 'TO') {
                if (target.dynamic || !target.table) explicitReadDynamic = true
                else explicitReadTables.add(target.table)
                let columnCursor = target.next
                if (tokens[columnCursor]?.value === '(') {
                    columnCursor += 1
                    let sawColumn = false
                    while (columnCursor < tokens.length && tokens[columnCursor]?.value !== ')') {
                        const column = tokens[columnCursor]
                        if (column.kind === 'word' || column.kind === 'identifier') {
                            explicitSelectedColumns.add(column.value)
                            explicitSelectedColumnSources.set(
                                `${column.value.toLowerCase()}:${target.table?.toLowerCase() ?? ''}`,
                                { field: column.value, table: target.table ?? null },
                            )
                            sawColumn = true
                        } else if (column.value !== ',') explicitReadDynamic = true
                        columnCursor += 1
                    }
                    if (!sawColumn || tokens[columnCursor]?.value !== ')') explicitReadDynamic = true
                } else explicitSelectAll = true
            }
            continue
        }

        if (keyword === 'TABLE' && (cursor === 0 || tokens[cursor - 1]?.value === ';')) {
            let targetCursor = cursor + 1
            if (upper(tokens[targetCursor]) === 'ONLY') targetCursor += 1
            const target = identifierAt(tokens, targetCursor)
            if (target.dynamic || !target.table) explicitReadDynamic = true
            else explicitReadTables.add(target.table)
            explicitSelectAll = true
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

        if (keyword === 'EXECUTE' && !new Set(['FUNCTION', 'PROCEDURE']).has(upper(tokens[cursor + 1]))) {
            indeterminateMutation = true
            dynamic = true
            explicitReadDynamic = true
            reasons.add('dynamic_execute_effects_unresolved')
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
                    operations.push({
                        ...nestedOperation,
                        container: 'DO',
                        index: bodyToken.body_start + nestedOperation.index,
                    })
                }
                for (const column of nested.written_columns ?? []) writtenColumns.add(column)
                for (const table of nested.read_tables ?? []) explicitReadTables.add(table)
                for (const column of nested.selected_columns ?? []) explicitSelectedColumns.add(column)
                for (const source of nested.selected_column_sources ?? []) {
                    explicitSelectedColumnSources.set(
                        `${source.field.toLowerCase()}:${source.table?.toLowerCase() ?? ''}`,
                        source,
                    )
                }
                explicitSelectAll ||= nested.select_all
                explicitReadDynamic ||= nested.read_projection_dynamic
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
                if (type === 'FUNCTION' || type === 'PROCEDURE') {
                    const bodyToken = tokens.slice(target.next).find((candidate) => candidate.kind === 'dollar_value')
                    if (bodyToken) {
                        const nested = analyzeSqlMutation(bodyToken.body, { forceDynamic: options.forceDynamic })
                        for (const nestedOperation of nested.operations) {
                            operations.push({
                                ...nestedOperation,
                                container: `CREATE_${type}`,
                                index: bodyToken.body_start + nestedOperation.index,
                            })
                        }
                        for (const column of nested.written_columns ?? []) writtenColumns.add(column)
                        for (const table of nested.read_tables) explicitReadTables.add(table)
                        for (const column of nested.selected_columns) explicitSelectedColumns.add(column)
                        for (const source of nested.selected_column_sources ?? []) {
                            explicitSelectedColumnSources.set(
                                `${source.field.toLowerCase()}:${source.table?.toLowerCase() ?? ''}`,
                                source,
                            )
                        }
                        explicitSelectAll ||= nested.select_all
                        explicitReadDynamic ||= nested.read_projection_dynamic
                        for (const reason of nested.reasons) reasons.add(`stored_routine:${reason}`)
                        if (nested.ambiguous || nested.is_mutation === null) {
                            dynamic = true
                            reasons.add('stored_routine_effects_unresolved')
                        }
                    } else {
                        dynamic = true
                        explicitReadDynamic = true
                        reasons.add('stored_routine_body_unresolved')
                    }
                }
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
            let intoCursor = cursor + 1
            while (
                intoCursor < tokens.length
                && !new Set(['FROM', 'INTO', 'UNION']).has(upper(tokens[intoCursor]))
                && tokens[intoCursor]?.value !== ';'
            ) intoCursor += 1
            if (upper(tokens[intoCursor]) === 'INTO') {
                let targetCursor = intoCursor + 1
                if (upper(tokens[targetCursor]) === 'STRICT') targetCursor += 1
                const target = identifierAt(tokens, targetCursor)
                operations.push(mutationRecord('SELECT_INTO', target, token))
            }
            const SAFE_SELECT_FUNCTIONS = new Set([
                'ABS', 'ARRAY_AGG', 'AVG', 'CEIL', 'COALESCE', 'CONCAT', 'COUNT',
                'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'DATE', 'DATE_TRUNC', 'DATETIME',
                'EXISTS', 'EXTRACT', 'FLOOR', 'GREATEST', 'JSON_AGG', 'JSON_BUILD_OBJECT',
                'JSONB_AGG', 'JSONB_BUILD_OBJECT', 'LEAST', 'LENGTH', 'LOWER', 'MAX',
                'MD5', 'MIN', 'NOW', 'NULLIF', 'POSITION', 'REGEXP_REPLACE', 'REPLACE',
                'ROUND', 'SPLIT_PART', 'STRING_AGG', 'STRPOS', 'SUBSTRING', 'SUM',
                'TO_CHAR', 'TO_DATE', 'TO_TIMESTAMP', 'TRIM', 'UPPER',
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

    // Capture assignment columns across UPDATE, INSERT ... SET, UPSERT and
    // MERGE branches. Token-level extraction is intentionally structural and
    // never retains assigned values.
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
        if (upper(tokens[cursor]) !== 'SET') continue
        let fieldCursor = cursor + 1
        while (fieldCursor < tokens.length) {
            if (
                new Set(['FROM', 'RETURNING', 'WHEN', 'WHERE']).has(upper(tokens[fieldCursor]))
                || tokens[fieldCursor]?.value === ';'
            ) break
            if (tokens[fieldCursor]?.value === '(') {
                const tupleFields = []
                let tupleCursor = fieldCursor + 1
                while (tupleCursor < tokens.length && tokens[tupleCursor]?.value !== ')') {
                    const field = tokens[tupleCursor]
                    if (field.kind === 'word' || field.kind === 'identifier') tupleFields.push(field.value)
                    tupleCursor += 1
                }
                let operatorCursor = tupleCursor + 1
                while (operatorCursor < tokens.length && tokens[operatorCursor]?.value !== ',' && tokens[operatorCursor]?.value !== ';') {
                    if (tokens[operatorCursor]?.value === '=') {
                        for (const field of tupleFields) writtenColumns.add(field)
                        break
                    }
                    operatorCursor += 1
                }
                fieldCursor = tupleCursor + 1
                continue
            }
            const field = tokens[fieldCursor]
            if (field.kind === 'word' || field.kind === 'identifier') {
                let name = field.value
                let operatorCursor = fieldCursor + 1
                if (
                    tokens[operatorCursor]?.value === '.'
                    && (tokens[operatorCursor + 1]?.kind === 'word' || tokens[operatorCursor + 1]?.kind === 'identifier')
                ) {
                    name = tokens[operatorCursor + 1].value
                    operatorCursor += 2
                }
                let probe = operatorCursor
                while (probe < tokens.length && probe <= operatorCursor + 3 && tokens[probe]?.value !== ',' && tokens[probe]?.value !== ';') {
                    if (tokens[probe]?.value === '=') {
                        writtenColumns.add(name)
                        break
                    }
                    probe += 1
                }
            }
            fieldCursor += 1
        }
    }

    // MySQL's INSERT ... ON DUPLICATE KEY UPDATE has no SET keyword.  The
    // UPDATE token belongs to the owning INSERT and its assignments still
    // define written credential fields.
    for (let cursor = 0; cursor + 3 < tokens.length; cursor += 1) {
        if (
            upper(tokens[cursor]) !== 'ON'
            || upper(tokens[cursor + 1]) !== 'DUPLICATE'
            || upper(tokens[cursor + 2]) !== 'KEY'
            || upper(tokens[cursor + 3]) !== 'UPDATE'
        ) continue
        for (let fieldCursor = cursor + 4; fieldCursor < tokens.length; fieldCursor += 1) {
            if (tokens[fieldCursor]?.value === ';') break
            const field = tokens[fieldCursor]
            if (
                (field.kind === 'word' || field.kind === 'identifier')
                && tokens[fieldCursor + 1]?.value === '='
            ) writtenColumns.add(field.value)
        }
    }

    // REPLACE and MERGE's INSERT branch use the same explicit column-list
    // shape as INSERT INTO, but do not necessarily pass through that parser.
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
        const keyword = upper(tokens[cursor])
        if (keyword !== 'REPLACE' && keyword !== 'INSERT') continue
        let columnCursor = cursor + 1
        if (upper(tokens[columnCursor]) === 'INTO') columnCursor += 1
        const target = identifierAt(tokens, columnCursor)
        columnCursor = target.next
        if (tokens[columnCursor]?.value !== '(') {
            // MERGE: WHEN NOT MATCHED THEN INSERT (field, ...)
            if (keyword === 'INSERT' && tokens[cursor + 1]?.value === '(') columnCursor = cursor + 1
            else continue
        }
        columnCursor += 1
        while (columnCursor < tokens.length && tokens[columnCursor]?.value !== ')') {
            const column = tokens[columnCursor]
            if (column.kind === 'word' || column.kind === 'identifier') writtenColumns.add(column.value)
            columnCursor += 1
        }
    }

    if (operations.some((operation) => operation.dynamic_target)) {
        dynamic = true
        reasons.add('unresolved_mutation_target')
    }
    for (let cursor = 0; cursor + 2 < tokens.length; cursor += 1) {
        const receiver = tokens[cursor]
        const field = tokens[cursor + 2]
        if (
            (receiver.kind === 'word' || receiver.kind === 'identifier')
            && explicitReadAliases.has(receiver.value.toLowerCase())
            && tokens[cursor + 1]?.value === '.'
            && (field.kind === 'word' || field.kind === 'identifier')
        ) {
            explicitSelectedColumns.add(field.value)
            const table = explicitReadAliases.get(receiver.value.toLowerCase()) ?? null
            explicitSelectedColumnSources.set(
                `${field.value.toLowerCase()}:${table?.toLowerCase() ?? ''}`,
                { field: field.value, table },
            )
        }
    }
    const tables = [...new Set(operations.map((operation) => operation.table).filter(Boolean))].sort()
    const parsedReadSurface = analyzeReadSurface(tokens)
    if (operations.some((operation) => operation.operation === 'SELECT_INTO')) {
        for (const column of parsedReadSurface.selected_columns) writtenColumns.add(column)
    }
    if (
        operations.some((operation) => operation.operation === 'CREATE_TABLE')
        && tokens.some((token) => upper(token) === 'AS')
        && tokens.some((token) => upper(token) === 'SELECT')
    ) {
        for (const column of parsedReadSurface.selected_columns) writtenColumns.add(column)
    }
    const readSurface = {
        read_tables: [...new Set([...parsedReadSurface.read_tables, ...explicitReadTables])].sort(),
        selected_columns: [...new Set([...parsedReadSurface.selected_columns, ...explicitSelectedColumns])].sort(),
        selected_column_sources: [...new Map([
            ...(parsedReadSurface.selected_column_sources ?? []).map((entry) => [`${entry.field.toLowerCase()}:${entry.table?.toLowerCase() ?? ''}`, entry]),
            ...explicitSelectedColumnSources,
        ]).values()].sort((left, right) => (
            left.field.localeCompare(right.field) || String(left.table).localeCompare(String(right.table))
        )),
        select_all: parsedReadSurface.select_all || explicitSelectAll,
        read_projection_dynamic: parsedReadSurface.read_projection_dynamic || explicitReadDynamic,
    }
    return {
        is_mutation: operations.length > 0 ? true : indeterminateMutation ? null : false,
        ambiguous: dynamic || indeterminateMutation || operations.some((operation) => operation.dynamic_target),
        dynamic,
        operations,
        tables,
        written_columns: [...writtenColumns].sort(),
        ...readSurface,
        reasons: [...reasons].sort(),
        sql_sha256: sha256(sql),
    }
}

export function analyzeSqlScript(sql, options = {}) {
    return analyzeSqlMutation(sql, options)
}
