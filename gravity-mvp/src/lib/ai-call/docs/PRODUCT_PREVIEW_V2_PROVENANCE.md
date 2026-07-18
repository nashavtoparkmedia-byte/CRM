# AI Calls Product Preview V2 provenance

- Accepted Messages base: `8a95307d19a22a086794328496630962eae1b113`
- Previous AI Calls RC: `4b66ee206ceac359cdd0d6688801167e72c4b189`
- Product Preview V2 branch: `dev/ai-calls-product-preview-v2`
- Isolated worktree: `D:\opt\codex-work\crm-ai-calls-clean`

The V2 branch was created directly from the previous AI Calls RC. It is not
rebased or merged with any in-progress Messages branch.

## Runtime policy

Product Preview V2 is DEV-only. It must use deterministic local mock data and
must not:

- place a phone call;
- connect to SIP or production FreeSWITCH;
- write to a production database;
- create or mutate a production Contact;
- use production provider credentials;
- change Prisma, Messages, Contact services, shared Calls, package locks,
  deployment, startup, health, Docker, or shared navigation files.

## Guard

Run from the repository root:

```text
node gravity-mvp/scripts/ai-calls-protected-files-guard.js 8a95307d19a22a086794328496630962eae1b113
```

The guard permits only the approved AI Calls source areas and its own script.
