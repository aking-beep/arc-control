# Security addendum — draft

> **Draft. Not legal advice. Must be reviewed by counsel before use.**

`docs/COMMERCIAL_READINESS.md` §7 calls this "the wrapper" and says the
questionnaire is the substance. That is right, so this document is short and
points at the substance rather than restating it.

## 1 · The substance

`docs/SECURITY_QUESTIONNAIRE.md` is the technical answer set, written to be
handed over as-is, answered against what the code does with limitations stated
rather than softened. It is incorporated into this addendum by reference and is
versioned with the product.

Supporting material, all public:

| | |
| --- | --- |
| Threat model | `docs/THREAT_MODEL.md` |
| Trust model, including what ARC does *not* protect against | `docs/TRUST_MODEL.md` |
| Evidence model | `docs/EVIDENCE_MODEL.md` |
| Known limits | `SECURITY.md` |
| Findings register | `docs/security/findings.json` |
| Independent adversarial suite | [arc-control-sandbox](https://github.com/aking-beep/arc-control-sandbox) |

## 2 · Vulnerability handling

As published in `SECURITY.md`: reports to security@arctransformationgroup.com,
acknowledgement within 2 business days, assessment within 10, and if a fix will
take longer than that we say so and why rather than going quiet.

Every fixed finding names the regression test that fails when the fix is
reverted. That is checked in CI (`tools/harness/findings.mjs`), not asserted
here.

[Counsel: customer-specific notification commitments — whether we must tell a
customer about a vulnerability before it is fixed, and in what window — are not
yet decided and are the main thing to negotiate in this section.]

## 3 · What we do not claim

Repeated here because it is the clause most likely to be quietly dropped in
redlining, and it must not be:

- **No certification.** We hold no SOC 2 and no ISO 27001. ARC Control is
  software you deploy, not a service we operate, so such certifications would
  describe our corporate posture rather than your deployment. If that changes,
  this addendum changes with it.
- **No compliance outcome.** ARC produces evidence; your assessor reaches the
  conclusion.
- **No independent penetration test of the operator authentication path, yet.**
  See `docs/commercial/PENTEST_BRIEF.md`. Until that is complete and its
  findings are closed, **we do not represent that approvals are
  cryptographically attributable to individuals**, and that sentence must not
  appear in any agreement, proposal or marketing material. This is the one
  claim a buyer purchasing ARC for its audit trail is most likely to rely on,
  and it is the one we have decided not to make yet
  (`docs/COMMERCIAL_READINESS.md` §4).
- **Nothing distributed.** Every guarantee is per-process. Passing local tests
  and the Meridian suite is not a production sign-off.

## 4 · Changes

This addendum tracks the product. A material change to any limitation above is
notified to you at [renewal / within [30] days / with the release note].
