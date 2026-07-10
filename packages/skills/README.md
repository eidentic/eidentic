# @eidentic/skills

Skill substrate for Eidentic — parse `SKILL.md` prompt skill manifests, manage skill
banks (approve / list / register), run test-gated executable skills signed with ed25519
keypairs, and evolve skills with LLM-driven feedback loops. The skill system enables
agents that improve their own behavior over time.

## Install

```bash
pnpm add @eidentic/skills
```

## Usage

```ts
import { SkillBank, parseSkillMd, evolveSkill } from "@eidentic/skills";
import { AIModel } from "@eidentic/model";
import { anthropic } from "@ai-sdk/anthropic";

// Parse and register a SKILL.md
const manifest = parseSkillMd(`
---
name: summarize
description: Summarize long documents concisely.
---
When asked to summarize, produce a bullet-point list of key points...
`);

const bank = new SkillBank();
await bank.register(manifest);

// Approve for use in agents (agent-authored skills are quarantined until approved)
bank.approve("summarize");

// Evolve an executable skill using LLM-driven refinement
import type { ExecutableSkillDef } from "@eidentic/skills";
const result = await evolveSkill(executableSkill satisfies ExecutableSkillDef, {
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  maxRounds: 3,
});
```

## Signed production banks

`requireSigned: true` is fail-closed: it accepts only serialized `code` skills executed through a
`SandboxPort`. In-process `run` functions remain supported by the default unsigned/trusted
development bank, but cannot be registered in a signed bank because JavaScript closures and their
captured state cannot be represented honestly by a portable content signature.

To migrate a signed deployment, move the executable body to `code`, provide a real sandbox, approve
agent-authored skills, then sign the approved lock and attach it with `setSignature`. `SkillBank`
snapshots definitions and locks at registration, and verifies the stored content digest again before
approval, signature attachment, and execution. Test inputs must be structured-cloneable so the
asynchronous test gate cannot observe caller mutations after registration begins.

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
