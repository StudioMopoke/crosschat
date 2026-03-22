# /feature — Feature specification

Specify **what** to build: interactive feature specification, technical design, and scope planning. For planning **when** and **how** to execute, use `/discuss` instead. Use `/feature review {name}` to review an existing feature spec.

## Input

Argument: `$ARGUMENTS` (feature name, or `review {name}` for review mode)

---

## Specification Mode (default)

Invoked as `/feature` or `/feature {feature-name}`.

### Step 1: Parse argument

- If empty, ask the user to name or describe the feature in a sentence.
- If a name is provided, use it as the working title.
- If the argument starts with `review`, switch to **Review Mode** (see below).

### Step 2: Check for existing feature docs

Search `planning/features/` for docs matching the feature name. If found, ask whether to continue refining the existing spec or start fresh.

### Step 3: Initial exploration

Spawn exploration agents across all zones with `run_in_background: true`:

| Zone | Paths |
|------|-------|
| **Hub Core** | `src/hub/` |
| **MCP Tools** | `src/tools/` |
| **Server & Core** | `src/server.ts`, `src/types.ts`, `src/prompts.ts`, `src/lifecycle.ts`, `src/stores/`, `src/index.ts` |
| **Dashboard** | `dashboard/` |
| **CLI & Hooks** | `bin/`, `hooks/` |

Prompt agents to identify:
- Systems, modules, and patterns relevant to the feature
- Existing code the feature will interact with, extend, or depend on
- Architectural constraints or patterns the feature must follow
- Reference implementations of similar features

### Step 4: Iterative discovery

Conduct a structured Q&A to flesh out the feature. Adapt order and depth based on responses — skip irrelevant areas, dig deeper where ambiguous.

**Problem & Purpose:**
- What problem does this solve? Who is it for?
- What does success look like?
- Are there existing workarounds?

**Scope & Boundaries:**
- What's the MVP?
- What's explicitly out of scope?
- Are there phases or milestones?

**Behaviour & Requirements:**
- Key user stories / use cases?
- Acceptance criteria for each?
- Error/edge cases?
- Performance, scale, or latency requirements?

**Dependencies & Integration:**
- What existing systems does this touch? (ground in agent findings)
- External services or APIs involved? (MCP protocol, Claude Code)
- Ordering dependencies?

**Technical Approach:**
- Proposed architecture? (suggest based on agent findings)
- New interfaces, services, or data structures?
- Existing code needing modification?
- Technical alternatives to evaluate?

**Testing Strategy:**
- Key test scenarios?
- Unit vs integration vs manual?

**Risks & Unknowns:**
- What are you unsure about?
- What could go wrong?

Keep iterating until the user is satisfied. After each section, summarize and ask if anything is missing.

### Step 5: Produce artifacts

Once discovery is complete, generate feature docs. **Ask for approval before writing.**

Create:
```
planning/features/{feature-name}/
├── spec.md               # Feature specification
├── technical-design.md   # Technical design document
└── scope.md              # Scope, phases, task breakdown
```

**`spec.md`** should include: Problem Statement, Success Criteria, User Stories, Acceptance Criteria, Out of Scope, Open Questions.

**`technical-design.md`** should include: Overview, Architecture, Dependencies (internal/external/ordering), Key Changes (new/modified files), Interfaces & Data, Alternatives Considered, Risks.

**`scope.md`** should include: Phases (MVP, v1, etc.) with deliverables and complexity estimates, Task Breakdown table (# | Task | Depends On | Complexity), Testing Strategy.

### Step 6: Offer next steps

- Offer to create GitHub Issues from the task breakdown: `gh issue create --repo StudioMopoke/crosschat --title "..." --body "..."`
- Offer to add issues to the project board: `python scripts/project.py batch {NUMBERS} ready`
- Suggest `/discuss` to plan a sprint around this feature
- Suggest `/start` to begin work on the first task
- Highlight open questions that should be resolved before implementation

---

## Review Mode

Invoked as `/feature review {feature-name}`.

### Step 1: Find feature docs

Search `planning/features/` for the named feature. If not found, list available features. If multiple matches, disambiguate.

### Step 2: Load all feature docs

Read `spec.md`, `technical-design.md`, and `scope.md` for the feature.

### Step 3: Spawn exploration agents

For each zone referenced in the technical design, spawn an agent to check current state:
- Are dependencies still accurate?
- Has referenced code changed?
- Are there new patterns that affect the approach?
- Have tasks been partially implemented?

### Step 4: Assess completeness

**Spec completeness:** Problem statement clear? Success criteria measurable? AC testable? Edge cases covered? Out-of-scope listed?

**Technical design completeness:** All dependencies identified? Key changes mapped to files? Interfaces defined concretely? Architecture aligns with existing patterns? Risks identified?

**Scope completeness:** MVP clearly defined? Task breakdown has enough detail for issues? Dependencies mapped? Testing strategy concrete?

### Step 5: Check for staleness

Identify: changed dependencies, moved/refactored code, new patterns, partially implemented tasks.

### Step 6: Report findings

```
## Feature Review: {Feature Name}

### Status
{Ready to implement / Needs refinement / Significant gaps}

### Completeness
- **Spec:** {Complete / Gaps found} — {details}
- **Technical Design:** {Complete / Gaps found} — {details}
- **Scope:** {Complete / Gaps found} — {details}

### Staleness
{Outdated items based on current codebase}

### Open Questions
{Unresolved + new questions from review}

### Recommendations
{Specific actions to address gaps}
```

### Step 7: Offer to fix

For each gap or staleness issue, offer to update the feature docs interactively.
