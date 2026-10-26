# Third-Party Notices

## find-skills

- Source: https://github.com/vercel-labs/skills
- Upstream revision: `a80e4c9d12d607631249d4d7d059f835d4b2f13a`
- Installed source record: `skills/find-skills/SKILL.md`
- Original installer content hash: `3013fdeb8a11b10b1eb795ec3ae8bfca38f7c26d`
- License: MIT
- Copyright: 2026 Vercel, Inc.
- Local changes: commands use `pnpm` with the reviewed CLI release `skills@1.7.4` (Node.js >=22.20.0), retain source review and explicit installation approval, and preserve harness-managed links instead of running unattended bulk updates.

The MIT license text is preserved in `LICENSES/vercel-labs-skills-MIT.txt`.

## consulting-pptx-skill

- Source: https://github.com/carnot-tech/jinba-consulting-pptx-skill (renamed from `carnot-tech/consulting-pptx-skill`)
- Upstream revision: `e5f35e57e14d3998249a559c620a9286c95b4595`
- Installed source record: `skills/consulting-pptx-skill/`
- License: MIT
- Copyright: 2026 Carnot AI Inc.
- Local changes: vendored update guidance follows harness provenance; image cleanup matches literal deck names; browser automation connects only to its newly launched browser, with regression tests for both fixes. Trailing whitespace in upstream rules and a new test fixture is normalized. Upstream GitHub automation metadata is not distributed.

The MIT license text is preserved in `skills/consulting-pptx-skill/LICENSE` and `LICENSES/carnot-tech-consulting-pptx-skill-MIT.txt`.

## i-have-adhd

- Source: https://github.com/ayghri/i-have-adhd
- Upstream revision: `1ecea1993b7fce257ffbd686c070948b5e07eda6`
- Installed source record: `skills/i-have-adhd/SKILL.md`
- License: MIT
- Copyright: 2026 Ayoub Ghriss
- Local changes: the canonical skill omits `disable-model-invocation: true` because the harness uses separate explicit variants for Claude Code and Pi, and Codex policy metadata for explicit invocation.

The MIT license text is preserved in `LICENSES/ayghri-i-have-adhd-MIT.txt`.

## security-review and tdd-workflow

- Source: https://github.com/affaan-m/ECC
- Upstream revision: `25278e7d7b6cf6e6a4e7a6c8e10f14ff22f0eb5b`
- Installed source records: `skills/security-review/SKILL.md` and `skills/tdd-workflow/SKILL.md`
- Provenance: the original local bodies match upstream initial release `45959c326ee2fb91a72b906c7cf32e204baf4c5e`, except for intentional package-manager adaptations. This establishes a source match; the original installation revision was not recorded.
- License: MIT
- Copyright: 2026 Affaan Mustafa
- Local changes: project package-manager and runner detection works without ECC's unbundled helper or `bun-runtime` companion, and selects Bun's native runner only from project evidence. Validation evidence supports evaluated compile failures and detached checkouts without automatic staging or commits. Plan handoff respects existing task authorization instead of requiring approval for every routine command or accepting override phrases. Existing harness Git authorization and repository-only distribution are preserved.

The MIT license text is preserved in `LICENSES/affaan-m-ECC-MIT.txt`.

## security-audit

- Source: https://github.com/cloudflare/security-audit-skill
- Upstream revision: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`
- Installed source record: `skills/security-audit/`
- License: MIT
- Copyright: 2025-2026 Cloudflare, Inc.
- Local changes: none; registered in the harness bootstrap allowlist.

The MIT license text is preserved in `LICENSES/cloudflare-security-audit-skill-MIT.txt`.

## yomiyasu

- Source: https://github.com/nanaism/yomiyasu
- Upstream release: `v2.4.0`
- Upstream revision: `ae258d7a57b335673e30b88a018ae08d4f72c449`
- Installed source record: `skills/yomiyasu/`
- License: MIT; bundled Unicode-derived data uses Unicode License V3.
- Copyright: 2026 nanaism; Unicode data copyright 1991-2026 Unicode, Inc.
- Local changes: none; registered in the harness bootstrap allowlist.

The license texts are preserved in `skills/yomiyasu/LICENSE` and `skills/yomiyasu/UNICODE-LICENSE.txt`.

The remaining skills were migrated from pre-existing personal configuration. Their upstream provenance was not recorded in the original local setup; review provenance before publishing this repository publicly.
