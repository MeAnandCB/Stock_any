// Vercel entry point: reuses the same request handler as `node server.js`.
// vercel.json rewrites every /api/* request here; the handler routes by req.url.
import { createServer } from '../server.js';

const server = createServer();

export default function handler(req, res) {
  server.emit('request', req, res);
}
