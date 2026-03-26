const fs = require('fs');
const path = require('path');

const filePath = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\tasks\\components\\TaskDetailsPane.tsx';
let content = fs.readFileSync(filePath, 'utf-8');

const target = `                </div>
                        <ArrowUpRight className="w-3.5 h-3.5" />
                    </Link>
                </div>`;

const replacement = `                </div>`;

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log('Fixed tags successfully!');
} else {
    console.log('Target not found in file directly. Let me try matching simpler pattern.');
    const lines = content.split('\n');
    const fixedLines = [];
    let skipCount = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('Однострочный Контакт')) {
            fixedLines.push(line);
            // push until next </div>
            let j = i + 1;
            while (j < lines.length && !lines[j].includes('</div>')) {
                fixedLines.push(lines[j]);
                j++;
            }
            if (j < lines.length) {
                fixedLines.push(lines[j]); // push the </div>
                j++;
                // Skip the next 3 garbage lines
                if (lines[j] && lines[j].includes('<ArrowUpRight')) {
                    console.log('Skipping garbage lines starting at ' + j);
                    j += 3;
                }
                i = j - 1;
            }
        } else {
            fixedLines.push(line);
        }
    }
    
    fs.writeFileSync(filePath, fixedLines.join('\n'), 'utf-8');
    console.log('Fallback fixing executed!');
}
