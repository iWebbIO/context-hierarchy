# context-hierarchy

An OpenAI-compatible proxy that enforces a hard per-model-call token cap, so
small-context models can serve any client: every outgoing model call is
token-estimated first, and an over-cap request is repaired before dispatch —
either fitted to the budget by a strategy or decomposed into capped
sub-calls. The upstream never sees an over-cap request.

**Status:** M1 in development — core library + proxy.

- [GLOSSARY.md](GLOSSARY.md) — canonical terms (cap, fleet, strategy, spill, distillate, …)
- [Design spec](docs/superpowers/specs/2026-10-18-context-hierarchy-design.md) — the binding design document

## Quickstart

Lands with M1 — the runnable proxy, its configuration, and usage examples
ship with the first milestone. The repository scaffold (npm workspaces,
TypeScript, vitest) is in place; see [CHANGELOG.md](CHANGELOG.md) for
progress.

## License

MIT — see [LICENSE](LICENSE).
