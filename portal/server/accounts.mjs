import { fileURLToPath } from 'node:url';
import { createAuthStore } from './auth-store.mjs';

const store = createAuthStore({ path: process.env.AUTH_DB_PATH ?? fileURLToPath(new URL('../data/auth.sqlite', import.meta.url)) });
try {
  const [action, ...names] = process.argv.slice(2);
  let code;
  if (action === 'setup') {
    code = store.issueEnrollmentCode('setup');
  } else if (action === 'recover' && names.length) {
    const user = store.findUserByName(names.join(' '));
    if (!user) throw new Error('User not found.');
    code = store.issueEnrollmentCode('recovery', user.id);
  } else {
    throw new Error('Usage: node server/accounts.mjs setup | recover "Username"');
  }
  console.log(`${action === 'setup' ? 'Administrator setup' : 'Account recovery'} code (single use; expires ${new Date(code.expiresAt).toISOString()}):`);
  console.log(code.token);
  console.log('Enter this code directly into the portal. Do not share it in chat or logs.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}