import { z } from "zod";
import {
  createHeldMessageReviewService,
  type HeldReviewDependencies,
  heldReviewRequestSchema,
} from "../../console/held-message-review";
import { operatorProcedure, router } from "../../trpc";

export function createConsoleHeldMessageReviewRouter(deps: HeldReviewDependencies = {}) {
  const service = createHeldMessageReviewService(deps);
  return router({
    status: operatorProcedure
      .input(z.object({ teamId: z.uuid() }))
      .query(({ ctx, input }) => service.status(ctx, input)),
    requestAccess: operatorProcedure
      .input(heldReviewRequestSchema)
      .mutation(({ ctx, input }) => service.requestAccess(ctx, input)),
    revealed: operatorProcedure
      .input(z.object({ teamId: z.uuid(), emailId: z.uuid(), operationId: z.uuid() }))
      .query(({ ctx, input }) => service.revealed(ctx, input)),
  });
}

export const consoleHeldMessageReviewRouter = createConsoleHeldMessageReviewRouter();
