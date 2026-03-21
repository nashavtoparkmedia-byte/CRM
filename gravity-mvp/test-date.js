const tzFormatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Yekaterinburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});

const dUTC = new Date("2026-02-13T20:00:00Z"); // Late evening UTC, already Feb 14 in Yekaterinburg (+5)
console.log("UTC date:", dUTC.toISOString());

const formatted = tzFormatter.format(dUTC);
console.log("tzFormatter format:", formatted);

const dateObj = new Date(formatted);
console.log("new Date('YYYY-MM-DD'):", dateObj.toISOString());

dateObj.setHours(0, 0, 0, 0);
console.log("dateObj.setHours(0):", dateObj.toISOString());
