# `.wiki/candidates/`

Staging area for low-confidence wiki entries — inferences the agent isn't sure about yet.

Mirror the main `.wiki/` layout here: `candidates/modules/`, `candidates/entities/`, `candidates/flows/`, `candidates/decisions/`, `candidates/pitfalls/`. Move a page to `.wiki/<type>/` (via `git mv`) when:

- A human confirms the claim.
- Independent evidence accumulates (same inference from N sources).
- A test or spec section confirms.

When you move, change `confidence:` to `high` (or `medium`), update incoming edges, and add an entry to `../log.md`:

```
## [YYYY-MM-DD HH:MM] candidate-promote | <slug> | <one-line reason>
```

Currently empty.
