// Starts a MongoDB on this computer for StockSense:  npm run db
// Data is kept in ./.mongodb/data, so it survives restarts. Listens on 127.0.0.1 only (not reachable
// from other machines). Leave it running in its own terminal; press Ctrl+C to stop it.
//
// Uses ./.mongodb/mongod if present, otherwise a `mongod` found on your PATH (e.g. after
// "brew install mongodb-community"). Prefer MongoDB Atlas? You do not need this script at all —
// just put the Atlas connection string in .env.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = path.join(root, '.mongodb');
const local = path.join(home, process.platform === 'win32' ? 'mongod.exe' : 'mongod');
const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['mongod'], { stdio: 'ignore' }).status === 0;
const bin = existsSync(local) ? local : onPath ? 'mongod' : null;

if (!bin) {
  console.error(`
No MongoDB program found. Pick one:

  1. MongoDB Atlas (free, in the cloud): create a cluster, copy its connection string into .env
     as MONGODB_URI=...   (steps are in the README)
  2. Install MongoDB on this computer, then run "npm run db" again:
       macOS:    brew tap mongodb/brew && brew install mongodb-community
       Windows:  https://www.mongodb.com/try/download/community
`);
  process.exit(1);
}

const port = String(Number(process.env.MONGODB_PORT) || 27017);
const data = path.join(home, 'data');
mkdirSync(data, { recursive: true });
const log = path.join(home, 'mongod.log'); // mongod is very chatty, so its output goes to a file
console.log(`MongoDB is starting on 127.0.0.1:${port}\n  program: ${bin === 'mongod' ? 'mongod (from PATH)' : path.relative(root, bin)}\n  data:    ${path.relative(root, data)}\n  log:     ${path.relative(root, log)}\n\nLeave this window open while you use the app. Ctrl+C stops it.\n`);

const child = spawn(bin, ['--dbpath', data, '--bind_ip', '127.0.0.1', '--port', port, '--logpath', log, '--logappend'], { stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', (e) => {
  console.error(`Could not start MongoDB: ${e.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig)); // clean shutdown keeps the data safe
