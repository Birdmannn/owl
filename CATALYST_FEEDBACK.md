# Draft Catalyst issue

**Suggested title:** Pilot: scoped session signing for CKB apps — looking for developer and UX feedback

**Before posting:** replace `[DEMO_URL]` with the hosted demo URL. This is a draft, not a published issue.

---

I'm building **Pilot**, an SDK from Owl that lets users approve specific actions once and lets a session key sign those actions afterward. The goal is to reduce repeated wallet prompts while keeping permissions explicit and verifiable.

Pilot wraps an existing wallet through CCC. It does not import the user's owner private key or ask for blanket spending authority.

There are two current flows:

- **On-chain actions:** the owner funds or delegates a compatible app cell, selecting allowed actions. A CKB lock checks session signatures, permitted state changes, fees, and protected capacity. The UI updates optimistically while transactions settle in the background. Recovery returns the cell's remaining capacity to the owner.
- **Off-chain actions:** the owner signs a scoped message delegation for an app/origin, session key, selected actions, and expiry. Pilot can then sign likes, follows, and posts without another owner prompt. The receiving app checks both signatures, permissions, nonces, expiry, and revocation before updating state. These messages do not need CKB transactions or per-action chain fees.

**Demo:** [DEMO_URL]

**Repository:** https://github.com/Birdmannn/owl

In the demo's **Pilot Social** panel, select actions, sign the one-hour approval, and interact. Inspect the signed messages and verification logs, then revoke the session with the owner wallet. The panel labels whether it is using browser-local state or a shared verifier. Browser-local mode demonstrates real signing and verification but is not a shared social network.

What exists today:

- SDK helpers, React permission UI, action builders, persistent retries, and detailed diagnostics.
- A public-testnet counter demo and a separate locally verified reusable cell-delegation contract.
- Off-chain delegation, session signing, server verification, replay protection, and owner-signed revocation, with an optional persistent social demo backend.
- Automated signature, contract, SDK, and browser checks. Browser automation uses an injected test wallet; manual extension/JoyID UI testing remains outstanding.

This is an early prototype. The reusable on-chain policy currently supports fixed `u64` field transitions, not arbitrary app execution, and its public-testnet deployment is not configured. Session keys currently live in browser localStorage. The off-chain feature is separate from those on-chain limits and relies on the receiving app's verifier and storage; it does not turn off-chain state into decentralized storage.

I'd appreciate feedback on:

1. Which CKB app interactions would benefit most from scoped automatic signing?
2. Are the permission selection, duration, and revocation flows understandable?
3. What contract patterns should a broader on-chain policy support first?
4. For social apps, what existing signed-message formats or verification flows should Pilot integrate with?
5. What would you want reviewed or changed before integrating this into your app?

Implementation notes are in `CELL_DELEGATION.md` and `OFFCHAIN_SIGNING.md`; the website docs include integration examples and current limits. Happy to discuss the architecture and collaborate with app developers testing the flow.
