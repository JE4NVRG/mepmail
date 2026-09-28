import { router } from "../../trpc";
import { consoleAuditRouter } from "./audit";
import { consoleMonitorRouter } from "./monitor";
import { consoleOverviewRouter } from "./overview";
import { consoleRegionsRouter } from "./regions";
import { consoleSafetyRouter } from "./safety";
import { consoleTeamsRouter } from "./teams";
import { consoleUsersRouter } from "./users";

/** The instance operator's console: every procedure is an operatorProcedure. */
export const consoleRouter = router({
  overview: consoleOverviewRouter,
  regions: consoleRegionsRouter,
  teams: consoleTeamsRouter,
  users: consoleUsersRouter,
  safety: consoleSafetyRouter,
  monitor: consoleMonitorRouter,
  audit: consoleAuditRouter,
});
