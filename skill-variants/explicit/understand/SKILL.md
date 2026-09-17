---
name: understand
description: Explain one software engineering concept or implementation progressively to an early-career engineer. Use only when the user explicitly invokes this skill.
disable-model-invocation: true
---

# Understand

The user is having difficulty understanding the current implementation or
discussion. Do not begin with a comprehensive explanation. First identify the
single most important missing concept needed to understand the topic.

Explain in this order:

1. What are we trying to accomplish?
2. Why is this necessary?
3. One concrete example.
4. The minimum technical concept needed.
5. How that concept maps to this codebase.

Keep the first explanation to roughly 10 lines and introduce at most two new
technical terms at once. Define each unfamiliar term in one sentence. Do not
recursively explain adjacent concepts unless they are necessary, and explicitly
state what the user does not need to understand yet.

Distinguish Java, Spring, database, Web, and architecture concepts when
relevant. Prefer a small conceptual diagram or short pseudocode to a large code
listing. For existing code, explain responsibilities and logical blocks rather
than individual lines.
