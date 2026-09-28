import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type UsersList = RouterOutputs["console"]["users"]["list"];
export type UserRow = UsersList["items"][number];
