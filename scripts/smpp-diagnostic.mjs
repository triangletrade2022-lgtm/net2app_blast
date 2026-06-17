#!/usr/bin/env node
/**
 * SMPP Diagnostic Tool
 * ====================
 * Tests different bind configurations against an SMPP server
 * to identify exactly why connection fails.
 *
 * Usage: node scripts/smpp-diagnostic.mjs <host> <port> <system_id> <password>
 * Example: node scripts/smpp-diagnostic.mjs 145.239.1.103 2775 99551133 test123
 */

import * as smpp from 'smpp';

const [,, host, port, systemId, password] = process.argv;

if (!host || !port || !systemId || !password) {
  console.log('Usage: node smpp-diagnostic.mjs <host> <port> <system_id> <password>');
  console.log('Example: node smpp-diagnostic.mjs 145.239.1.103 2775 99551133 test123');
  process.exit(1);
}

const PORT = parseInt(port, 10);
const TIMEOUT_MS = 8000;

function statusName(code) {
  const map = {
    0: 'ESME_ROK',
    1: 'ESME_RINVMSGLEN',
    2: 'ESME_RINVCMDLEN',
    3: 'ESME_RINVCMDID',
    4: 'ESME_RINVBNDSTS',
    5: 'ESME_RINVRSVPAD',
    6: 'ESME_RINVSRCADR',
    7: 'ESME_RINVDSTADR',
    10: 'ESME_RINVPRTFLG',
    13: 'ESME_RBINDFAIL',
    14: 'ESME_RINVESMCLASS',
    15: 'ESME_RINVSERTYP',
  };
  return map[code] || `UNKNOWN(0x${code.toString(16).padStart(8, '0')})`;
}

async function testBind(bindEvent, options, label) {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST: ${label}`);
    console.log(`  Bind type: ${bindEvent}`);
    console.log(`  Options: ${JSON.stringify(options, null, 2).replace(/\n/g, '\n    ')}`);
    console.log(`${'='.repeat(60)}`);

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.log(`  ❌ TIMEOUT after ${TIMEOUT_MS}ms`);
        session.close();
        resolve({ success: false, error: 'TIMEOUT' });
      }
    }, TIMEOUT_MS);

    let session;
    try {
      session = smpp.connect({ url: `smpp://${host}:${PORT}` }, () => {
        console.log(`  ✅ TCP connected to ${host}:${PORT}`);

        // Log the PDU being sent
        const pdu = new smpp.PDU(bindEvent, options);
        console.log(`  📤 Sending ${bindEvent} PDU:`);
        console.log(`     system_id: "${options.system_id}"`);
        console.log(`     password: "${options.password}"`);
        console.log(`     system_type: "${options.system_type || ''}"`);
        console.log(`     interface_version: 0x${(options.interface_version || 0x34).toString(16)}`);
        console.log(`     addr_ton: ${options.addr_ton ?? 'not set'}`);
        console.log(`     addr_npi: ${options.addr_npi ?? 'not set'}`);
        console.log(`     addr_range: "${options.addr_range || ''}"`);

        session.send(pdu, (resp) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);

          console.log(`  📥 Response received:`);
          console.log(`     command_status: ${resp.command_status} (${statusName(resp.command_status)})`);
          console.log(`     command_id: ${resp.command_id}`);

          // Log ALL response fields
          for (const [key, val] of Object.entries(resp)) {
            if (!['command_id', 'command_status', 'sequence_number'].includes(key)) {
              const display = Buffer.isBuffer(val) ? val.toString('hex') : val;
              console.log(`     ${key}: ${display}`);
            }
          }

          if (resp.command_status === 0) {
            console.log(`  ✅ BIND SUCCESS!`);
            session.close();
            resolve({ success: true });
          } else {
            console.log(`  ❌ BIND FAILED: ${statusName(resp.command_status)}`);
            session.close();
            resolve({ success: false, error: statusName(resp.command_status) });
          }
        });
      });

      session.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          console.log(`  ❌ TCP ERROR: ${err.message}`);
          resolve({ success: false, error: err.message });
        }
      });

      session.on('close', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          console.log(`  ❌ Connection closed`);
          resolve({ success: false, error: 'CONNECTION_CLOSED' });
        }
      });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        console.log(`  ❌ EXCEPTION: ${err.message}`);
        resolve({ success: false, error: err.message });
      }
    }
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        SMPP Diagnostic Tool — Testing Bind Configs     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Target: ${host}:${PORT}`);
  console.log(`System ID: ${systemId}`);

  // Test 1: Default config (what the current code sends)
  const r1 = await testBind('bind_transceiver', {
    system_id: systemId,
    password: password,
    system_type: '',
    interface_version: 0x34,
    addr_ton: 1,
    addr_npi: 1,
  }, 'Default (current code) — bind_transceiver');

  // Test 2: Without explicit TON/NPI
  const r2 = await testBind('bind_transceiver', {
    system_id: systemId,
    password: password,
    system_type: '',
    interface_version: 0x34,
  }, 'Without TON/NPI — bind_transceiver');

  // Test 3: bind_transmitter (some servers don't support transceiver)
  const r3 = await testBind('bind_transmitter', {
    system_id: systemId,
    password: password,
    system_type: '',
    interface_version: 0x34,
    addr_ton: 1,
    addr_npi: 1,
  }, 'bind_transmitter with TON/NPI');

  // Test 4: bind_transmitter without TON/NPI
  const r4 = await testBind('bind_transmitter', {
    system_id: systemId,
    password: password,
    system_type: '',
    interface_version: 0x34,
  }, 'bind_transmitter without TON/NPI');

  // Test 5: bind_transceiver with interface_version 0x34 (explicit)
  const r5 = await testBind('bind_transceiver', {
    system_id: systemId,
    password: password,
    system_type: '',
    interface_version: 0x34,
    addr_ton: 0,
    addr_npi: 0,
  }, 'bind_transceiver with NPI/NPI=0 (UNKNOWN)');

  // Test 6: With addr_range
  const r6 = await testBind('bind_transceiver', {
    system_id: systemId,
    password: password,
    system_type: '',
    interface_version: 0x34,
    addr_ton: 0,
    addr_npi: 0,
    addr_range: '',
  }, 'bind_transceiver with addr_range');

  // Test 7: interface_version 0x00 (no version declared)
  const r7 = await testBind('bind_transceiver', {
    system_id: systemId,
    password: password,
    system_type: '',
    interface_version: 0x00,
    addr_ton: 1,
    addr_npi: 1,
  }, 'bind_transceiver with interface_version=0x00');

  console.log('\n\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  const results = [
    { label: 'Default (current code)', result: r1 },
    { label: 'Without TON/NPI', result: r2 },
    { label: 'bind_transmitter + TON/NPI', result: r3 },
    { label: 'bind_transmitter no TON/NPI', result: r4 },
    { label: 'TON/NPI=0 (UNKNOWN)', result: r5 },
    { label: 'With addr_range', result: r6 },
    { label: 'interface_version=0x00', result: r7 },
  ];
  for (const { label, result } of results) {
    const icon = result.success ? '✅' : '❌';
    console.log(`  ${icon} ${label}: ${result.error || 'SUCCESS'}`);
  }

  // Find which configs worked
  const successes = results.filter(r => r.result.success);
  if (successes.length > 0) {
    console.log('\n🎯 Working configuration(s) found! Use this in your supplier config.');
  } else {
    console.log('\n⚠️  No bind configurations worked.');
    console.log('    This could mean:');
    console.log('    1. The credentials are wrong (system_id/password mismatch)');
    console.log('    2. The server requires specific TLVs not sent here');
    console.log('    3. The server has a different SMPP version than 3.4');
    console.log('    4. Contact your supplier and ask what bind parameters they require.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
