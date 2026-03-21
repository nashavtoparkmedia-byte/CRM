const { execSync } = require('child_process');
const fs = require('fs');

let output = '';
try {
    const res = execSync('git status', { encoding: 'utf-8' });
    output += '## GIT STATUS\n' + res;
} catch (e) {
    output += '## GIT STATUS ERROR\n' + e.message;
}

try {
    const remote = execSync('git remote -v', { encoding: 'utf-8' });
    output += '\n\n## REMOTES\n' + remote;
} catch (e) {
    output += '\n\n## REMOTES ERROR\n' + e.message;
}

fs.writeFileSync('diag_output.txt', output);
console.log('Done diagnostics');
