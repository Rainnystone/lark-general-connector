# 08: Bilingual AGENTS.md for coding agents

**What to build:** An AGENTS.md (中文 + English) that a user's coding agent can follow end to end to set up their own connector. It uses the wizard or the equivalent `wrangler` commands, states each human-only step and waits for the human at that point, and lists the invariants the agent must never break.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] Steps match the shared order in SPEC "Deploy paths" for both regions.
- [ ] Explicit rules: never write secrets into files, commits or chat. Never deploy over an existing Worker name without the human's confirmation. Never widen scopes, tools or the endpoint allowlist.
- [ ] A fresh agent session given only the repo and AGENTS.md reaches the bootstrap page on a test Worker (recorded in the PR).
