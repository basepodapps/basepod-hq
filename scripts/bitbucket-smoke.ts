// Read-only check against YOUR Bitbucket, using ~/.jsmhq/bitbucket.json. Nothing is written.
//   pnpm exec tsx scripts/bitbucket-smoke.ts <workspace/repo>
import { checkAccess, CREDENTIALS_FILE, fetchPrs, loadCredentials } from "../server/bitbucket.ts";
import { reviewOf } from "../server/github.ts";

const slug = process.argv[2];
if (!slug?.includes("/")) {
  console.error("usage: tsx scripts/bitbucket-smoke.ts <workspace/repo>");
  process.exit(1);
}
if (!loadCredentials()) {
  console.error(`No credentials in ${CREDENTIALS_FILE}. See docs/bitbucket.md.`);
  process.exit(1);
}
const err = await checkAccess(slug);
if (err) {
  console.error(`✗ ${slug}: ${err}`);
  process.exit(1);
}
console.log(`✓ ${slug} reachable`);
const { open, merged, closed, rate } = await fetchPrs(slug, "human");
console.log(`✓ ${open.length} open, ${merged.length} recently merged, ${closed.length} recently declined (${rate.cost} API calls)`);
for (const p of open) {
  const r = reviewOf(p, "human");
  console.log(`  #${p.number} ${p.title}  [${p.headRefName}]  review=${r.review} openComments=${r.openComments}${p.isDraft ? " (draft)" : ""}`);
}
