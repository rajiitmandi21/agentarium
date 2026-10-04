# Contributing

Install Node.js 22 or later, run `npm ci`, then `npm run build` and
`npm run preview:release`. The public build uses synthetic examples.

Keep the distinction between working functionality and Upcoming actions visible.
Do not replace simulation labels with live execution claims. Preserve project
data locally and keep private workspace records out of release artifacts.

Before proposing a change, run `npm run test:release` and
`node scripts/test-agentarium-compile.js`, plus focused tests for the behavior
you changed. Include the user-visible outcome and verification in the PR.

The development checkout uses Agentarium project-management records and the
instructions in AGENTS.md. Keep historical task IDs and append-only review
history intact. Submit implementation and independent acceptance separately.
