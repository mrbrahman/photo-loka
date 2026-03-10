import 'dotenv/config';
import { createUser } from '../app/infrastructure/authn/authn-service.mjs';

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : null;
}

let username = getArg('username') || process.env.ADMIN_USER;
let password = getArg('password') || process.env.ADMIN_PASS;
let role = getArg('role') || 'user';

// Fallback to positional arguments if named arguments not found
if (!username && args.length >= 2) {
  username = args[0];
  password = args[1];
  role = args[2] || 'user';
}

if (!username || !password) {
  console.error('Usage: npm run create-user -- <username> <password> [admin|user]');
  console.error('Or set ADMIN_USER and ADMIN_PASS environment variables');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters long');
  process.exit(1);
}

if (!['admin', 'user'].includes(role)) {
  console.error('Role must be either "admin" or "user"');
  process.exit(1);
}

try {
  await createUser(username, password, role);
  console.log(`??? User created successfully: ${username} (${role})`);
  process.exit(0);
} catch (error) {
  console.error('??? Failed to create user:', error.message);
  process.exit(1);
}
