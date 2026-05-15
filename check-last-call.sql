SELECT id, direction, status,
       "fromNumber", "toNumber",
       "startedAt", "answeredAt", "endedAt",
       "durationSec",
       "hangupCause",
       "recordingPath",
       transcript IS NOT NULL AS has_transcript,
       "aiScore"
FROM "Call"
ORDER BY "startedAt" DESC
LIMIT 5;
