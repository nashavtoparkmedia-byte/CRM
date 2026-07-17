# MAX Message Text Forensic

Status: DEV-only forensic contract. No production history has been changed.

## Confirmed CRM boundary

- The outbound CRM path passes one `message` value to the MAX scraper endpoint. There is no CRM-side splitting by lines, paragraphs, text length, or repeated content.
- The inbound MAX webhook stores provider `text` as the Message body. Attachments, reply references, forwarding data, sender identifiers, and source metadata are stored separately in structured metadata and Attachment rows.
- The Messages feed renders `message.content` as the body and renders media from structured attachments.

Therefore, a recipient receiving one CRM submission as several MAX bubbles is not caused by a text-splitting operation in the reviewed CRM code. The remaining suspect boundary is the scraper/provider path. This document does not treat that as proven without a scraper trace containing the same client message ID.

## Legacy text review

Historical MAX messages may contain encoding replacement characters or protocol fragments such as attachment or reply metadata. `max-message-text-forensics.ts` classifies those texts without changing them.

The dry-run report:

- has no Prisma dependency;
- takes an isolated export only;
- never produces replacement text;
- marks every suspicious row for manual review;
- must be run against an isolated DB copy before any future repair proposal.

No repair is automatic. A fragment can resemble a legitimate operator message, so deletion, truncation, or reassembly without original provider evidence would risk message loss.

## Delivery evidence

CRM treats MAX send acknowledgement as `send_requested` until a real provider message ID and delivery confirmation are available. A timeout is not converted to `delivered`; repeated equal text is not deduplicated by content.

## Operator guidance

When a MAX message looks damaged, preserve the CRM row and record the chat, CRM message ID, provider message ID, and approximate time. Do not retry solely to repair the display: retry may create a second real provider message. Escalate with the sanitizer-free technical trace; the right panel must not expose raw provider payloads to an operator.
