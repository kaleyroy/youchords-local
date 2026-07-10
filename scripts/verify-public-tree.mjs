import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', 'node_modules']);
const forbiddenNames = new Set([
  '.env',
  'cookies.txt',
  'credentials.db',
  'service-account.json'
]);
const forbiddenExtensions = new Set(['.pem', '.p12', '.key']);
const forbiddenMarkers = [
  ['api', '.you-chords.com'].join(''),
  ['cloudfunctions', '.net'].join(''),
  ['105463017', '9061'].join(''),
  ['gapcpofgdohoefk', 'foeeajcodedplbldd'].join(''),
  ['BEGIN ', 'PRIVATE KEY'].join(''),
  ['SUPABASE_', 'SERVICE_ROLE_KEY'].join(''),
  ['PADDLE_', 'API_KEY'].join('')
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

const failures = [];
const files = walk(root);

for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const name = path.basename(file).toLowerCase();
  const extension = path.extname(file).toLowerCase();

  if (forbiddenNames.has(name) || forbiddenExtensions.has(extension)) {
    failures.push(`${relative}: forbidden file type or name`);
    continue;
  }

  if (!['.js', '.mjs', '.json', '.html', '.css', '.md', '.txt'].includes(extension)) continue;
  const content = fs.readFileSync(file, 'utf8');

  if (extension === '.json') {
    try {
      JSON.parse(content);
    } catch (error) {
      failures.push(`${relative}: invalid JSON (${error.message})`);
    }
  }

  for (const marker of forbiddenMarkers) {
    if (content.includes(marker)) failures.push(`${relative}: contains forbidden production marker`);
  }
}

if (failures.length) {
  console.error('Public tree verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public tree verification passed (${files.length} files).`);
