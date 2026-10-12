/** Flag + code for the SES regions the instance offers (SPEC §6 region set). */
const REGION_FLAGS: Record<string, string> = {
  "us-east-1": "🇺🇸",
  "us-east-2": "🇺🇸",
  "us-west-1": "🇺🇸",
  "us-west-2": "🇺🇸",
  "eu-west-1": "🇮🇪",
  "eu-west-2": "🇬🇧",
  "eu-central-1": "🇩🇪",
  "sa-east-1": "🇧🇷",
  "ap-northeast-1": "🇯🇵",
  "ap-southeast-1": "🇸🇬",
  "ap-southeast-2": "🇦🇺",
  "ap-south-1": "🇮🇳",
  "ca-central-1": "🇨🇦",
};

/** A region code with its flag, e.g. "🇺🇸 us-east-1". Falls back to the bare
 * code for unknown regions and an em dash when absent. */
export function RegionLabel({ region }: { region?: string | null }) {
  if (!region) return <span>—</span>;
  const flag = REGION_FLAGS[region];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {flag && <span aria-hidden="true">{flag}</span>}
      <span>{region}</span>
    </span>
  );
}
