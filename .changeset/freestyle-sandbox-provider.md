---
"@ai-hero/sandcastle": minor
---

Add `freestyle()`, a [Freestyle](https://www.freestyle.sh) isolated sandbox provider, at `@ai-hero/sandcastle/sandboxes/freestyle`. It needs `freestyle` (an optional peer dependency) and an API key in `FREESTYLE_API_KEY` (or the `apiKey` option). Each sandbox is a new Freestyle VM, booted from `freestyle/ubuntu` unless `snapshotId` says otherwise, with outbound Internet access unless `firewall` says otherwise, and the repo at `$HOME/workspace`; `sandboxId` is the VM id. Commands stream over a PTY session, so an agent run has no five-minute cap. VMs persist until deleted, so Sandcastle deletes the VM on `close()`, when setup fails, and from a background process when the run is interrupted or exits without closing it.
