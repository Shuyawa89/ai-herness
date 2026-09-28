---
name: design-check
description: Clarify the intended end state and relevant design concerns before implementation. Use only when the user explicitly invokes this skill.
disable-model-invocation: true
---

# Design Check

Do not write code. Inspect the task and relevant repository context, then help
the user understand the intended end state before a non-trivial implementation.
Base the response on repository evidence rather than a generic checklist. Keep
it concise and explain:

1. What should be true when the task is complete?
2. What are the main components and responsibilities?
3. What data flows through the system?
4. What important decisions must be made before implementation?
5. What might an early-career engineer overlook?

Consider only concerns relevant to the task, such as domain rules, API contracts
and exposed fields, authorization, transaction boundaries, failure cases,
persistence, concurrency, backward compatibility, and testing.

If several designs are plausible, show at most three realistic options and the
main tradeoff of each. This is a concise design check, not a full workflow plan:
do not edit product code or create a plan file unless the user separately asks
for planning.
