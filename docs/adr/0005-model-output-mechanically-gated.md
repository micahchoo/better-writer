# Model output is mechanically gated

The coach panel displays model prose directly, and a small model will sometimes preface or explain a question. So the reshaped output must pass a deterministic gate — one sentence ending in `?`, no list, no trailing text — before it reaches the writer. A failure triggers one corrective retry, then falls back to a topic probe.

Considered Options:
- Stripping leading chatter, rejected: silently rewriting model output is the failure mode the gate exists to prevent. The gate rejects, never fixes.
