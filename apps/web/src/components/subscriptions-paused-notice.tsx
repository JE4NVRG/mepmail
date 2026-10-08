import { getTranslations } from "next-intl/server";
import { newSubscriptionsPaused } from "@/server/new-subscriptions";
import styles from "./subscriptions-paused-notice.module.css";

/** Public-site strip above the header while new subscriptions are paused. */
export async function SubscriptionsPausedNotice() {
  if (!newSubscriptionsPaused()) return null;
  const t = await getTranslations("common.subscriptionsPaused");
  return (
    <div role="status" className={styles.notice}>
      <span className={styles.dot} aria-hidden="true" />
      <span>{t("public")}</span>
    </div>
  );
}
