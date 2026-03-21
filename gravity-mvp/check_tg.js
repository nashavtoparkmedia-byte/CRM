const fs = require('fs')
const { execSync } = require('child_process')
const OUT = 'c:/Users/mixx/Documents/Github/CRM/gravity-mvp/_out.txt'

let result = ''

try {
    // Check git log for gravity-mvp
    try {
        const gitLog = execSync('git log --oneline -15', { cwd: 'c:/Users/mixx/Documents/Github/CRM/gravity-mvp', encoding: 'utf8' })
        result += '=== GRAVITY-MVP GIT LOG ===\n' + gitLog + '\n'
    } catch(e) { result += 'GRAVITY-MVP GIT: ' + e.message.substring(0, 200) + '\n' }

    // Check git log for max-web-scraper  
    try {
        const gitLog2 = execSync('git log --oneline -15', { cwd: 'c:/Users/mixx/Documents/Github/CRM/max-web-scraper', encoding: 'utf8' })
        result += '=== MAX-SCRAPER GIT LOG ===\n' + gitLog2 + '\n'
    } catch(e) { result += 'MAX-SCRAPER GIT: ' + e.message.substring(0, 200) + '\n' }

    // Check git branches/tags/stash
    try {
        const branches = execSync('git branch -a', { cwd: 'c:/Users/mixx/Documents/Github/CRM/gravity-mvp', encoding: 'utf8' })
        result += '=== BRANCHES ===\n' + branches + '\n'
    } catch(e) { result += 'BRANCHES: ' + e.message.substring(0, 200) + '\n' }

    try {
        const tags = execSync('git tag -l', { cwd: 'c:/Users/mixx/Documents/Github/CRM/gravity-mvp', encoding: 'utf8' })
        result += '=== TAGS ===\n' + (tags || '(none)') + '\n'
    } catch(e) { result += 'TAGS: ' + e.message.substring(0, 200) + '\n' }

    try {
        const stash = execSync('git stash list', { cwd: 'c:/Users/mixx/Documents/Github/CRM/gravity-mvp', encoding: 'utf8' })
        result += '=== STASH ===\n' + (stash || '(none)') + '\n'
    } catch(e) { result += 'STASH: ' + e.message.substring(0, 200) + '\n' }

    // MAX debug log (last 30 lines)
    try {
        const maxLog = fs.readFileSync('c:/Users/mixx/Documents/Github/CRM/max-web-scraper/debug.log', 'utf8')
        const lines = maxLog.split('\n')
        result += '=== MAX DEBUG.LOG (last 30 lines) ===\n' + lines.slice(-31).join('\n') + '\n'
    } catch(e) { result += 'MAX LOG: ' + e.message + '\n' }

    // Check saved snapshots / backups
    try {
        const snapshots = execSync('dir /b /s c:\\Users\\mixx\\Documents\\Github\\CRM\\*.backup* c:\\Users\\mixx\\Documents\\Github\\CRM\\*.snapshot* 2>nul', { encoding: 'utf8' })
        result += '=== SNAPSHOTS ===\n' + (snapshots || '(none)') + '\n'
    } catch(e) { result += 'SNAPSHOTS: none found\n' }

    // Check .agents/knowledge for any reference to working state
    try {
        const knowledgeFiles = fs.readdirSync('c:/Users/mixx/Documents/Github/CRM/.agents/knowledge')
        result += '=== KNOWLEDGE FILES ===\n' + knowledgeFiles.join('\n') + '\n'
    } catch(e) { result += 'KNOWLEDGE: ' + e.message + '\n' }

} catch(e) {
    result += 'FATAL: ' + e.message + '\n'
}

fs.writeFileSync(OUT, result)
