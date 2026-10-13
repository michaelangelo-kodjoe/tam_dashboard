// Copies db/mock_data.json (owned by the Data Architect) into public/ so the
// MockDataSource can fetch it at runtime. Never edit the copy.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../db/mock_data.json');
const dst = resolve(here, '../public/mock_data.json');
if (!existsSync(src)) {
  console.error(`sync-mock: source not found: ${src}`);
  process.exit(1);
}
mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log('sync-mock: copied db/mock_data.json -> public/mock_data.json');
