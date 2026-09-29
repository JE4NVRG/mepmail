import { logoSrc, MCP_CHIP, stackLogo } from "@/lib/stack-logos";

/**
 * The row of integration marks (home strip, /integrations mural and the
 * per-card rows). Every mark is a vendored full-colour file under
 * public/logos/integrations — see that folder's README for its source. Marks
 * are normalised by HEIGHT (the CSS sets the height per surface and lets the
 * width follow), so the width/height attributes are derived from each file's
 * ink ratio: they reserve the correct box and never squash a wide lockup.
 *
 * MCP has no vendor logo, so its slug draws a text chip instead: an unknown
 * slug never renders a broken image.
 */
export function StackLogoRow({
  slugs,
  size = 28,
  className,
}: {
  slugs: readonly string[];
  size?: number;
  className?: string;
}) {
  return (
    <ul className={className ? `gtm-stack-logos ${className}` : "gtm-stack-logos"}>
      {slugs.map((slug) => {
        const logo = stackLogo(slug);
        return (
          <li key={slug}>
            {logo ? (
              <img
                src={logoSrc(logo.slug)}
                alt={logo.name}
                width={Math.round(size * logo.ratio)}
                height={size}
                loading="lazy"
              />
            ) : (
              <span className="gtm-mcp-chip">{MCP_CHIP.toUpperCase()}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
