# @arc-control/store

Storage contracts, with an in-memory and a durable file-backed implementation.

## Why this package exists

The gateway should not know how anything is persisted. `ControlStore` is the
interface it depends on, so replacing the storage layer — a clustered Postgres
store is v0.5 work — does not reach the decision path.

## Implementations

**`MemoryStore`** — tests, evals and examples.

**`FileStore`** — newline-delimited JSON in one directory. Mutable
collections are snapshot files rewritten atomically through a temporary file
and a rename; the audit log is a true append-only file, so a record that has
been written is never rewritten. This is the single-node target: enough for a
pilot, an air-gapped install or a laptop, and small enough to read with
`cat`.

## The decisions worth knowing

**Every collection has `transact`.** It serializes a read-modify-write
sequence through a FIFO mutex. Without it, two concurrent approval releases
could both observe an unconsumed grant and both execute — which is exactly the
replay the approvals engine exists to prevent. The eval suite asserts this with
three simultaneous resumes.

**`FileStore` keeps the audit head in `audit.head.json`.** Walking a hash
chain cannot detect truncation: remove records from the end and what remains is
a shorter chain in which every digest and link is still correct. Keeping the
head separately means truncating the log alone is caught. It is defence in
depth rather than a guarantee — whoever can rewrite the log can usually rewrite
the marker — but it reliably catches the accidental case: a crash mid-write, a
partial restore, a rotation that dropped the tail.

**`verifyChain` is a pure function.** It is exported so an auditor can run it
over an export without trusting the system that produced it.

## Usage

```ts
import { FileStore, MemoryStore, verifyChain } from '@arc-control/store';

const store = await FileStore.open('./arc-data');

// Checked against the recorded head, so truncation is detected.
const verification = await store.audit.verify(await store.recordedAuditHead());

await store.close();
```
