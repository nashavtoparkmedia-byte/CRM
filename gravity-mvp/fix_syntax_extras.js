const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\lib\\tasks\\task-event-service.ts';
let content = fs.readFileSync(path, 'utf-8');

const target = `    });
}
}`;

const replacement = `    });
}`;

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(path, content, 'utf-8');
    console.log('Syntaxes restored correctly!');
} else {
    console.log('Target for syntax restore not found! Trying fallback with \\r\\n');
    const fallbackTarget = `    });\r\n}\r\n}`;
    const fallbackReplacement = `    });\r\n}`;
    if (content.includes(fallbackTarget)) {
        content = content.replace(fallbackTarget, fallbackReplacement);
        fs.writeFileSync(path, content, 'utf-8');
        console.log('Fixed accurately with CRLF!');
    } else {
         console.log('All formats failed!');
    }
}
