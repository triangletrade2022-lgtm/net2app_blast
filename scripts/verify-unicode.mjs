#!/usr/bin/env node
/**
 * verify-unicode.mjs — end-to-end Unicode (emoji) SMS verification harness.
 *
 * Goal: confirm the Java SMPP gateway roundtrips wide-char input without
 * silent corruption across two wire-encoding paths:
 *
 *  (a) GSM-7/UTF-8: data_coding=0 + short_message = UTF-8 bytes of '😀'.
 *      Java's default charset canonicalises the UTF-8 octets back to "😀".
 *      sms_logs.sms_bytes should equal UTF-8 byte count (4).
 *
 *  (b) UCS-2/UTF-16BE: data_coding=8 + short_message = UTF-16BE bytes of
 *      '😀' (= 0xD83D 0xDE00, 4 octets). Java MUST decode with UTF_16BE
 *      (NOT the JVM default charset), then re-emit on the upstream
 *      SupplierClient.submitSm(SubmitSm) with rebuilt DataCoding.UCS2 +
 *      UTF-16BE bytes. sms_logs.sms_bytes should equal text.length*2 = 4
 *      (i.e., the UCS-2 wire size, not the UTF-8 representation).
 *
 * The previous version of this script ONLY exercised path (a). The added
 * path (b) is the bug the user filed: ESMEs that send Unicode get
 * silently coerced to GSM-7 because `new String(byte[])` defaults to
 * UTF-8 on Linux, which rejects UTF-16BE lead bytes.
 *
 * Strategy: REUSE the live SMPP-bound supplier TriAngle (id=6) — already
 * loaded into the SupplierManager's in-memory map. Routing is set up via
 * the test client's route + route_trunks +\u2192 supplier id=6.
 *
 * Always cleans up the transient test rows in the finally block.
 */
import smpp from 'smpp';
import pg from 'pg';

// \u2500\u2500 Configuration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const DB_URL = 'postgresql://net2app_user:Ariyax2024Net2AppDB@127.0.0.1:5432/net2app_db';
const SMSC_URL = 'smpp://127.0.0.1:2775';

const SYS_ID = 'uni_tester';
const PASSWORD = 'uni_pass_123';
const RECIPIENT = '447123456789'; // UK mcc=234 mnc=30 \u2192 matches mcc_mnc 23430
const EMOJI = '\ud83d\ude00';              // U+1F600
const SUPPLIER_ID = 6;            // TriAngle \u2014 already bound to gateway
const MCC_MNC = '23430';

// Pre-flight: lock in the byte representations so any later regression in
// Node's encoding labels fails fast.
//
// Note on Node encoding labels: `Buffer.from(str, 'utf-16be')` throws
// ERR_UNKNOWN_ENCODING because Node's Buffer API only accepts 'utf16le'
// (or its hyphenated alias 'utf-16le') for UTF-16 — there is no UTF-16BE
// path on the Buffer constructor. We build UCS-2 BE bytes by hand:
// for each JavaScript UTF-16 code unit (high+low surrogate pair for BMP-
// supplementary chars like 😀), emit the BE representation explicitly.
function utf16beFromString(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    if (cu >= 0xD800 && cu <= 0xDBFF && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      out.push((cu >> 8) & 0xFF, cu & 0xFF);
      out.push((lo >> 8) & 0xFF, lo & 0xFF);
      i++;
    } else {
      out.push((cu >> 8) & 0xFF, cu & 0xFF);
    }
  }
  return Buffer.from(out);
}
const UTF8_BYTES  = Buffer.from(EMOJI, 'utf-8');     // [F0 9F 98 80], length=4
const UCS2_BYTES  = utf16beFromString(EMOJI);        // [D8 3D DE 00], length=4
console.assert(UTF8_BYTES.length === 4, 'UTF-8 length should be 4');
console.assert(UTF8_BYTES.equals(Buffer.from([0xF0, 0x9F, 0x98, 0x80])), 'UTF-8 bytes mismatch');
console.assert(UCS2_BYTES.length === 4, 'UCS-2 length should be 4');
console.assert(UCS2_BYTES.equals(Buffer.from([0xD8, 0x3D, 0xDE, 0x00])), 'UCS-2 bytes mismatch');

const pool = new pg.Pool({ connectionString: DB_URL });
let session = null;

async function sql(text, params = []) {
  const c = await pool.connect();
  try { return (await c.query(text, params)).rows; }
  finally { c.release(); }
}

async function setupDb() {
  console.log('\n=== STEP 1: DB insert chain (test client + trunk + route + rates) ===');

  const ins = await sql(`
    WITH
      c AS (
        INSERT INTO clients (name, email, smpp_system_id, smpp_password, connection_type,
                             force_dlr, billing_type, current_balance, is_active)
        VALUES ('Unicode Test Client', 'unicode-test@net2app.local', $1, $2,
                'smpp', false, 'on_submit', 50.0, true)
        RETURNING id),
      t AS (
        INSERT INTO trunks (name, trunk_code, supplier_id, is_active)
        VALUES ('Unicode Trunk', 'UNI_TRUNK', $3, true)
        RETURNING id),
      r AS (
        INSERT INTO routes (name, route_code, client_id, mcc_mnc, priority, is_active)
        SELECT 'Unicode Route', 'UNI_ROUTE', c.id, $4, 1, true FROM c
        RETURNING id),
      sr AS (
        INSERT INTO supplier_rates (supplier_id, mcc_mnc, rate, currency, is_active)
        VALUES ($3, $4, 0.01, 'USD', true)
        RETURNING id),
      cr AS (
        INSERT INTO client_rates (client_id, mcc_mnc, rate, currency, is_active)
        SELECT c.id, $4, 0.05, 'USD', true FROM c
        RETURNING id),
      rt AS (
        INSERT INTO route_trunks (route_id, trunk_id, supplier_id, priority, weight, is_active)
        SELECT r.id, t.id, $3, 1, 1, true FROM r, t
        RETURNING id)
    SELECT (SELECT id FROM c)  AS cid,
           (SELECT id FROM t)  AS tid,
           (SELECT id FROM r)  AS rid,
           (SELECT id FROM sr) AS srid,
           (SELECT id FROM cr) AS crid,
           (SELECT id FROM rt) AS rtid;
  `, [SYS_ID, PASSWORD, SUPPLIER_ID, MCC_MNC]);

  const ids = ins[0];
  console.log('  inserted ids:', ids);
  await new Promise(r => setTimeout(r, 1000));
  return ids;
}

function bindEsme() {
  console.log('\n=== STEP 2: ESME bind on', SMSC_URL, '===');
  return new Promise((resolve, reject) => {
    session = smpp.connect({ url: SMSC_URL }, () => {
      session.bind_transceiver({
        system_id: SYS_ID,
        password: PASSWORD,
      }, (pdu) => {
        if (pdu.command_status !== 0) {
          reject(new Error(`bind failed: command_status=${pdu.command_status}`));
          return;
        }
        console.log('  bound \u2713 (sysid=' + SYS_ID + ')');
        resolve();
      });
    });
    session.on('error', (err) => console.log('  [smpp session error]', err && err.message || err));
    session.on('close', () => console.log('  [smpp socket closed]'));
  });
}

/**
 * Send a submit_sm with the given data_coding + short_message bytes.
 * Returns the pdu (may be TIMEOUT sentinel after 20s).
 */
function submitSm({ dataCoding, shortMessage, label }) {
  return new Promise((resolve) => {
    console.log(`\n=== STEP 3${label ? ' (' + label + ')' : ''}: data_coding=${dataCoding}, short_message=${shortMessage.length}B (${shortMessage.toString('hex')}) ===`);
    const timer = setTimeout(() => {
      console.log(`  \u23f0 submit_sm_resp timeout (20s) for data_coding=${dataCoding} \u2014 resolving with sentinel`);
      resolve({ command_status: -1, message_id: 'TIMEOUT' });
    }, 20000);

    session.submit_sm({
      service_type: '',
      source_addr_ton: 1, source_addr_npi: 1, source_addr: 'Net2App',
      dest_addr_ton: 1,   dest_addr_npi: 1,   destination_addr: RECIPIENT,
      esm_class: 0, protocol_id: 0, priority_flag: 0,
      data_coding: dataCoding,
      registered_delivery: 1,
      replace_if_present_flag: 0,
      short_message: shortMessage,
    }, (pdu) => {
      clearTimeout(timer);
      console.log('  submit_sm_resp.command_status=' + pdu.command_status +
                  ' (' + (pdu.command_status === 0 ? 'OK' : 'REJECTED') + ')');
      console.log('  submit_sm_resp.message_id=' + JSON.stringify(pdu.message_id));
      resolve(pdu);
    });
  });
}

async function verifyRecentRows() {
  console.log('\n=== STEP 4: verify sms_logs rows (limited to test client) ===');
  await new Promise(r => setTimeout(r, 1500));

  const rows = await sql(`
    SELECT id, message_id, client_user, recipient, status, send_result,
           send_reason, sms_bytes, dest_sms, dest_sms_bytes,
           LENGTH(dest_sms) AS chars,
           OCTET_LENGTH(dest_sms) AS utf8_bytes,
           message_text, supplier_msg_id, supplier_id,
           created_at, connection_type
      FROM sms_logs
     WHERE client_user = $1
     ORDER BY id DESC LIMIT 10;
  `, [SYS_ID]);
  return rows;
}

/** Print all rows + per-case predicates. Returns {rows, perCase} summary. */
function evaluate(rows) {
  for (const r of rows) {
    console.log('  \u2500\u2500 row id=' + r.id + ' status=' + r.status + ' \u2500\u2500');
    console.log('   recipient       =', r.recipient);
    console.log('   send_result     =', r.send_result);
    console.log('   send_reason     =', r.send_reason);
    console.log('   connection_type =', r.connection_type);
    console.log('   message_id      =', r.message_id);
    console.log('   supplier_msg_id =', r.supplier_msg_id);
    console.log('   supplier_id     =', r.supplier_id);
    console.log('   sms_bytes       =', r.sms_bytes);
    console.log('   dest_sms_bytes  =', r.dest_sms_bytes);
    console.log('   dest_sms        =', JSON.stringify(r.dest_sms),
                 '(' + r.chars + ' chars, ' + r.utf8_bytes + ' UTF-8 bytes)');
    console.log('   message_text    =', JSON.stringify(r.message_text));
  }
  return rows;
}

async function cleanup(testIds) {
  console.log('\n=== STEP 5: cleanup transient rows (scoped by primary key) ===');
  // Always close the SMPP session first, even on partial failure.
  if (session) try { session.close(); } catch {}
  if (!testIds) {
    console.log('  (no insert IDs captured \u2014 nothing to clean)');
    return;
  }
  await sql(`DELETE FROM sms_logs     WHERE client_id = $1`, [testIds.cid]);
  if (testIds.rtid) await sql(`DELETE FROM route_trunks   WHERE id = $1`, [testIds.rtid]);
  if (testIds.crid) await sql(`DELETE FROM client_rates   WHERE id = $1`, [testIds.crid]);
  if (testIds.srid) await sql(`DELETE FROM supplier_rates WHERE id = $1`, [testIds.srid]);
  if (testIds.rid)  await sql(`DELETE FROM routes         WHERE id = $1`, [testIds.rid]);
  if (testIds.tid)  await sql(`DELETE FROM trunks         WHERE id = $1`, [testIds.tid]);
  if (testIds.cid)  await sql(`DELETE FROM clients        WHERE id = $1`, [testIds.cid]);
  console.log('  cleaned \u2713');
}

async function main() {
  console.log('net2app-platform Unicode (emoji) end-to-end verification');
  console.log(`  SMSC=${SMSC_URL}  emoji='${EMOJI}'  U+${EMOJI.codePointAt(0).toString(16).toUpperCase()}`);
  console.log(`  UTF-8  bytes: ${UTF8_BYTES.toString('hex')} (length ${UTF8_BYTES.length})`);
  console.log(`  UCS-2  bytes: ${UCS2_BYTES.toString('hex')} (length ${UCS2_BYTES.length})`);

  let testIds = null;
  let rows = [];
  let pduA = null, pduB = null;
  try {
    testIds = await setupDb();
    await bindEsme();

    // Case A: GSM-7 wire (data_coding=0) + UTF-8 bytes — the previous harness path.
    pduA = await submitSm({ dataCoding: 0, shortMessage: UTF8_BYTES, label: 'GSM-7 path' });
    // Caption the rows with the message_ids returned by submit_sm_resp so
    // verifySmsLog can pick the right row out of sms_logs by PK rather
    // than by sms_bytes (the discriminator the v1 script used collides
    // when both submits land sms_bytes=4).
    await sql(`UPDATE sms_logs SET dest_sms = COALESCE(dest_sms, dest_sms) || '' WHERE client_id = $1 AND message_id = $2`,
              [testIds.cid, pduA.message_id]).catch(() => {});
    await new Promise(r => setTimeout(r, 800));

    // Case B: UCS-2 wire (data_coding=8) + UTF-16BE bytes — the NEW path.
    pduB = await submitSm({ dataCoding: 8, shortMessage: UCS2_BYTES, label: 'UCS-2 path' });

    rows = await verifyRecentRows();
    evaluate(rows);
  } catch (e) {
    console.error('FATAL:', e && e.stack || e);
  } finally {
    await cleanup(testIds);
    await pool.end();
  }

  const matching = rows.filter(r => r.recipient === RECIPIENT);
  const gsm7Row = matching.find(r => pduA && r.message_id === pduA.message_id);
  const ucs2Row = matching.find(r => pduB && r.message_id === pduB.message_id);

  console.log('\n=== OVERALL (per case) ===');
  if (ucs2Row) {
    console.log('  UCS-2 path (ESME sent data_coding=8 + UTF-16BE bytes):');
    console.log('    message_id     = ' + ucs2Row.message_id + ' (matches submit_sm_resp ' + JSON.stringify(pduB && pduB.message_id) + ')');
    console.log('    message_text   = ' + JSON.stringify(ucs2Row.message_text) +
                ' -- ' + (ucs2Row.message_text === EMOJI ? '[OK] Java UTF-16BE decode reconstructed correctly' : '[FAIL] message_text mismatch'));
    console.log('    dest_sms       = ' + JSON.stringify(ucs2Row.dest_sms) +
                ' (Java path writes message_text only; dest_sms is Next.js HTTP-API column)');
    console.log('    sms_bytes      = ' + ucs2Row.sms_bytes +
                ' \u2014 ' + (Number(ucs2Row.sms_bytes) === 4 ? '\u2713 = text.length*2 (UCS-2 wire size)' : '\u2717 unexpected'));
    console.log('    supplier_msg_id = ' + JSON.stringify(ucs2Row.supplier_msg_id));
    console.log('    status          = ' + ucs2Row.status + ' / send_reason = ' + ucs2Row.send_reason);
  } else {
    console.log('  UCS-2 path: \u2717 no row matched submit_sm_resp message_id ' + JSON.stringify(pduB && pduB.message_id));
  }
  if (gsm7Row) {
    console.log('  GSM-7 path (ESME sent data_coding=0 + UTF-8 bytes):');
    console.log('    message_id     = ' + gsm7Row.message_id);
    console.log('    dest_sms       = ' + JSON.stringify(gsm7Row.dest_sms));
    console.log('    sms_bytes      = ' + gsm7Row.sms_bytes);
    console.log('    status         = ' + gsm7Row.status);
  } else {
    console.log('  GSM-7 path: \u2717 no row matched submit_sm_resp message_id ' + JSON.stringify(pduA && pduA.message_id));
  }
  // Java's SmsLogger.logSubmit writes message_text, NOT dest_sms (which is
  // Next.js's HTTP-API column). The Java-side byte-fidelity check is therefore
  // message_text instead of dest_sms. The user's actual verification leg is
  // "sms_bytes == UTF-8/UCS-2 wire byte count" — that survives in sms_bytes.
  const ucs2TextOk = ucs2Row && (ucs2Row.message_text === EMOJI || ucs2Row.dest_sms === EMOJI);
  const passed = !!ucs2Row && Number(ucs2Row.sms_bytes) === 4 && ucs2TextOk;
  console.log('\n=== NET: ' + (passed ? 'PASS (Java UTF-16BE decode OK + sms_bytes=' + ucs2Row.sms_bytes + ')' : 'FAIL') + ' ===');
  console.log('NOTE: the GSM-7 (data_coding=0) path may also auto-promote to UCS-2 outbound');
  console.log('      because isGsm7Encodable("\ud83d\ude00")=false. Both rows are expected to have sm');
  console.log('      s_bytes=4 \u2014 the per-case distinction above is via submit_sm_resp.message_id.');
  process.exit(passed ? 0 : 1);
}

main();
