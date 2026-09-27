import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AWS_SETUP_COMMAND, awsAddRegionCommand } from "@millionsend/ses/setup-constants";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const readWebFile = (path: string): string => readFileSync(join(webRoot, path), "utf8");

describe("supported setup commands in the UI", () => {
  it("exposes the source-checkout command for the SES setup card", () => {
    const source = readWebFile("src/app/(dashboard)/settings/ses/ses-setup-view.tsx");

    expect(AWS_SETUP_COMMAND).toBe("pnpm setup:aws");
    expect(source).toContain("value={AWS_SETUP_COMMAND}");
    expect(source).not.toContain("npx @millionsend/setup");
  });

  it("renders the explicit add-region subcommand in the regions panel", () => {
    const source = readWebFile("src/components/console/regions/add-region-panel.tsx");

    expect(awsAddRegionCommand("sa-east-1")).toBe("pnpm setup:aws add-region sa-east-1");
    expect(source).toContain("awsAddRegionCommand(region)");
    expect(source).not.toContain("npx @millionsend/setup");
  });

  it.each(["en", "pt-BR"])("requires the source checkout and Node 22+ in %s", (locale) => {
    const settings = readWebFile(`messages/${locale}/settings.json`);
    const consoleMessages = readWebFile(`messages/${locale}/console.json`);

    expect(settings).toContain("Node 22+");
    expect(settings).not.toContain("Node 18+");
    expect(`${settings}\n${consoleMessages}`).toMatch(/source checkout|checkout do código-fonte/);
  });
});
