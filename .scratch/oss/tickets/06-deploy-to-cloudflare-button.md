# 06: Deploy to Cloudflare button

**What to build:** The README has a working "Deploy to Cloudflare" button. Clicking it clones the repo into the deployer's GitHub, provisions KV and the DO, prompts for the four secrets with descriptions, lets the deployer pick the region, and deploys a Worker that reaches the bootstrap page on first login.

**Blocked by:** 03

**Status:** needs-human (one real button run in the user's account)

- [ ] Button markup points at `https://deploy.workers.cloudflare.com/?url=https://github.com/Rainnystone/lark-general-connector`.
- [ ] A real button run with a test Worker name (never the private Worker's name) completes: KV is created with no `id` in the repo, the DO migration applies, the secret prompts show the descriptions, and `/authorize` serves the approval page.
- [ ] If id-less KV fails in the button flow, switch to the placeholder-id form from Cloudflare's docs, re-run the button and record the outcome.
- [ ] The repo the button created in the user's GitHub and the test Worker are removed afterwards only with the user's approval.
