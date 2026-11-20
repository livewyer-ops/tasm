import { execFileSync } from 'node:child_process';
import { appName } from './apps.mjs';

const app = appName(process.argv[2]);
const dryRun = process.argv[3] === '--dry-run';
if (process.argv.slice(3).length !== Number(dryRun)) throw new Error('Only --dry-run is supported.');
const domain = process.env.TASM_DEPLOY_DOMAIN ?? (dryRun ? app + '.example.com' : '');
if (!/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/i.test(domain)) {
  throw new Error('Set TASM_DEPLOY_DOMAIN to the custom hostname for this app.');
}
if (!dryRun && !/^[a-f0-9]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '')) {
  throw new Error('Select the deployment account with CLOUDFLARE_ACCOUNT_ID.');
}
if (!dryRun && process.env.TASM_DIST) throw new Error('Deployment uses dist/. Unset TASM_DIST before building.');
execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy',
  '--config', `apps/${app}/wrangler.jsonc`, '--domain', domain, ...(dryRun ? ['--dry-run'] : [])], { stdio: 'inherit' });
