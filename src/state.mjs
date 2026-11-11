import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const minute = 60_000;
const day = 24 * 60 * minute;
export class ReviewStore {
  constructor(path, key, clock = Date.now) {
    if (key.length !== 32) throw new Error('Review key must be 32 bytes');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.key = key;
    this.clock = clock;
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB,
        status TEXT NOT NULL, result BLOB, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS retention ON reviews(created);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_write ON reviews(owner) WHERE status='submitting';
    `);
  }
  mac(label, ...fields) {
    return createHmac('sha256', this.key).update(JSON.stringify([label, ...fields])).digest('base64url');
  }
  owner(customerId) { return this.mac('customer', customerId); }
  proof(owner, actionId) { return this.mac('confirm', owner, actionId); }
  checkProof(owner, actionId, proof) {
    const expected = Buffer.from(this.proof(owner, actionId));
    const provided = Buffer.from(proof);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }
  seal(id, owner, type, value) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(JSON.stringify([id, owner, type])));
    const ciphertext = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ciphertext]);
  }
  unseal(id, owner, type, bytes) {
    if (!bytes) return null;
    const b = Buffer.from(bytes);
    const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAAD(Buffer.from(JSON.stringify([id, owner, type])));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
  }
  prepare(owner, kind, payload) {
    const id = randomUUID(), now = this.clock();
    this.db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?,?,?)').run(
      id, owner, kind, this.seal(id, owner, 'payload', payload), 'pending', null, now, now
    );
    return { action_id: id, status: 'pending', expires: now + 20 * minute };
  }
  get(owner, id) {
    const row = this.db.prepare('SELECT * FROM reviews WHERE owner=? AND id=?').get(owner, id);
    if (!row) return null;
    const status = row.status === 'pending' && row.created <= this.clock() - 20 * minute ? 'expired' : row.status;
    return {
      action_id: id, kind: row.kind, status,
      payload: status === 'pending' ? this.unseal(id, owner, 'payload', row.payload) : null,
      result: this.unseal(id, owner, 'result', row.result),
    };
  }
  claim(owner, id) {
    const now = this.clock();
    return this.db.prepare(`
      UPDATE reviews SET status='submitting', updated=?
      WHERE owner=? AND id=? AND status='pending' AND created>?
        AND NOT EXISTS (SELECT 1 FROM reviews WHERE owner=? AND status='submitting')
    `).run(now, owner, id, now - 20 * minute, owner).changes === 1;
  }
  finish(owner, id, status, result) {
    this.db.prepare("UPDATE reviews SET status=?, result=?, payload=NULL, updated=? WHERE owner=? AND id=? AND status='submitting'")
      .run(status, this.seal(id, owner, 'result', result), this.clock(), owner, id);
  }
  cleanup() {
    const now = this.clock();
    this.db.prepare("UPDATE reviews SET status='unknown', payload=NULL WHERE status='submitting' AND updated<=?").run(now - 10 * minute);
    this.db.prepare("UPDATE reviews SET status='expired', payload=NULL WHERE status='pending' AND created<=?").run(now - 20 * minute);
    this.db.prepare('DELETE FROM reviews WHERE created<=?').run(now - 30 * day);
  }
  close() { this.db.close(); }
}
