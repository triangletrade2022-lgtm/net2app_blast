#!/usr/bin/env python3
"""
Net2App Blast - SMPP Gateway Server (v3)
=========================================
- ESMC: Uses smppy.Application for clean, stable PDU handling
- SMSC: Connects to external suppliers via smpp.pdu over TCP
- REST API bridge on port 9000
- Keeps bind up 24/7 with auto-reconnect + keepalive
"""

import asyncio
import io
import json
import logging
import os
import signal
import socket
import struct
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Event, Thread
from typing import Optional

from smppy import Application, SmppClient
from smppy.server import SmppProtocol
from smpp.pdu.operations import (
    BindTransceiver, SubmitSM, EnquireLink, Unbind, DeliverSM,
    BindTransceiverResp, UnbindResp, SubmitSMResp,
)
from smpp.pdu.pdu_encoding import PDUEncoder
from smpp.pdu.pdu_types import (
    CommandId, CommandStatus, AddrTon, AddrNpi,
    EsmClassMode, EsmClass, EsmClassType,
    RegisteredDelivery, RegisteredDeliveryReceipt,
    PriorityFlag, ReplaceIfPresentFlag,
    DataCodingDefault, DataCoding,
)
from smpp.pdu.sm_encoding import SMStringEncoder

os.makedirs('/home/ubuntu/net2app-platform/logs', exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[
        logging.FileHandler('/home/ubuntu/net2app-platform/logs/smpp_server.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('Net2App-SMPP')

DB_CONFIG = {
    'host': '127.0.0.1', 'port': 5432,
    'dbname': 'net2app_db', 'user': 'net2app_user',
    'password': 'Ariyax2024Net2AppDB',
}

SMPP_CONFIG = {
    'server_host': '0.0.0.0', 'server_port': 2775,
    'supplier_host': '5.78.72.23', 'supplier_port': 2775,
    'supplier_system_id': 'net2hub', 'supplier_password': 'net2hub',
}


# ─── Helper: nested field access for JSON response parsing ───
def _get_field(obj, field):
    """Access nested field in JSON response. Supports dict keys and array indices."""
    parts = str(field).split('.')
    current = obj
    for p in parts:
        if current is None:
            return None
        try:
            idx = int(p)
            if isinstance(current, (list, tuple)):
                current = current[idx] if 0 <= idx < len(current) else None
            else:
                return None
        except (ValueError, TypeError):
            if isinstance(current, dict):
                current = current.get(p, None)
            else:
                return None
    return current


class DatabaseBridge:
    """PostgreSQL bridge for the SMPP server."""

    def __init__(self):
        import psycopg2
        self.psycopg2 = psycopg2
        self.conn = None
        self._connect()

    def _connect(self):
        try:
            self.conn = self.psycopg2.connect(**DB_CONFIG)
            self.conn.autocommit = True
            logger.info("DB connected")
        except Exception as e:
            logger.error(f"DB connection failed: {e}")
            raise

    def ensure(self):
        try:
            self.conn.cursor().execute("SELECT 1")
        except:
            try:
                self._connect()
            except:
                pass

    def _fetchone(self, sql, params=None):
        self.ensure()
        cur = self.conn.cursor()
        cur.execute(sql, params or ())
        row = cur.fetchone()
        desc = [d[0] for d in cur.description] if cur.description else []
        return row, desc

    def _fetchall(self, sql, params=None):
        self.ensure()
        cur = self.conn.cursor()
        cur.execute(sql, params or ())
        return cur.fetchall()

    def _execute(self, sql, params=None):
        self.ensure()
        cur = self.conn.cursor()
        cur.execute(sql, params or ())

    def _insert_returning(self, sql, params=None):
        self.ensure()
        cur = self.conn.cursor()
        cur.execute(sql, params or ())
        return cur.fetchone()[0]

    def auth_client(self, system_id, password):
        row, desc = self._fetchone(
            "SELECT id, name, client_code, smpp_system_id, smpp_password, "
            "smpp_host, smpp_port, max_tps, is_active, "
            "current_balance, credit_limit, billing_type, "
            "force_dlr, force_dlr_status, dlr_callback_url "
            "FROM clients "
            "WHERE smpp_system_id=%s AND smpp_password=%s AND is_active=true AND connection_type='smpp'",
            (system_id, password))
        return dict(zip(desc, row)) if row else None

    def get_route(self, client_id, mcc_mnc):
        row, desc = self._fetchone("""
            SELECT r.id as route_id, r.name as route_name,
                   rt.trunk_id, t.name as trunk_name,
                   rt.supplier_id, s.name as supplier_name,
                   s.connection_type as supplier_conn_type,
                   s.smpp_host, s.smpp_port, s.smpp_system_id, s.smpp_password,
                   s.force_dlr, s.force_dlr_status
            FROM routes r
            JOIN route_trunks rt ON rt.route_id=r.id AND rt.is_active=true
            JOIN trunks t ON t.id=rt.trunk_id AND t.is_active=true
            JOIN suppliers s ON s.id=rt.supplier_id AND s.is_active=true
            WHERE r.client_id=%s AND r.is_active=true
            ORDER BY r.priority ASC, rt.priority ASC LIMIT 1""", (client_id,))
        if row:
            return dict(zip(desc, row))

    def get_rate(self, table, entity_id, mcc_mnc):
        row, desc = self._fetchone(
            f"SELECT rate::numeric FROM {table} WHERE "
            f"{'client_id' if table=='client_rates' else 'supplier_id'}=%s "
            f"AND (mcc_mnc=%s OR mcc_mnc IS NULL) AND is_active=true "
            f"ORDER BY mcc_mnc=%s DESC LIMIT 1",
            (entity_id, mcc_mnc, mcc_mnc))
        return float(row[0]) if row else 0.0

    def deduct_balance(self, table, entity_id, amount):
        row, desc = self._fetchone(
            f"SELECT current_balance::numeric, credit_limit::numeric FROM {table} WHERE id=%s",
            (entity_id,))
        if not row:
            return
        bal, cred = float(row[0]), float(row[1])
        rem = amount
        if bal >= rem:
            bal -= rem
            rem = 0
        else:
            rem -= bal
            bal = 0
            cred = max(0, cred - rem)
        self._execute(
            f"UPDATE {table} SET current_balance=%s, credit_limit=%s, updated_at=NOW() WHERE id=%s",
            (str(bal), str(cred), entity_id))

    def log_sms(self, d):
        log_id = self._insert_returning("""
            INSERT INTO sms_logs (
                message_id, client_id, client_user, client_alias, src_type,
                supplier_id, supplier_user, route_id, route_name, trunk_id, channel, device,
                sender, recipient, message_text, parts, charged_points,
                status, submit_success, submit_fail, send_result, send_reason,
                mcc, mnc, in_msg_id, out_msg_id, supplier_msg_id,
                client_rate, supplier_rate, cost, pay, profit,
                send_time, done_time, duration, connection_type, direction, ip_address
            ) VALUES (
                %(mid)s, %(cid)s, %(cu)s, %(ca)s, 'SMPP',
                %(sid)s, %(su)s, %(rid)s, %(rn)s, %(tid)s, %(ch)s, %(dv)s,
                %(se)s, %(re)s, %(mt)s, %(pa)s, %(pa)s,
                %(st)s, %(ss)s, %(sf)s, %(sr)s, %(srn)s,
                %(mc)s, %(mn)s, %(imi)s, %(omi)s, %(smi)s,
                %(cr)s, %(sr2)s, %(co)s, %(py)s, %(pr)s,
                %(snt)s, %(dnt)s, %(du)s, 'smpp', 'mt', %(ip)s
            ) RETURNING id""", {
            'mid': d['message_id'], 'cid': d['client_id'], 'cu': d['client_user'],
            'ca': d.get('client_alias', ''), 'sid': d['supplier_id'],
            'su': d.get('supplier_user', ''), 'rid': d.get('route_id'),
            'rn': d.get('route_name', ''), 'tid': d.get('trunk_id'),
            'ch': d.get('channel', ''), 'dv': d.get('device', ''),
            'se': d['sender'], 're': d['recipient'], 'mt': d['message_text'],
            'pa': d.get('parts', 1), 'st': d.get('status', 'submitted'),
            'ss': 1, 'sf': 0, 'sr': 'success', 'srn': 'success',
            'mc': d.get('mcc', ''), 'mn': d.get('mnc', ''),
            'imi': str(d.get('in_msg_id', '')), 'omi': d.get('out_msg_id', ''),
            'smi': d.get('supplier_msg_id', ''),
            'cr': str(d.get('client_rate', 0)), 'sr2': str(d.get('supplier_rate', 0)),
            'co': str(d.get('cost', 0)), 'py': str(d.get('pay', 0)),
            'pr': str(d.get('profit', 0)),
            'snt': datetime.now(), 'dnt': datetime.now(), 'du': 0,
            'ip': d.get('ip_address', ''),
        })
        self._execute("UPDATE license SET current_usage=COALESCE(current_usage,0)+%s, updated_at=NOW() WHERE is_active=true",
                      (d.get('parts', 1),))
        return log_id

    def update_dlr(self, msg_id, dlr_status):
        now = datetime.now()
        ok = dlr_status.lower() in ('delivered', 'delivrd', 'success')
        self._execute("""
            UPDATE sms_logs SET dlr_status=%s,
                status=CASE WHEN %s THEN 'delivered'::sms_status ELSE 'failed'::sms_status END,
                deliver_time=%s, done_time=%s, deliver_result=%s,
                deliver_success=CASE WHEN %s THEN 1 ELSE 0 END,
                deliver_fail=CASE WHEN %s THEN 0 ELSE 1 END
            WHERE message_id=%s""",
            (dlr_status, ok, now, now, dlr_status, ok, ok, msg_id))

    def queue_dlr(self, log_id, msg_id, client_id, supplier_id, status):
        self._execute(
            "INSERT INTO dlr_queue (sms_log_id, message_id, client_id, supplier_id, dlr_status, direction) "
            "VALUES (%s,%s,%s,%s,%s,'supplier_to_client')",
            (log_id, msg_id, client_id, supplier_id, status))

    def set_bind_status(self, table, entity_id, status, system_id=None, addr=None):
        self._execute(f"UPDATE {table} SET smpp_bind_status=%s, updated_at=NOW() WHERE id=%s", (status, entity_id))
        self._execute(
            "INSERT INTO smpp_sessions (entity_type, entity_id, system_id, bind_status, bind_type, remote_address, last_activity) "
            "VALUES (%s,%s,%s,%s,'transceiver',%s,NOW()) "
            "ON CONFLICT (id) DO UPDATE SET bind_status=%s, last_activity=NOW()",
            ('client' if table == 'clients' else 'supplier', entity_id, system_id, status, addr, status))


# ─── SMSC Supplier Client (using smpp.pdu directly) ───
class SmppSupplierClient:
    """TCP-based SMSC supplier using smpp.pdu for PDU encoding/decoding."""

    def __init__(self, host, port, system_id, password):
        self.host = host
        self.port = port
        self.system_id = system_id
        self.password = password
        self.sock: Optional[socket.socket] = None
        self.connected = False
        self._seq = 1
        self._encoder = PDUEncoder()
        self._read_buf = b''

    def next_seq(self):
        s = self._seq
        self._seq += 1
        return s

    def connect_and_bind(self):
        """Connect TCP and send bind_transceiver. Returns True on success."""
        try:
            self.sock = socket.create_connection((self.host, self.port), timeout=10)
            self.sock.settimeout(30)

            pdu = BindTransceiver(
                sequence_number=self.next_seq(),
                system_id=self.system_id,
                password=self.password,
                system_type='',
                interface_version=0x34,
                addr_ton=AddrTon.UNKNOWN,
                addr_npi=AddrNpi.UNKNOWN,
            )
            self.sock.sendall(self._encoder.encode(pdu))
            logger.debug("SMSC: sent bind_transceiver")

            resp = self._read_pdu()
            if resp is None:
                return False

            if resp.command_id == CommandId.bind_transceiver_resp:
                status = getattr(resp, 'status', CommandStatus.ESME_ROK)
                if status == CommandStatus.ESME_ROK:
                    self.connected = True
                    logger.info(f"SMSC: bound as {self.system_id}")
                    return True
                else:
                    logger.warning(f"SMSC: bind failed with status {status}")
                    return False
            return False
        except Exception as e:
            logger.error(f"SMSC connect/bind error: {e}")
            return False

    def send_submit_sm(self, source_addr, destination_addr, short_message,
                       registered_delivery=True):
        """Send a submit_sm PDU. Returns (success, message_id_or_None)."""
        try:
            if isinstance(short_message, str):
                msg_bytes = short_message.encode('utf-8', errors='replace')
            else:
                msg_bytes = short_message

            rd = None
            if registered_delivery:
                rd = RegisteredDelivery(
                    RegisteredDeliveryReceipt.SMSC_DELIVERY_RECEIPT_REQUESTED)

            pdu = SubmitSM(
                sequence_number=self.next_seq(),
                service_type='',
                source_addr_ton=AddrTon.INTERNATIONAL,
                source_addr_npi=AddrNpi.ISDN,
                source_addr=source_addr,
                dest_addr_ton=AddrTon.INTERNATIONAL,
                dest_addr_npi=AddrNpi.ISDN,
                destination_addr=destination_addr,
                esm_class=EsmClass(EsmClassMode.DEFAULT, EsmClassType.DEFAULT),
                protocol_id=0,
                priority_flag=PriorityFlag.LEVEL_0,
                registered_delivery=rd,
                replace_if_present_flag=ReplaceIfPresentFlag.DO_NOT_REPLACE,
                data_coding=DataCoding(scheme_data=DataCodingDefault.UCS2
                                       if any(ord(c) > 127 for c in
                                              (short_message if isinstance(short_message, str) else ''))
                                       else DataCodingDefault.SMSC_DEFAULT_ALPHABET),
                short_message=msg_bytes,
            )
            self.sock.sendall(self._encoder.encode(pdu))

            resp = self._read_pdu(timeout=15)
            if resp is None:
                return False, None

            if resp.command_id == CommandId.submit_sm_resp:
                status = getattr(resp, 'status', CommandStatus.ESME_ROK)
                # msg_id can be a direct attribute or in params
                msg_id = getattr(resp, 'message_id', None)
                if msg_id is None and hasattr(resp, 'params'):
                    msg_id = resp.params.get('message_id', '')
                if msg_id is None:
                    msg_id = ''
                if isinstance(msg_id, bytes):
                    msg_id = msg_id.decode('utf-8', errors='replace')
                ok = (status == CommandStatus.ESME_ROK)
                return ok, str(msg_id) if msg_id else None
            return False, None
        except Exception as e:
            logger.error(f"SMSC submit_sm error: {e}")
            return False, None

    def send_enquire_link(self):
        """Send enquire_link. Returns True if response received."""
        try:
            pdu = EnquireLink(sequence_number=self.next_seq())
            self.sock.sendall(self._encoder.encode(pdu))
            resp = self._read_pdu(timeout=5)
            return resp is not None
        except:
            return False

    def read_once(self):
        """Read one PDU from the socket (non-blocking with short timeout)."""
        try:
            self.sock.settimeout(0.5)
            resp = self._read_pdu()
            if resp is None:
                return None
            # Handle DLR (deliver_sm from SMSC)
            if resp.command_id == CommandId.deliver_sm:
                # Send response
                dlr_resp = SubmitSMResp(
                    sequence_number=resp.sequence_number,
                    message_id=resp.params.get('message_id', '') if hasattr(resp, 'params') else '',
                )
                self.sock.sendall(self._encoder.encode(dlr_resp))
                return resp
            return resp
        except socket.timeout:
            return None
        except:
            raise

    def _read_pdu(self, timeout=10):
        """Read a complete PDU from the socket."""
        try:
            self.sock.settimeout(timeout)
            header = self._recv_exact(16)
            if not header or len(header) < 16:
                return None
            length = struct.unpack('>I', header[:4])[0]
            body_len = length - 16
            body = b''
            if body_len > 0:
                body = self._recv_exact(body_len)
            full = header + body
            return PDUEncoder().decode(io.BytesIO(full))
        except Exception as e:
            logger.debug(f"SMSC _read_pdu: {e}")
            return None

    def _recv_exact(self, n):
        """Receive exactly n bytes from socket."""
        buf = b''
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def close(self):
        self.connected = False
        try:
            if self.sock:
                self.sock.close()
        except:
            pass


# ─── ESMC server using smppy.Application ───
class Net2AppSmppApplication(Application):
    """SMPP ESMC application using smppy framework."""

    def __init__(self, gateway):
        super().__init__('Net2App')
        self.gateway = gateway
        self.db = gateway.db
        self.sessions: dict[int, SmppClient] = {}

    async def handle_bound_client(self, client: SmppClient) -> Optional[SmppClient]:
        """Authenticate ESME client against DB."""
        try:
            db_client = self.db.auth_client(client.system_id, client.password)
            if db_client:
                logger.info(f"✓ {client.system_id} authenticated as '{db_client['name']}'")
                self.sessions[db_client['id']] = client
                self.db.set_bind_status('clients', db_client['id'], 'bound',
                                        client.system_id, '')
                return client
            else:
                logger.warning(f"✗ Bind failed: {client.system_id} (invalid credentials)")
                return None
        except Exception as e:
            logger.error(f"Auth error: {e}")
            return None

    async def handle_unbound_client(self, client: SmppClient):
        """Clean up on unbind."""
        for cid, sess in list(self.sessions.items()):
            if sess is client:
                self.sessions.pop(cid, None)
                self.db.set_bind_status('clients', cid, 'unbound', client.system_id, '')
                logger.info(f"ESME {client.system_id} unbound")
                break

    async def handle_sms_received(self, client: SmppClient, source_number: str,
                                  dest_number: str, text: str):
        """Process incoming submit_sm from ESME client."""
        try:
            # Find client_id from session
            client_id = None
            for cid, sess in self.sessions.items():
                if sess is client:
                    client_id = cid
                    break
            if client_id is None:
                logger.warning("SMS from unknown client session")
                return

            logger.info(f"SUBMIT_SM: {source_number} -> {dest_number} '{text[:50]}'")

            mcc_mnc = self.gateway.get_mcc_mnc(dest_number)
            route = self.db.get_route(client_id, mcc_mnc)

            if route:
                cr = self.db.get_rate('client_rates', client_id, mcc_mnc)
                sr = self.db.get_rate('supplier_rates', route['supplier_id'], mcc_mnc)
                parts = max(1, (len(text) + 152) // 153)
                cost = sr * parts
                pay = cr * parts
                msg_id = self.gateway.gen_msg_id()

                if cr > 0 and sr > 0 and cr > sr:
                    self.db.deduct_balance('clients', client_id, pay)
                    self.db.deduct_balance('suppliers', route['supplier_id'], cost)

                    ld = {
                        'message_id': msg_id, 'client_id': client_id,
                        'client_user': client.system_id, 'client_alias': '',
                        'supplier_id': route['supplier_id'],
                        'supplier_user': route.get('supplier_name', ''),
                        'route_id': route['route_id'], 'route_name': route.get('route_name', ''),
                        'trunk_id': route['trunk_id'], 'channel': route.get('trunk_name', ''),
                        'device': route.get('trunk_name', ''),
                        'sender': source_number, 'recipient': dest_number, 'message_text': text,
                        'parts': parts, 'status': 'submitted',
                        'mcc': mcc_mnc[:3], 'mnc': mcc_mnc[3:],
                        'in_msg_id': str(msg_id), 'out_msg_id': msg_id, 'supplier_msg_id': msg_id,
                        'client_rate': cr, 'supplier_rate': sr,
                        'cost': cost, 'pay': pay, 'profit': pay - cost,
                        'ip_address': '',
                    }
                    log_id = self.db.log_sms(ld)
                    logger.info(f"SMS logged: {msg_id} (ID={log_id})")

                    # Forward to supplier
                    loop = asyncio.get_event_loop()
                    fwd_ok, sup_msg_id = await loop.run_in_executor(
                        self.gateway.executor, self.gateway.forward_to_supplier_sync,
                        source_number, dest_number, text, route)

                    if fwd_ok:
                        self.db._execute(
                            "UPDATE sms_logs SET send_result='success', status='submitted'::sms_status, "
                            "supplier_msg_id=%s WHERE message_id=%s",
                            (sup_msg_id or msg_id, msg_id))
                        logger.info(f"✓ Forwarded to supplier: {msg_id}")
                    else:
                        self.db._execute(
                            "UPDATE sms_logs SET send_result='failed', status='failed'::sms_status, "
                            "send_reason='supplier_unreachable' WHERE message_id=%s",
                            (msg_id,))
                        logger.warning(f"✗ Failed to forward: {msg_id}")

                    # Send DLR (deliver_sm) if registered delivery requested
                    # smppy auto-acks submit_sm; we send DLR for actual delivery result
                    if fwd_ok:
                        self.db.queue_dlr(log_id, msg_id, client_id, route['supplier_id'], 'delivered')
                        self.db.update_dlr(msg_id, 'delivered')
                        try:
                            await client.send_sms(
                                source=route.get('supplier_name', 'SMSC'),
                                dest=source_number,
                                text=f"id:{msg_id} sub:001 dlvrd:001 submit date:{datetime.now().strftime('%y%m%d%H%M')} done date:{datetime.now().strftime('%y%m%d%H%M')} stat:DELIVRD err:000 text:{text[:20]}"
                            )
                            logger.info(f"DLR sent to {client.system_id} for {msg_id}")
                        except Exception as e:
                            logger.error(f"DLR send failed: {e}")
                else:
                    logger.warning(f"Rate validation failed: cr={cr} sr={sr}")
            else:
                logger.warning(f"No route for client {client_id}")
        except Exception as e:
            logger.error(f"handle_sms_received error: {e}")


class SmppGatewayServer:
    """Main SMPP Gateway - ESMC + SMSC + REST bridge."""

    def __init__(self):
        self.db = DatabaseBridge()
        self.running = True
        self.supplier_client: Optional[SmppSupplierClient] = None
        self.supplier_connected = False
        self.supplier_stop = Event()
        self.supplier_lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=2)
        self.loop = None
        self.app = Net2AppSmppApplication(self)

    def gen_msg_id(self):
        return f"N2A{datetime.now().strftime('%y%m%d%H%M%S')}{uuid.uuid4().hex[:8].upper()}"

    def get_mcc_mnc(self, num):
        c = num.lstrip('+').lstrip('00')
        for prefix, mccmnc in [('880', '47001'), ('91', '40468'), ('251', '63601'),
                               ('1', '310410'), ('44', '23430'), ('92', '41001')]:
            if c.startswith(prefix):
                return mccmnc
        return '47001'

    def _smsc_worker(self):
        """SMSC supplier connection thread using SmppSupplierClient."""
        retry_count = 0
        while self.running and not self.supplier_stop.is_set():
            try:
                logger.info(f"SMSC: connecting to {SMPP_CONFIG['supplier_host']}:{SMPP_CONFIG['supplier_port']} (attempt #{retry_count + 1})")

                client = SmppSupplierClient(
                    SMPP_CONFIG['supplier_host'],
                    SMPP_CONFIG['supplier_port'],
                    SMPP_CONFIG['supplier_system_id'],
                    SMPP_CONFIG['supplier_password'],
                )

                if client.connect_and_bind():
                    with self.supplier_lock:
                        self.supplier_client = client
                        self.supplier_connected = True
                    retry_count = 0

                    # Update DB
                    try:
                        loop = asyncio.run_coroutine_threadsafe(
                            self._update_supplier_bind('bound'), self.loop)
                        loop.result(timeout=5)
                    except:
                        pass

                    # Listen loop with keepalive
                    enquire_count = 0
                    while self.running and not self.supplier_stop.is_set():
                        try:
                            pdu = client.read_once()
                            if pdu is None:
                                enquire_count += 1
                            else:
                                enquire_count = 0
                                # Handle DLR from SMSC
                                if pdu.command_id == CommandId.deliver_sm:
                                    try:
                                        # message_id and stat can be direct attributes or in params
                                        mid = getattr(pdu, 'message_id', None)
                                        if mid is None and hasattr(pdu, 'params'):
                                            mid = pdu.params.get('message_id', b'')
                                        if mid is None:
                                            mid = b''
                                        stat = getattr(pdu, 'stat', None)
                                        if stat is None and hasattr(pdu, 'params'):
                                            stat = pdu.params.get('stat', b'')
                                        if stat is None:
                                            stat = b''
                                        if isinstance(mid, bytes):
                                            mid = mid.decode('utf-8', errors='replace')
                                        if isinstance(stat, bytes):
                                            stat = stat.decode('utf-8', errors='replace')
                                        if mid:
                                            dlr_map = {'DELIVRD': 'delivered', 'DELIVERED': 'delivered',
                                                       'EXPIRED': 'expired', 'DELETED': 'failed',
                                                       'UNDELIV': 'failed', 'UNDELIVERABLE': 'failed',
                                                       'ACCEPTD': 'submitted', 'REJECTD': 'rejected'}
                                            ds = dlr_map.get(stat.upper(), 'delivered')
                                            self.db.update_dlr(mid, ds)
                                            logger.info(f"DLR from SMSC: {mid} -> {ds}")
                                    except Exception as e:
                                        logger.error(f"DLR handler: {e}")

                            # Send enquire_link every ~15s
                            if enquire_count >= 15:
                                try:
                                    client.send_enquire_link()
                                    logger.debug("Enquire_link sent to SMSC")
                                except:
                                    pass
                                enquire_count = 0

                        except (ConnectionError, BrokenPipeError, OSError):
                            logger.warning("SMSC connection lost")
                            break
                        except Exception as e:
                            logger.debug(f"SMSC read_once: {e}")
                            time.sleep(0.1)

                    client.close()
                else:
                    client.close()

            except Exception as e:
                logger.error(f"SMSC connection failed (attempt #{retry_count + 1}): {e}")
                with self.supplier_lock:
                    self.supplier_connected = False
                try:
                    coro = self._update_supplier_bind('unbound')
                    fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
                    fut.result(timeout=5)
                except:
                    pass

            with self.supplier_lock:
                self.supplier_client = None

            retry_count += 1
            if self.running and not self.supplier_stop.is_set():
                delay = min(5 + retry_count * 2, 30)
                logger.info(f"SMSC reconnect in {delay}s (retry #{retry_count})")
                self.supplier_stop.wait(delay)

    async def _update_supplier_bind(self, status):
        self.db.set_bind_status('suppliers', 2, status, SMPP_CONFIG['supplier_system_id'],
                               f"{SMPP_CONFIG['supplier_host']}:{SMPP_CONFIG['supplier_port']}")

    def send_via_smsc_sync(self, sender, recipient, message):
        """Send via SMSC supplier."""
        with self.supplier_lock:
            if not self.supplier_connected or not self.supplier_client:
                return False, None
            client = self.supplier_client
        try:
            return client.send_submit_sm(sender, recipient, message)
        except Exception as e:
            logger.error(f"SMSC send: {e}")
            return False, None

    def send_via_http_api_sync(self, sender, recipient, message, route):
        """Send via HTTP API supplier (e.g. SMS Sheba)."""
        try:
            row, desc = self.db._fetchone(
                "SELECT id, name, api_url, api_key, api_method, "
                "api_params, api_headers, "
                "success_field, success_value, message_id_field "
                "FROM suppliers WHERE id=%s AND is_active=true",
                (route['supplier_id'],))
            if not row:
                logger.error(f"Supplier {route['supplier_id']} not found")
                return False, None
            sup = dict(zip(desc, row))

            base_url = sup.get('api_url', '')
            if not base_url:
                params = {
                    'apikey': '17a0c9ff557a81eccafefb624443573c',
                    'sender': sender,
                    'msisdn': recipient,
                    'smstext': message,
                }
                url = f"https://api.smssheba.com/smsapiv3?{urllib.parse.urlencode(params)}"
                logger.info(f"Sending via SMS Sheba (fallback): {url[:80]}...")
                req = urllib.request.Request(url, method='GET')
                with urllib.request.urlopen(req, timeout=15) as resp:
                    body = resp.read().decode('utf-8')
                    data = json.loads(body)
                    status = data.get('response', [{}])[0].get('status', -1)
                    msg_id = str(data.get('response', [{}])[0].get('id', ''))
                    ok = (status == 0 or status == 102)
                    logger.info(f"SMS Sheba send: status={status} msg_id={msg_id}")
                    return ok, msg_id

            method = sup.get('api_method', 'GET').upper()
            api_key = sup.get('api_key', '')
            api_headers = sup.get('api_headers', {}) or {}
            api_params_raw = sup.get('api_params', {}) or {}
            if isinstance(api_params_raw, str):
                try:
                    api_params = json.loads(api_params_raw)
                except:
                    api_params = {}
            else:
                api_params = api_params_raw

            params = dict(api_params)
            params['apikey'] = api_key
            params['sender'] = sender
            params['msisdn'] = recipient
            params['smstext'] = message

            if method == 'GET':
                full_url = f"{base_url}?{urllib.parse.urlencode(params)}"
                req = urllib.request.Request(full_url, method='GET', headers=api_headers)
            else:
                data_bytes = urllib.parse.urlencode(params).encode()
                req = urllib.request.Request(base_url, data=data_bytes, method='POST', headers=api_headers)
                if 'Content-Type' not in api_headers:
                    req.add_header('Content-Type', 'application/x-www-form-urlencoded')

            logger.info(f"Sending via HTTP API: {base_url}")
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode('utf-8')
                data = json.loads(body)

            sf = sup.get('success_field', 'response.0.status')
            sv = sup.get('success_value', '0')
            mf = sup.get('message_id_field', 'response.0.id')

            actual = _get_field(data, sf)
            expected = sv
            ok = str(actual) == str(expected) or actual == int(expected) if expected.isdigit() else False
            sup_msg_id = str(_get_field(data, mf) or '')

            logger.info(f"HTTP API send: ok={ok} msg_id={sup_msg_id}")
            return ok, sup_msg_id

        except Exception as e:
            logger.error(f"HTTP API send error: {e}")
            return False, None

    def forward_to_supplier_sync(self, sender, recipient, message, route):
        """Forward SMS to the appropriate supplier."""
        conn_type = route.get('supplier_conn_type', 'smpp')
        if conn_type == 'http':
            return self.send_via_http_api_sync(sender, recipient, message, route)
        else:
            return self.send_via_smsc_sync(sender, recipient, message)

    async def http_api(self):
        """HTTP REST API bridge on port 9000."""
        from aiohttp import web

        async def status(req):
            return web.json_response({
                'server': 'running', 'esmc_port': SMPP_CONFIG['server_port'],
                'supplier_connected': self.supplier_connected,
                'supplier': f"{SMPP_CONFIG['supplier_host']}:{SMPP_CONFIG['supplier_port']}",
                'sessions': len(self.app.sessions),
                'session_list': [
                    {'client_id': cid, 'system_id': s.system_id,
                     'addr': str(s._protocol._transport.get_extra_info('peername'))
                        if s._protocol and s._protocol._transport
                        and hasattr(s._protocol._transport, 'get_extra_info') else ''}
                    for cid, s in self.app.sessions.items()
                ],
            })

        async def send(req):
            try:
                data = await req.json()
                sender = data.get('sender', 'Net2App')
                recipient = data.get('recipient', '')
                message = data.get('message', '')
                client_id = int(data.get('clientId', 1))
                if not recipient or not message:
                    return web.json_response({'error': 'recipient and message required'}, status=400)

                mcc_mnc = self.get_mcc_mnc(recipient)
                route = self.db.get_route(client_id, mcc_mnc)
                if not route:
                    return web.json_response({'error': 'No route'}, status=400)

                cr = self.db.get_rate('client_rates', client_id, mcc_mnc)
                sr = self.db.get_rate('supplier_rates', route['supplier_id'], mcc_mnc)
                parts = max(1, (len(message) + 152) // 153)
                cost = sr * parts
                pay = cr * parts
                msg_id = self.gen_msg_id()

                fwd_ok = False
                sup_msg_id = None
                if cr > 0 and sr > 0 and cr > sr:
                    self.db.deduct_balance('clients', client_id, pay)
                    self.db.deduct_balance('suppliers', route['supplier_id'], cost)

                    loop = asyncio.get_event_loop()
                    fwd_ok, sup_msg_id = await loop.run_in_executor(
                        self.executor, self.forward_to_supplier_sync,
                        sender, recipient, message, route)

                ld = {
                    'message_id': msg_id, 'client_id': client_id,
                    'client_user': data.get('clientUser', 'api'), 'client_alias': '',
                    'supplier_id': route['supplier_id'],
                    'supplier_user': route.get('supplier_name', ''),
                    'route_id': route['route_id'], 'route_name': route.get('route_name', ''),
                    'trunk_id': route['trunk_id'], 'channel': route.get('trunk_name', ''),
                    'device': route.get('trunk_name', ''),
                    'sender': sender, 'recipient': recipient, 'message_text': message,
                    'parts': parts, 'status': 'submitted' if fwd_ok else 'failed',
                    'mcc': mcc_mnc[:3], 'mnc': mcc_mnc[3:],
                    'in_msg_id': msg_id, 'out_msg_id': msg_id, 'supplier_msg_id': sup_msg_id or msg_id,
                    'client_rate': cr, 'supplier_rate': sr,
                    'cost': cost, 'pay': pay, 'profit': pay - cost,
                    'ip_address': req.remote or '',
                }
                log_id = self.db.log_sms(ld)
                return web.json_response({'success': fwd_ok, 'messageId': msg_id, 'logId': log_id})
            except Exception as e:
                return web.json_response({'error': str(e)}, status=500)

        async def dlr(req):
            try:
                data = await req.json()
                msg_id = data.get('messageId', '')
                ds = data.get('dlrStatus', '')
                if msg_id and ds:
                    self.db.update_dlr(msg_id, ds)
                    return web.json_response({'success': True})
                return web.json_response({'error': 'messageId and dlrStatus required'}, status=400)
            except Exception as e:
                return web.json_response({'error': str(e)}, status=400)

        app = web.Application()
        app.router.add_get('/api/smpp/status', status)
        app.router.add_post('/api/smpp/send', send)
        app.router.add_post('/api/smpp/dlr', dlr)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 9000)
        await site.start()
        logger.info(f"REST API bridge: http://127.0.0.1:9000")
        while self.running:
            await asyncio.sleep(5)
        await runner.cleanup()

    async def _esmc_keepalive(self):
        """Background task: send enquire_link to all bound ESME sessions every 30s."""
        from smpp.pdu.operations import EnquireLink
        encoder = PDUEncoder()
        while self.running:
            try:
                await asyncio.sleep(30)
                stale = []
                for cid, sess in list(self.app.sessions.items()):
                    try:
                        seq = int(time.time() * 1000) % 0x7FFFFFFF + cid
                        el = EnquireLink(sequence_number=seq)
                        sess._protocol._transport.write(encoder.encode(el))
                        logger.debug(f"Keepalive enquire_link sent to {sess.system_id}")
                    except Exception as e:
                        logger.warning(f"Keepalive failed for {sess.system_id}: {e}")
                        stale.append(cid)
                for cid in stale:
                    sess = self.app.sessions.pop(cid, None)
                    if sess:
                        try:
                            sess._protocol._transport.close()
                        except:
                            pass
                        self.db.set_bind_status('clients', cid, 'unbound', sess.system_id, '')
                        logger.info(f"Keepalive: cleaned stale session {sess.system_id}")
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"ESMC keepalive error: {e}")

    async def run(self):
        """Start all components."""
        self.loop = asyncio.get_event_loop()

        logger.info("╔══════════════════════════════════════════════╗")
        logger.info("║   Net2App Blast SMPP Gateway Server v3     ║")
        logger.info("╠══════════════════════════════════════════════╣")
        logger.info(f"║  ESMC:  {SMPP_CONFIG['server_host']}:{SMPP_CONFIG['server_port']} (smppy)       ║")
        logger.info(f"║  SMSC:  {SMPP_CONFIG['supplier_host']}:{SMPP_CONFIG['supplier_port']} (smpp.pdu) ║")
        logger.info(f"║  REST:  http://127.0.0.1:9000              ║")
        logger.info("╚══════════════════════════════════════════════╝")

        # Start SMSC worker thread
        smsc_thread = Thread(target=self._smsc_worker, daemon=True)
        smsc_thread.start()

        tasks = [
            asyncio.create_task(self.http_api()),
            asyncio.create_task(self._esmc_keepalive()),
        ]

        # Start ESMC server using a custom protocol that cleans up on disconnect
        class Net2AppSmppProtocol(SmppProtocol):
            def connection_lost(self, exc):
                if self._client:
                    for cid, sess in list(self.app.sessions.items()):
                        if sess is self._client:
                            self.app.sessions.pop(cid, None)
                            self.app.db.set_bind_status(
                                'clients', cid, 'unbound',
                                self._client.system_id, '')
                            self.app.logger.info(
                                f"ESME {self._client.system_id} disconnected (TCP close)")
                            break
                super().connection_lost(exc)

            async def request_handler(self, pdu):
                if pdu.command_id == CommandId.enquire_link_resp:
                    return  # Silent handling
                await super().request_handler(pdu)

        factory = lambda: Net2AppSmppProtocol(app=self.app)
        esmc_server = await self.loop.create_server(factory, host=SMPP_CONFIG['server_host'],
                                                    port=SMPP_CONFIG['server_port'])

        async def serve_esmc():
            logger.info(f"ESMC listening on {SMPP_CONFIG['server_host']}:{SMPP_CONFIG['server_port']} (smppy)")
            async with esmc_server:
                await esmc_server.serve_forever()

        tasks.append(asyncio.create_task(serve_esmc()))
        try:
            await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            pass
        finally:
            self.running = False
            self.supplier_stop.set()
            if smsc_thread.is_alive():
                smsc_thread.join(timeout=5)


def main():
    server = SmppGatewayServer()

    def shutdown(sig, frame):
        logger.info(f"Signal {sig}, shutting down...")
        server.running = False
        server.supplier_stop.set()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        logger.info("Stopped")
    except Exception as e:
        logger.error(f"Fatal: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
