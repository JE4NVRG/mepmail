import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { HeldMessageReview } from "@/components/console/safety/held-message-review";
import { consoleOperator } from "@/server/console-gate";

export default async function ConsoleHeldMessageReviewPage({
  params,
}: {
  params: Promise<{ teamId: string; emailId: string }>;
}) {
  const operator = await consoleOperator(await headers());
  if (!operator) notFound();
  const { teamId, emailId } = await params;
  return <HeldMessageReview key={`${teamId}:${emailId}`} teamId={teamId} emailId={emailId} />;
}
