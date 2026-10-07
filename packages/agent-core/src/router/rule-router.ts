import type { IntentRouter, RouteDecision, RouteInput } from "./types";

export function createRuleRouter(): IntentRouter {
  return {
    async route(input: RouteInput): Promise<RouteDecision> {
      let profile: string | undefined;
      let usedExplicitSignal = false;

      if (input.profileSelectedExplicitly) {
        profile = input.profileId;
        usedExplicitSignal = true;
      }

      const candidateSkills: string[] = [];
      let needsClarification:
        { question: string; options: string[] } | undefined;
      let ambiguous = false;

      // 1. Check /<skill> command at start of prompt
      const slashMatch = input.prompt.trimStart().match(/^\/([a-zA-Z0-9_-]+)/);
      if (slashMatch && slashMatch[1]) {
        const cmd = slashMatch[1].toLowerCase();
        const exact = input.knownSkills.find(
          (s) => s.name.toLowerCase() === cmd,
        );
        if (exact) {
          candidateSkills.push(exact.name);
          usedExplicitSignal = true;
        } else {
          const prefixMatches = input.knownSkills.filter((s) =>
            s.name.toLowerCase().startsWith(cmd),
          );
          if (prefixMatches.length === 1) {
            candidateSkills.push(prefixMatches[0]!.name);
            usedExplicitSignal = true;
          } else if (prefixMatches.length >= 2 && prefixMatches.length <= 3) {
            needsClarification = {
              question: "Did you mean one of these skills?",
              options: prefixMatches.map((s) => s.name),
            };
            ambiguous = true;
          }
        }
      }

      // 2. Merge selectedSkills that are known to profile
      for (const skill of input.selectedSkills) {
        if (
          input.knownSkills.some((s) => s.name === skill) &&
          !candidateSkills.includes(skill)
        ) {
          candidateSkills.push(skill);
          usedExplicitSignal = true;
        }
      }

      // 3. Filter selectedNodeIds against canvasNodeIds
      const targetNodeIds: string[] = [];
      for (const id of input.selectedNodeIds) {
        if (input.canvasNodeIds.includes(id) && !targetNodeIds.includes(id)) {
          targetNodeIds.push(id);
          usedExplicitSignal = true;
        }
      }

      let confidence = 0;
      if (usedExplicitSignal) {
        confidence = 1;
      } else if (ambiguous) {
        confidence = 0.5;
      }

      return {
        profile,
        candidateSkills,
        targetNodeIds,
        needsClarification,
        confidence,
      };
    },
  };
}
