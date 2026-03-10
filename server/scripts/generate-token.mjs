import 'dotenv/config';
import { generateApiToken } from '../app/authn/authn-service.mjs';

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : null;
}

let username = getArg('username');
let expiresInDays = getArg('expires') || '365';

if (!username && args.length >= 1) {
  username = args[0];
  expiresInDays = args[1] || '365';
}

if (!username) {
  console.error('Usage: npm run generate-token -- <username> [days]');
  console.error('Example: npm run generate-token -- admin 365');
  process.exit(1);
}

const days = parseInt(expiresInDays, 10);
if (isNaN(days) || days <= 0) {
  console.error('Expiry days must be a positive number');
  process.exit(1);
}

try {
  const token = generateApiToken(username, days);
  console.log(`✅ API token generated for user: ${username}`);
  console.log(`📅 Expires in: ${days} days`);
  console.log(`\n🔑 Token:\n${token}`);
  console.log(`\n💡 Usage:\ncurl -H "Authorization: Bearer ${token}" http://localhost:9000/api/...`);
  process.exit(0);
} catch (error) {
  console.error('❌ Failed to generate token:', error.message);
  process.exit(1);
}
