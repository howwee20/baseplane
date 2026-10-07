import {readdirSync} from 'node:fs';
// Every forward migration in order, so test databases match production after `wrangler d1 migrations apply`.
export const MIGRATIONS=readdirSync(new URL('../../migrations/',import.meta.url)).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort();
