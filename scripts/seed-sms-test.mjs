import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const pool = new pg.Pool({
  connectionString: 'postgresql://net2app_user:Ariyax2024Net2AppDB@127.0.0.1:5432/net2app_db',
});

function generateMessageId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = uuidv4().replace(/-/g, '').substring(0, 10).toUpperCase();
  return `N2A${timestamp}${random}`;
}

async function main() {
  const client = await pool.connect();
  try {
    // Get existing clients and suppliers
    const { rows: clients } = await client.query('SELECT id, name, client_code, is_active FROM clients WHERE is_active = true');
    const { rows: suppliers } = await client.query('SELECT id, name, supplier_code, is_active FROM suppliers WHERE is_active = true');
    const { rows: operators } = await client.query("SELECT id, name, mcc_mnc, mcc, mnc FROM operators LIMIT 10");
    
    console.log(`Found ${clients.length} active clients, ${suppliers.length} active suppliers, ${operators.length} operators`);
    
    if (clients.length === 0 || suppliers.length === 0) {
      console.log('Need at least 1 client and 1 supplier. Run the seed API first.');
      return;
    }

    // Generate SMS data over the last 7 days
    const now = new Date();
    const statuses = ['delivered', 'delivered', 'delivered', 'delivered', 'delivered', 'submitted', 'failed', 'rejected'];
    const sendResults = ['success', 'success', 'success', 'success', 'success', 'success', 'failed', 'failed'];
    const deliverResults = ['delivered', 'delivered', 'delivered', 'delivered', 'delivered', null, null, null];
    const srcTypes = ['HTTP', 'HTTP', 'HTTP', 'HTTP', 'SMPP', 'HTTP', 'HTTP', 'TEST'];
    const encodings = ['GSM-7', 'GSM-7', 'GSM-7', 'GSM-7', 'GSM-7', 'GSM-7', 'UCS-2', 'GSM-7'];
    const msgTypes = ['SMS', 'SMS', 'SMS', 'SMS', 'SMS', 'SMS', 'UNICODE', 'SMS'];
    
    const sampleMessages = [
      'Your OTP is 482917. Valid for 5 minutes.',
      'Dear customer, your order #ORD-2847 has been shipped.',
      'Payment of $45.00 received. Thank you!',
      'Reminder: Your appointment is tomorrow at 2:00 PM.',
      'Welcome to Net2App! Enjoy 10% off your first purchase.',
      'Alert: Unusual login detected from new device.',
      'আপনার অ্যাকাউন্টে ৫০০ টাকা যোগ হয়েছে।',
      'Your ticket #TK-882 has been resolved. Rate our service!',
    ];

    const rates = [0.0025, 0.003, 0.0035, 0.004, 0.005, 0.006];
    const phonePrefixes = ['88017', '88018', '88016', '88015', '88019', '88013', '88014', '88011'];
    
    let inserted = 0;
    const batchSize = 100;
    const totalToInsert = 500;

    console.log(`Generating ${totalToInsert} test SMS entries...`);

    for (let i = 0; i < totalToInsert; i++) {
      const daysAgo = Math.floor(Math.random() * 7);
      const hoursAgo = Math.random() * 24;
      const createdAt = new Date(now.getTime() - (daysAgo * 86400000) - (hoursAgo * 3600000));
      
      const clientEntry = clients[Math.floor(Math.random() * clients.length)];
      const supplierEntry = suppliers[Math.floor(Math.random() * suppliers.length)];
      const operatorEntry = operators.length > 0 ? operators[Math.floor(Math.random() * operators.length)] : null;
      
      const statusIdx = Math.floor(Math.random() * statuses.length);
      const status = statuses[statusIdx];
      const sendResult = sendResults[statusIdx];
      const deliverResult = deliverResults[statusIdx];
      const srcType = srcTypes[Math.floor(Math.random() * srcTypes.length)];
      const encoding = encodings[Math.floor(Math.random() * encodings.length)];
      const msgType = msgTypes[Math.floor(Math.random() * msgTypes.length)];
      const message = sampleMessages[Math.floor(Math.random() * sampleMessages.length)];
      
      const isGsm7 = encoding === 'GSM-7';
      const maxSingle = isGsm7 ? 160 : 70;
      const maxMulti = isGsm7 ? 153 : 67;
      const parts = message.length <= maxSingle ? 1 : Math.ceil(message.length / maxMulti);
      const smsBytes = isGsm7 ? Math.ceil((message.length * 7) / 8) : message.length * 2;
      
      const clientRateVal = rates[Math.floor(Math.random() * rates.length)];
      const supplierRateVal = rates[Math.floor(Math.random() * Math.floor(rates.length * 0.7))]; // supplier cheaper
      const cost = parseFloat((supplierRateVal * parts).toFixed(6));
      const pay = parseFloat((clientRateVal * parts).toFixed(6));
      const profit = parseFloat((pay - cost).toFixed(6));
      
      const phone = phonePrefixes[Math.floor(Math.random() * phonePrefixes.length)] + 
        String(Math.floor(Math.random() * 9000000) + 1000000);
      
      const sendTime = new Date(createdAt.getTime() - 5000);
      const deliverTime = status === 'delivered' ? new Date(createdAt.getTime() + 3000) : null;
      const duration = Math.floor(Math.random() * 5000) + 500;
      const deliverDuration = deliverTime ? Math.floor((deliverTime.getTime() - sendTime.getTime()) / 1000) : null;
      
      const submitSuccess = status === 'delivered' || status === 'submitted' ? 1 : 0;
      const submitFail = status === 'failed' || status === 'rejected' ? 1 : 0;
      const deliverSuccess = status === 'delivered' ? 1 : 0;
      const deliverFail = status === 'failed' ? 1 : 0;

      await client.query(`
        INSERT INTO sms_logs (
          message_id, client_id, client_user, client_alias, src_type,
          supplier_id, supplier_user, route_name, channel, device,
          msg_type, business_type, send_type, sender, ori_receiver, recipient, dst_receiver,
          message_text, dest_sms, sms_bytes, dest_sms_bytes, parts, charged_points,
          status, submit_success, submit_fail, deliver_success, deliver_fail,
          send_result, deliver_result, dlr_status,
          mcc, mnc, country_id, operator_id,
          in_msg_id, out_msg_id, supplier_msg_id,
          client_rate, supplier_rate, cost, pay, profit,
          send_time, deliver_time, done_time, duration, deliver_duration,
          connection_type, direction, ip_address,
          submit_timestamp, created_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23,
          $24, $25, $26, $27, $28,
          $29, $30, $31,
          $32, $33, $34, $35,
          $36, $37, $38,
          $39, $40, $41, $42, $43,
          $44, $45, $46, $47, $48,
          $49, $50, $51,
          $52, $53
        )
      `, [
        generateMessageId(),
        clientEntry.id,
        clientEntry.client_code || clientEntry.name,
        clientEntry.name,
        srcType,
        supplierEntry.id,
        supplierEntry.supplier_code || supplierEntry.name,
        'Default',
        'Direct',
        supplierEntry.name,
        msgType,
        encoding === 'UCS-2' ? 'Unicode SMS' : 'GSM-7 SMS',
        'Device',
        'Net2App',
        phone,
        phone,
        phone,
        message,
        message,
        smsBytes,
        smsBytes,
        parts,
        parts,
        status,
        submitSuccess,
        submitFail,
        deliverSuccess,
        deliverFail,
        sendResult,
        deliverResult,
        status === 'delivered' ? 'delivered' : null,
        operatorEntry?.mcc || '470',
        operatorEntry?.mnc || '01',
        operatorEntry ? 1 : null,
        operatorEntry?.id || null,
        Date.now().toString(),
        `OUT-${Date.now()}`,
        `SUP-${Date.now()}`,
        String(clientRateVal),
        String(supplierRateVal),
        String(status === 'failed' || status === 'rejected' ? 0 : cost),
        String(status === 'failed' || status === 'rejected' ? 0 : pay),
        String(status === 'failed' || status === 'rejected' ? 0 : profit),
        sendTime,
        deliverTime,
        createdAt,
        duration,
        deliverDuration,
        'http',
        'mt',
        '127.0.0.1',
        sendTime,
        createdAt,
      ]);

      inserted++;
      if (inserted % 50 === 0) console.log(`  Inserted ${inserted}/${totalToInsert}...`);
    }

    console.log(`\nDone! Inserted ${inserted} test SMS entries.`);

    // Show summary
    const { rows: counts } = await client.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN status = 'submitted' THEN 1 END) as submitted,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected,
        ROUND(SUM(CAST(pay AS numeric))::numeric, 4) as total_revenue,
        ROUND(SUM(CAST(cost AS numeric))::numeric, 4) as total_cost,
        ROUND(SUM(CAST(profit AS numeric))::numeric, 4) as total_profit,
        MIN(created_at) as first_sms,
        MAX(created_at) as last_sms
      FROM sms_logs
    `);

    const c = counts[0];
    console.log('\nDatabase Summary:');
    console.log(`  Total SMS:    ${c.total}`);
    console.log(`  Delivered:    ${c.delivered}`);
    console.log(`  Submitted:    ${c.submitted}`);
    console.log(`  Failed:       ${c.failed}`);
    console.log(`  Rejected:     ${c.rejected}`);
    console.log(`  Revenue:      $${c.total_revenue}`);
    console.log(`  Cost:         $${c.total_cost}`);
    console.log(`  Profit:       $${c.total_profit}`);
    console.log(`  Date range:   ${new Date(c.first_sms).toLocaleDateString()} - ${new Date(c.last_sms).toLocaleDateString()}`);

  } catch (e) {
    console.error('Error:', e.message);
    if (e.message.includes('relation "sms_logs" does not exist')) {
      console.log('sms_logs table does not exist. Run migrations first: npx drizzle-kit push');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main();
