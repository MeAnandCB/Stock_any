// Server side of cloud sync: stores each synced item in MongoDB and applies "newest wins" per item.
//
//   sync_buckets  one document per sync code (only a SHA-256 hash of the code is stored)
//   sync_items    one document per (bucket, key): { json, updatedAt }
//
// Newest-wins is enforced by the database itself (an update only matches when the stored item is
// older), so two devices syncing at the same moment can never overwrite newer data with older data.
import { createHash } from 'node:crypto';
import { SyncError } from './sync-core.js';

export const hashCode = (code) => createHash('sha256').update(`stocksense-sync:${code}`).digest('hex');

// A public deployment must not let strangers fill the free database, so the number of sync
// codes is capped (raise it with SYNC_MAX_BUCKETS).
export function maxBuckets() {
  const n = parseInt(process.env.SYNC_MAX_BUCKETS, 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

const isDuplicate = (e) => {
  if (e?.code === 11000) return true;
  const errs = [].concat(e?.writeErrors ?? []);
  return errs.length > 0 && errs.every((x) => (x.code ?? x.err?.code) === 11000);
};

// items must already be sanitised (see sanitizeItems). Returns every item stored for this code.
export async function syncExchange(db, { code, items = {}, create = false, wipe = false }, now = Date.now()) {
  const id = hashCode(code);
  const buckets = db.collection('sync_buckets');
  const coll = db.collection('sync_items');
  const bucket = await buckets.findOne({ _id: id }, { projection: { _id: 1 } });

  if (wipe) {
    if (bucket) {
      await coll.deleteMany({ bucket: id });
      await buckets.deleteOne({ _id: id });
    }
    return { items: {}, serverTime: now, wiped: Boolean(bucket) };
  }

  let created = false;
  if (!bucket) {
    if (!create) {
      throw new SyncError('No cloud data was found for this sync code. Check the code, or create a new one on the device that has your data.', 404);
    }
    if ((await buckets.estimatedDocumentCount()) >= maxBuckets()) {
      throw new SyncError('This server already has the maximum number of sync codes.', 403);
    }
    try {
      await buckets.insertOne({ _id: id, createdAt: new Date(now) });
      created = true;
    } catch (e) {
      if (e?.code !== 11000) throw e; // another device created it a moment ago: fine
    }
  }

  const ops = Object.entries(items).map(([key, it]) => ({
    updateOne: {
      filter: { _id: `${id}:${key}`, updatedAt: { $lt: it.updatedAt } },
      update: { $set: { bucket: id, key, json: it.json, updatedAt: it.updatedAt, serverAt: new Date(now) } },
      upsert: true,
    },
  }));
  if (ops.length) {
    try {
      await coll.bulkWrite(ops, { ordered: false });
    } catch (e) {
      if (!isDuplicate(e)) throw e; // "duplicate" just means the stored copy is newer or identical
    }
  }
  await buckets.updateOne({ _id: id }, { $set: { lastSeen: new Date(now) } });

  const out = {};
  for (const row of await coll.find({ bucket: id }).toArray()) out[row.key] = { json: row.json, updatedAt: row.updatedAt };
  return { items: out, serverTime: now, created };
}
