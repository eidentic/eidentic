---
"@eidentic/core": minor
"@eidentic/studio": minor
---

Add `Agent.skillCatalog()` accessor to expose the agent's prompt-skill catalog (from `config.skills`). Update the Studio `/api/agents/:id/skills` endpoint to return a unified array combining prompt skills (`type: "prompt"`) from the SkillSet catalog with executable bank skills (`type: "executable"`, `quarantined` flag). The Skills tab in the Studio UI now renders both types with a type badge, description, and an Approve button only for quarantined executable skills.
