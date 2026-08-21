export const ASSIST_POLICIES = ["default-on", "default-off", "disallowed"] as const;

export const ASSIST_DEFINITIONS = [
  {
    id: "no-move-alert",
    label: "No-move alert",
    description: "Tell you when no legal play is available from your rack.",
    defaultPolicy: "default-on",
  },
  {
    id: "auto-draw",
    label: "Auto-draw",
    description: "Draw and end your turn automatically when no legal play is available.",
    defaultPolicy: "default-off",
  },
] as const;

export const ASSIST_IDS = ASSIST_DEFINITIONS.map((assist) => assist.id) as Array<
  (typeof ASSIST_DEFINITIONS)[number]["id"]
>;

export type AssistId = (typeof ASSIST_DEFINITIONS)[number]["id"];
export type AssistPolicy = (typeof ASSIST_POLICIES)[number];
export type AssistPolicyMap = Record<AssistId, AssistPolicy>;

export const DEFAULT_ASSIST_POLICY: AssistPolicyMap = Object.fromEntries(
  ASSIST_DEFINITIONS.map((assist) => [assist.id, assist.defaultPolicy]),
) as AssistPolicyMap;

export function enabledAssistsForPolicy(policy: AssistPolicyMap): AssistId[] {
  return ASSIST_IDS.filter((assistId) => policy[assistId] === "default-on");
}
