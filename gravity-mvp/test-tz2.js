const tz = process.env.TZ || 'Asia/Yekaterinburg'; // UTC+5

const dates = [
    "2026-03-13T21:25:39.358+00:00", 
    "2026-03-13T18:00:00.000+00:00", 
    "2026-03-08T22:00:00.000+00:00", 
];

const formatter = new Intl.DateTimeFormat('sv-SE', { 
    timeZone: tz, 
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit' 
});

dates.forEach(d => {
    // format directly to YYYY-MM-DD
    const localStr = formatter.format(new Date(d));
    console.log(`UTC: ${d} -> Local (${tz}): ${localStr}`);
});
