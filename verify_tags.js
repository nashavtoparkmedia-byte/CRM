const fs = require('fs');
const path = 'c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\src\\app\\messages\\components\\MessageInputArea.tsx';

const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

let divOpen = 0;
let divClose = 0;
let braceOpen = 0;
let braceClose = 0;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matchOpen = line.match(/<div/g);
    const matchClose = line.match(/<\/div>/g);
    const braceO = line.match(/{/g);
    const braceC = line.match(/}/g);
    
    if (matchOpen) divOpen += matchOpen.length;
    if (matchClose) divClose += matchClose.length;
    if (braceO) braceOpen += braceO.length;
    if (braceC) braceClose += braceC.length;
    
    // Log balance of divs if it changes
    // if (matchOpen || matchClose) {
    //     console.log(`Line ${i+1}: Divs Open=${divOpen}, Close=${divClose}`);
    // }
}

console.log(`Total Divs: Open=${divOpen}, Close=${divClose}`);
console.log(`Total Braces: Open=${braceOpen}, Close=${braceClose}`);

// Optional: check exact line offsets for returns
if (divOpen !== divClose) {
    console.log("DIV MISMATCH");
}
if (braceOpen !== braceClose) {
    console.log("BRACE MISMATCH");
}
