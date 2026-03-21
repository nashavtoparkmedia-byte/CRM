const fs = require('fs');
const txt = fs.readFileSync('max_dom_dump.txt', 'utf8');

const m = txt.indexOf('450');
if(m > -1) { 
    console.log('Found 450 at', m); 
    console.log(txt.substring(Math.max(0, m - 800), m + 800)); 
} else { 
    console.log('450 NOT FOUND. File length:', txt.length); 

    const m2 = txt.indexOf('425');
    if(m2 > -1) { 
        console.log('Found 425 at', m2); 
        console.log(txt.substring(Math.max(0, m2 - 800), m2 + 800)); 
    } else {
        const titleMatch = txt.indexOf('Все');
        console.log('Index of "Все":', titleMatch);
    }
}
