import { isCloudDeployment } from "@millionsend/config";
import {
  CAMPAIGN_CONSENT_MESSAGE,
  campaignConsentEvidenceSchema,
  checkCampaignConsent,
  latestCampaignConsent,
  reviewCampaignConsent,
  submitCampaignConsent,
} from "@millionsend/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, operatorProcedure, router, teamProcedure } from "../trpc";

export const campaignConsentRouter = router({
  status: teamProcedure.query(async ({ ctx }) => ({
    dossier: await latestCampaignConsent(ctx.db, ctx.teamId),
    eligibility: await checkCampaignConsent(ctx.db, {
      teamId: ctx.teamId,
      operation: "import",
      isCloud: isCloudDeployment(),
    }),
  })),
  submit: adminProcedure.input(campaignConsentEvidenceSchema).mutation(({ ctx, input }) =>
    submitCampaignConsent(ctx.db, {
      teamId: ctx.teamId,
      actorId: ctx.session.user.id,
      evidence: input,
    }),
  ),
  operatorStatus: operatorProcedure
    .input(z.object({ teamId: z.uuid() }))
    .query(async ({ ctx, input }) => ({
      dossier: await latestCampaignConsent(ctx.db, input.teamId),
      eligibility: await checkCampaignConsent(ctx.db, {
        teamId: input.teamId,
        operation: "import",
        isCloud: isCloudDeployment(),
      }),
    })),
  review: operatorProcedure
    .input(
      z.object({
        teamId: z.uuid(),
        dossierId: z.uuid(),
        decision: z.enum(["approved", "rejected", "revoked"]),
        reason: z.string().trim().min(15).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await reviewCampaignConsent(ctx.db, { ...input, operatorId: ctx.operator.id });
      } catch (cause) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: cause instanceof Error ? cause.message : CAMPAIGN_CONSENT_MESSAGE,
        });
      }
    }),
});
