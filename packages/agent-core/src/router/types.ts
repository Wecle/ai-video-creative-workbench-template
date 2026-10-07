export type RouteInput = {
  prompt: string;
  profileId: string;
  profileSelectedExplicitly: boolean;
  selectedSkills: string[];
  selectedNodeIds: string[];
  knownSkills: { name: string; description: string }[];
  canvasNodeIds: string[];
};

export type RouteDecision = {
  profile?: string;
  candidateSkills: string[];
  targetNodeIds: string[];
  needsClarification?: { question: string; options: string[] };
  confidence: number;
};

export interface IntentRouter {
  route(input: RouteInput): Promise<RouteDecision>;
}
