# MAX Message Text Forensic

Status: DEV-only trace and repair-analysis tooling. Production history has not
been read or changed by this work.

## Evidence boundary

The trace harness replays saved, sanitized MAX payloads through the real
`TransportInterceptor._normalizeMaxMsg`, `MessageParser.toCrmPayload`, canonical
MAX webhook persistence mapping, Messages API serialization, and the same pure
body helper used by `MessageFeed`.

This proves the current code contract for recorded fixture shapes. It is not a
real-provider acceptance test and does not prove that every MAX protocol frame
has the same shape.

## Root-cause matrix

| Symptom | Current evidence | Conclusion |
| --- | --- | --- |
| Replacement character `U+FFFD` | The custom msgpack decoder previously used non-fatal UTF-8 conversion. An invalid UTF-8 fixture enters as `U+FFFD` at that exact boundary. New diagnostics record byte offset, length, and SHA-256 without logging message text. | Decoder entry boundary is proven. The reason a historical real provider frame contained invalid/misaligned bytes is not proven without that original frame. No automatic repair is safe. |
| Raw `attachments` in body | Current transport, parser, webhook, DB, API, and UI fixture replay keep attachments structured. | No current insertion path was found. Historical source remains unproven. |
| Raw `prevM` in body | Reply fixtures keep `prevM` out of text and persist only `replyToExternalId`. | No current insertion path was found. Historical source remains unproven. |
| Forward metadata in body | The scraper prepended `[↩ id:name]` even while sending `forwardedFrom`. | Confirmed current code cause. New messages now keep `forwardedFrom` structured and leave text unchanged. Legacy UI fallback remains for old rows. |
| One CRM send shown as several recipient bubbles | CRM and scraper construct one text field and one opcode-64 message; no line/length split exists in the reviewed path. | No local split is present. Recipient/provider behavior needs a real provider trace with the same client/provider message identity. |

## New-message contract

- `content` contains only provider/operator text.
- Attachments are structured and stored as `MessageAttachment` rows.
- Replies use `replyToExternalId`.
- Forwarding uses `metadata.forwardedFrom`.
- Arbitrary payload objects are never stringified into `content`.
- Invalid UTF-8 produces a sanitized technical diagnostic. The trace does not
  claim to reconstruct missing bytes.
- Repeated equal text remains distinct when provider message IDs differ.
- Outbound multiline text remains one provider message object.

## Historical read-only dry-run

Run only against an isolated DB copy or a separately authorized read-only
connection:

```bash
MAX_FORENSIC_READ_ONLY=1 \
DATABASE_URL='postgresql://...' \
node --experimental-strip-types scripts/max-message-text-dry-run.ts \
  --output=/tmp/max-message-text-dry-run.json
```

The runner performs `Message.findMany` only. It reports:

- classification per suspicious row;
- recoverable vs manual-review-only;
- proposed replacement when deterministic;
- confidence;
- aggregate counts.

The only deterministic repair currently proposed is removing an exact legacy
`[↩ id:name]` prefix when matching structured `forwardedFrom` metadata is
already present. Replacement characters, raw attachment fragments, and raw
`prevM` fragments remain unrecoverable without source evidence. The runner
never writes a database row.

## Test status terminology

- `CODE PASS`: source and type contracts.
- `MOCK/FIXTURE PASS`: sanitized replay and isolated runtime mocks.
- `REAL PROVIDER NOT TESTED`: no live MAX message was sent or received by this
  DEV work.

Do not promote fixture evidence to production/provider acceptance.
