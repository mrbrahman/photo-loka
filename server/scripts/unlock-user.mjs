import 'dotenv/config';
import { unlockUser } from '../app/authn/authn-service.mjs';

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : null;
}

const username = getArg('username');

if (!username) {
  console.error('Usage: npm run unlock-user -- --username <username>');
  process.exit(1);
}

try {
  unlockUser(username);
  console.log(`??? User unlocked successfully: ${username}`);
  process.exit(0);
} catch (error) {
  console.error('??? Failed to unlock user:', error.message);
  process.exit(1);
}
