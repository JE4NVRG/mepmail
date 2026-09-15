"use client";

import type { PopoverMenuItem } from "@/components/popover-menu";

/** The facts every team action needs, as both the Teams list and the Trust & safety rows carry them. */
export interface TeamActionTarget {
  id: string;
  name: string;
  plan: string;
  planQuota: number | null;
  suspendedAt: Date | null;
  broadcastsPausedByOperatorAt: Date | null;
}

export interface TeamActions {
  /** The team dialog (counters, type, owner, members, region, guardrail, created, Stripe). */
  openTeam(team: TeamActionTarget): void;
  adjustLimits(team: TeamActionTarget): void;
  changePlan(team: TeamActionTarget): void;
  pauseBroadcasts(team: TeamActionTarget): void;
  resumeBroadcasts(team: TeamActionTarget): void;
  suspend(team: TeamActionTarget): void;
  reinstate(team: TeamActionTarget): void;
  /** Render once per page: the dialogs the actions above open. */
  dialogs: React.ReactNode;
}

/**
 * CONTRACT for the Teams screen owner: every operator action on a team and
 * its dialog (Adjust limits, Change plan, Pause broadcasts, Suspend,
 * Reinstate, and the team detail dialog), behind one hook so the Teams list
 * and the Trust & safety screens share them. `onChanged` re-fetches the
 * caller's data after a mutation; successes toast.
 */
export function useTeamActions(onChanged: () => void): TeamActions {
  void onChanged;
  const noop = () => {};
  return {
    openTeam: noop,
    adjustLimits: noop,
    changePlan: noop,
    pauseBroadcasts: noop,
    resumeBroadcasts: noop,
    suspend: noop,
    reinstate: noop,
    dialogs: null,
  };
}

/**
 * The Teams list's "…" items for one team, from the shared actions: Open
 * team, Adjust limits, Change plan, separator, Pause/Resume broadcasts,
 * Suspend/Reinstate team. `labels` come from console.teams.menu.
 */
export function teamMenuItems(
  team: TeamActionTarget,
  actions: TeamActions,
  labels: (key: string) => string,
): (PopoverMenuItem | null)[] {
  return [
    { label: labels("open"), onSelect: () => actions.openTeam(team) },
    { label: labels("limits"), onSelect: () => actions.adjustLimits(team) },
    { label: labels("plan"), onSelect: () => actions.changePlan(team) },
    null,
    team.broadcastsPausedByOperatorAt
      ? { label: labels("resume"), onSelect: () => actions.resumeBroadcasts(team) }
      : { label: labels("pause"), onSelect: () => actions.pauseBroadcasts(team) },
    team.suspendedAt
      ? { label: labels("reinstate"), onSelect: () => actions.reinstate(team) }
      : { label: labels("suspend"), danger: true, onSelect: () => actions.suspend(team) },
  ];
}
