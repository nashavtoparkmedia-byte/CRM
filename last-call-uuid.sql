SELECT id, status, "durationSec", "hangupCause", "fsUuid", "recordingPath",
       "startedAt", "answeredAt", "endedAt"
FROM "Call" ORDER BY "startedAt" DESC LIMIT 2;
