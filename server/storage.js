'use strict';
// File storage: Supabase Storage when SUPABASE_URL + key are set, otherwise a local folder (dev only).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'chat-files';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const useSupabase = !!(SUPA_URL && SUPA_KEY);
let client = null;
let publicBase = '';

const safeExt = name => path.extname(String(name || '')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);

async function init() {
  if (!useSupabase) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    console.log('Storage: LOCAL folder (' + UPLOAD_DIR + ') — files are lost on hosts with ephemeral disks. Set SUPABASE_URL + SUPABASE_SERVICE_KEY for persistence.');
    return;
  }
  const { createClient } = require('@supabase/supabase-js');
  client = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  publicBase = `${SUPA_URL}/storage/v1/object/public/${BUCKET}/`;
  const { error } = await client.storage.createBucket(BUCKET, { public: true, fileSizeLimit: 25 * 1024 * 1024 });
  if (error && !/already exists|duplicate/i.test(error.message || '')) {
    console.warn('Could not create bucket "' + BUCKET + '" (create it manually in Supabase -> Storage, mark it Public):', error.message);
  }
  console.log('Storage: Supabase bucket "' + BUCKET + '"');
}

// returns a URL the clients can open directly
async function save(buffer, originalName, mime) {
  const key = new Date().toISOString().slice(0, 7) + '/' + crypto.randomBytes(12).toString('hex') + safeExt(originalName);
  if (!useSupabase) {
    const file = key.replace('/', '-');
    await fs.promises.writeFile(path.join(UPLOAD_DIR, file), buffer);
    return '/uploads/' + file;
  }
  const { error } = await client.storage.from(BUCKET).upload(key, buffer, { contentType: mime || 'application/octet-stream', upsert: false });
  if (error) throw new Error('Storage upload failed: ' + error.message);
  return publicBase + key;
}

// only accept URLs that point to OUR storage (prevents users from injecting arbitrary links)
const isOwnUrl = url => typeof url === 'string' && (useSupabase ? url.startsWith(publicBase) : url.startsWith('/uploads/'));

module.exports = { init, save, isOwnUrl, UPLOAD_DIR, get useSupabase() { return useSupabase; } };
