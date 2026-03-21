const dates = [
    "2026-03-13T21:25:39.358+00:00", // 14 March 02:25 local
    "2026-03-13T18:00:00.000+00:00", // 13 March 23:00 local
    "2026-03-08T22:00:00.000+00:00", // 09 March 03:00 local
];

function getLocalDateStr(dateString, offsetHours = 5) {
    const d = new Date(dateString);
    d.setUTCHours(d.getUTCHours() + offsetHours);
    return d.toISOString().split('T')[0];
}

dates.forEach(d => {
    console.log(`UTC: ${d} -> Local (+5): ${getLocalDateStr(d)}`);
});
