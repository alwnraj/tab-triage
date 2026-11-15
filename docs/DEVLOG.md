# Dev log

## 1. Reading the API, then designing

I read the TypeSafe `llms.txt` index, the OpenAPI spec and the Choice, Noul, Confidence, Companion Noul, Errors, Models and Model-jaggedness pages before writing any code. The key facts are these. One `POST /v1/systemone` call can carry a Choice and a Noul together. Probabilities come keyed by option name, the price is $0.042 per million input tokens, aliases like `jev-latest` move, and the docs openly say Jev leans toward the first option. That led to three choices: pin `jev-1.14.0`, threshold on the probability and the Noul rather than on `confidence`, and use non-numeric `g_` option keys so that JavaScript's integer-key ordering can't silently undo the order reversal. I also decided to classify everything before moving anything, so a run applies its whole plan or nothing.

## 2. Review #1 (design)

The `.claude/agents/reviewer.md` file was created mid-session, and the agent registry is only loaded at session start, so `subagent_type: reviewer` was not found. The review ran as a general-purpose agent pinned to `model: fable`, briefed to follow reviewer.md and to use only Read, Grep and Glob. (It tried one Bash listing, which was denied, so nothing ran.) It found two real blockers I had missed. First, mock answers could land in the cache and later be served as real. Second, my design saved the Undo snapshot after applying the moves, so a crash halfway through would have left no Undo. I accepted every finding; see DESIGN §15. One judgment call: the reversed-order ask still only checks agreement, as the brief specifies. Requiring the reversed answer to also clear the threshold would be stricter, but it would quietly lower coverage, and I'd rather test that with real data.
