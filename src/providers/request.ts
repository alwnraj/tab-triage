import { ordered } from "../core/groups.js";
import type { ModelGroup, Order, TabInput } from "../core/types.js";

/**
 * The exact TypeSafe request body (POST /v1/systemone). Also used by the
 * Options page's "what gets sent" panel, so the panel can't drift from reality.
 * Shapes from https://api.typesafe.ai/openapi.json (SystemOneRequest,
 * ChoiceQuestion, NoulQuestion, NoulCriteria).
 */
export function buildRequest(model: string, input: TabInput, groups: readonly ModelGroup[], order: Order) {
  const gs = ordered(groups, order);
  const criteria: Record<string, string> = {};
  for (const g of gs) criteria[g.key] = g.description;
  return {
    model,
    state: { site: input.site, title: input.title },
    questions: {
      group: {
        type: "choice" as const,
        instructions: "Which of these tab groups does the browser tab described by `site` and `title` belong in?",
        criteria,
      },
      fits: {
        type: "noul" as const,
        instructions: {
          question: "Does the browser tab described by `site` and `title` clearly belong in one of `groups`?",
          groups: { ...criteria },
        },
        criteria: {
          true: "The tab plainly matches the description of one of the groups.",
          false: "The tab matches none of the groups, or only loosely.",
        },
      },
    },
  };
}

export type SystemOneRequest = ReturnType<typeof buildRequest>;
