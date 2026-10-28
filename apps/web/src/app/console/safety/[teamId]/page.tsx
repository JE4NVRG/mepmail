import { isCloudDeployment } from "@millionsend/config";
import { CampaignConsentOperator } from "@/components/campaign-consent";
import { ReviewView } from "@/components/console/safety/review-view";

export default async function ConsoleSafetyReviewPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return (
    <>
      {isCloudDeployment() && <CampaignConsentOperator teamId={teamId} />}
      <ReviewView teamId={teamId} />
    </>
  );
}
