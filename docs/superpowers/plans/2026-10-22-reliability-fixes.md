# Reliability fixes

Goal: fix reproduced authorization, protocol input and persisted-state failures without changing normal workflows.

The current mobile feature branch contains the affected code; keep its existing changes intact. Apply the fixes here for review, without merging or releasing.

- [x] Reproduce access by a previously paired owner removed from ALLOWED_USERS; deny authentication, active-device checks, CSRF and pending pairing completion using the current allowlist.
- [x] Reproduce invalid JSON-RPC values reaching consumers and unbounded input framing; validate envelopes and bound each frame while preserving fragmented and batched messages.
- [x] Reproduce invalid persisted roots and malformed mobile device records; reject them before use without overwriting the file. Preserve existing valid data and nullable updater state.
- [x] Include the mobile build in Windows/Linux CI; correct security and release documentation to match the checkout.
- [x] Run the full test suite, both type checks, mobile production build and review the final diff.

Verification: 475 tests passed; backend typecheck and mobile production build
(including its typecheck) passed. Independent review found two additional
validation gaps; both were reproduced and fixed, and follow-up review found no
remaining blocking issues. The mobile build retains its existing bundle-size warning.
