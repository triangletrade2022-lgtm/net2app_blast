#!/usr/bin/env python3
"""
Net2App Blast - SMPP Gateway Server (v3)
=========================================
- ESMC: Uses smppy.Application for clean, stable PDU handling
- SMSC: Connects to external suppliers via smpp.pdu over TCP
- REST API bridge on port 9001
- Keeps bind up 24/7 with auto-reconnect + keepalive
"""

import asyncio
import io
import json
import logging
import os
import random
import signal
import ssl
import struct
import sys
import time
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional

from smppy import Application, SmppClient
from smppy.server import SmppProtocol
from smpp.pdu.operations import (
    BindTransceiver, BindTransmitter, BindReceiver,
    SubmitSM, EnquireLink, Unbind, DeliverSM,
    BindTransceiverResp, BindTransmitterResp, BindReceiverResp,
    UnbindResp, SubmitSMResp,
)
from smpp.pdu.pdu_encoding import PDUEncoder
from smpp.pdu.pdu_types import (
    CommandId, CommandStatus, AddrTon, AddrNpi,
    EsmClassMode, EsmClass, EsmClassType,
    RegisteredDelivery, RegisteredDeliveryReceipt,
    PriorityFlag, ReplaceIfPresentFlag,
    DataCodingDefault, DataCoding,
    MoreMessagesToSend,
)
from smpp.pdu.sm_encoding import SMStringEncoder

# ─── SMPP Integer-to-String Command ID mapping ───
# The smpp library uses string-based CommandIds (e.g. 'bind_transceiver_resp').
# When we parse raw PDU headers, we get integer command IDs that need to be
# mapped to the string names the library expects.
_SMPP_CMD_MAP = {
    0x00000001: 'bind_receiver', 0x80000001: 'bind_receiver_resp',
    0x00000002: 'bind_transmitter', 0x80000002: 'bind_transmitter_resp',
    0x00000004: 'submit_sm', 0x80000004: 'submit_sm_resp',
    0x00000005: 'deliver_sm', 0x80000005: 'deliver_sm_resp',
    0x00000006: 'unbind', 0x80000006: 'unbind_resp',
    0x00000007: 'replace_sm', 0x80000007: 'replace_sm_resp',
    0x00000008: 'cancel_sm', 0x80000008: 'cancel_sm_resp',
    0x00000009: 'bind_transceiver', 0x80000009: 'bind_transceiver_resp',
    0x0000000b: 'outbind',
    0x00000014: 'enquire_link', 0x80000014: 'enquire_link_resp',
    0x00000015: 'enquire_link', 0x80000015: 'enquire_link_resp',
    0x00000100: 'generic_nack', 0x80000100: 'generic_nack',
}

# SMPP status code to string mapping
_SMPP_STATUS_MAP = {
    0x00000000: 'ESME_ROK',
    0x00000001: 'ESME_RINVMSGLEN',
    0x00000002: 'ESME_RINVCMDLEN',
    0x00000003: 'ESME_RINVCMDID',
    0x00000004: 'ESME_RINVBNDSTS',
    0x00000005: 'ESME_RINVRSVPAD',
    0x00000006: 'ESME_RINVSRCADR',
    0x00000007: 'ESME_RINVDSTADR',
    0x00000008: 'ESME_RINVMSGID',
    0x0000000a: 'ESME_RINVPRTFLG',
    0x0000000b: 'ESME_RINVREPFLG',
    0x0000000c: 'ESME_RINVADRTON',
    0x0000000d: 'ESME_RBINDFAIL',
    0x0000000e: 'ESME_RINVESMCLASS',
    0x0000000f: 'ESME_RINVSERTYP',
    0x00000010: 'ESME_RINVSRCTON',
    0x00000011: 'ESME_RINVSRCNPI',
    0x00000012: 'ESME_RINVDSTTON',
    0x00000013: 'ESME_RINVDSTNPI',
    0x00000014: 'ESME_RINVSRVCODE',
    0x00000066: 'ESME_RINVOPTPARSTREAM',
    0x00000067: 'ESME_ROPTPARNOTALLWD',
    0x00000068: 'ESME_RINVPARLEN',
    0x00000069: 'ESME_RMISSINGOPTPARAM',
    0x0000006a: 'ESME_RINVOPTPARAMVAL',
    0x000000ff: 'ESME_RDELIVERFAILURE',
    0x00000100: 'ESME_RMAXQUEUEEXCEEDED',
    0x00000101: 'ESME_RMSGQFUL',
    0x00000400: 'ESME_RINVCERTLEN',
    0x00000401: 'ESME_RINVCERTEXPIRED',
    0x00000402: 'ESME_RINVCERTPATH',
    0x00000403: 'ESME_RINVCERTID',
    0x00000404: 'ESME_RINVSQLENGTH',
    0x00000405: 'ESME_RINVTLVSTREAM',
    0x00000406: 'ESME_RINVTLVALLOWED',
    0x00000407: 'ESME_RINVTLVLEN',
    0x00000408: 'ESME_RMISSINGTLV',
    0x00000409: 'ESME_RINVTLVVAL',
    0x000000c8: 'ESME_RDELIVERFAILURE',  # 200 decimal
}

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

ESMC_HOST = os.environ.get('ESMC_HOST', '0.0.0.0')
ESMC_PORT = int(os.environ.get('ESMC_PORT', '2776'))
API_PORT = int(os.environ.get('API_PORT', '9001'))




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
            "force_dlr, force_dlr_status, force_dlr_timeout, dlr_callback_url, "
            "allowed_ips "
            "FROM clients "
            "WHERE smpp_system_id=%s AND smpp_password=%s AND is_active=true AND connection_type='smpp'",
            (system_id, password))
        return dict(zip(desc, row)) if row else None

    def check_ip_allowed(self, allowed_ips_str: str, client_ip: str) -> bool:
        """Check if a client IPv4 is allowed based on comma-separated whitelist.
        Supports: single IPs (1.2.3.4), CIDR (1.2.3.0/24), wildcards (1.2.3.*).
        Empty = no restriction.
        """
        if not allowed_ips_str or not allowed_ips_str.strip():
            return True
        allowed_list = [ip.strip() for ip in allowed_ips_str.split(',') if ip.strip()]
        if not allowed_list:
            return True
        # Strip port from IPv4:port if present
        client_ip = client_ip.split(':')[0] if ':' in client_ip else client_ip
        for entry in allowed_list:
            if entry == client_ip:
                return True
            # Wildcard: 192.168.1.*
            if '*' in entry:
                prefix = entry.replace('*', '').rstrip('.')
                if client_ip.startswith(prefix):
                    return True
            # CIDR: 192.168.1.0/24
            if '/' in entry:
                try:
                    import ipaddress
                    if ipaddress.ip_address(client_ip) in ipaddress.ip_network(entry, strict=False):
                        return True
                except ValueError:
                    pass
        return False

    def get_route(self, client_id, mcc_mnc):
        if isinstance(mcc_mnc, bytes):
            mcc_mnc = mcc_mnc.decode('utf-8', errors='replace')
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
              AND (r.mcc_mnc IS NULL OR r.mcc_mnc='' OR %s LIKE r.mcc_mnc || '%%')
            ORDER BY CASE WHEN %s = r.mcc_mnc THEN 0 WHEN %s LIKE r.mcc_mnc || '%%' THEN 1 ELSE 2 END,
                     r.priority ASC, rt.priority ASC LIMIT 1""",
            (client_id, mcc_mnc, mcc_mnc, mcc_mnc))
        if row:
            return dict(zip(desc, row))

    def get_rate(self, table, entity_id, mcc_mnc):
        if isinstance(mcc_mnc, bytes):
            mcc_mnc = mcc_mnc.decode('utf-8', errors='replace')
        row, desc = self._fetchone(
            f"SELECT rate::numeric FROM {table} WHERE "
            f"{'client_id' if table=='client_rates' else 'supplier_id'}=%s "
            f"AND (mcc_mnc IS NULL OR mcc_mnc='' OR %s LIKE mcc_mnc || '%%') AND is_active=true "
            f"ORDER BY CASE WHEN %s = mcc_mnc THEN 0 WHEN %s LIKE mcc_mnc || '%%' THEN 1 ELSE 2 END LIMIT 1",
            (entity_id, mcc_mnc, mcc_mnc, mcc_mnc))
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

    def set_bind_status(self, table, entity_id, status, system_id=None, addr=None, bind_type=None):
        self._execute(f"UPDATE {table} SET smpp_bind_status=%s, updated_at=NOW() WHERE id=%s", (status, entity_id))
        self._execute(
            "INSERT INTO smpp_sessions (entity_type, entity_id, system_id, bind_status, bind_type, remote_address, last_activity) "
            "VALUES (%s,%s,%s,%s,%s,%s,NOW()) "
            "ON CONFLICT (entity_type, entity_id) DO UPDATE SET bind_status=%s, last_activity=NOW()",
            ('client' if table == 'clients' else 'supplier', entity_id, system_id, status, bind_type or 'transceiver', addr, status))

    def get_active_smpp_suppliers(self):
        """Fetch all active SMPP suppliers from the database."""
        rows = self._fetchall(
            "SELECT id, name, smpp_system_id, smpp_password, smpp_host, smpp_port, "
            "smpp_tls, smpp_bind_type, sender_id, force_dlr, force_dlr_status "
            "FROM suppliers WHERE connection_type='smpp' AND is_active=true "
            "AND smpp_host IS NOT NULL AND smpp_system_id IS NOT NULL "
            "ORDER BY priority ASC, id ASC")
        if not rows:
            return []
        return [
            {'id': r[0], 'name': r[1], 'system_id': r[2], 'password': r[3],
             'host': r[4], 'port': r[5] or 2775, 'tls': bool(r[6]),
             'bind_type': r[7] or 'transceiver',
             'sender_id': r[8],
             'force_dlr': r[9], 'force_dlr_status': r[10]}
            for r in rows
        ]


# ─── SMSC Supplier Client (using smpp.pdu directly) ───
class SmppSupplierClient:
    """Async TCP-based SMSC supplier using smpp.pdu for PDU encoding/decoding.
    Uses asyncio streams for non-blocking I/O, consistent with smppy patterns.
    
    Single BindTransceiver connection that handles both send (submit_sm)
    and receive (deliver_sm/DLRs) as separate operations.
    """

    def __init__(self, host, port, system_id, password, bind_type='transceiver', tls=False):
        self.host = host
        self.port = port
        self.system_id = system_id
        self.password = password
        self.bind_type = bind_type
        self.tls = tls
        self.reader: Optional[asyncio.StreamReader] = None
        self.writer: Optional[asyncio.StreamWriter] = None
        self.connected = False
        self._seq = 1
        self._encoder = PDUEncoder()
        self._bind_mode = None  # 'transceiver', 'transmitter', 'receiver'
        self._last_bind_status = None

    def next_seq(self):
        s = self._seq
        self._seq += 1
        return s

    async def connect_and_bind(self):
        """Connect TCP/TLS and bind. Returns True on success.
        
        Supports TLS connections (e.g. for Telnyx which requires TLS on port 2775).
        Tries the configured bind_type in order:
        - 'transceiver': tries transceiver first, falls back to transmitter
        - 'transmitter': bind_transmitter only
        - 'receiver': bind_receiver only
        """
        try:
            if self.tls:
                # Create SSL context with hostname verification
                ssl_ctx = ssl.create_default_context()
                ssl_ctx.check_hostname = True
                ssl_ctx.verify_mode = ssl.CERT_REQUIRED
                self.reader, self.writer = await asyncio.wait_for(
                    asyncio.open_connection(self.host, self.port, ssl=ssl_ctx),
                    timeout=10)
                logger.info(f"SMSC: TLS connection established to {self.host}:{self.port}")
            else:
                self.reader, self.writer = await asyncio.wait_for(
                    asyncio.open_connection(self.host, self.port), timeout=10)

            if self.bind_type == 'receiver':
                return await self._try_bind('receiver')

            # Try bind_transceiver first, fallback to bind_transmitter
            if self.bind_type == 'transceiver':
                if await self._try_bind('transceiver'):
                    return True
                # If RINVCMDID (supplier doesn't support transceiver), try transmitter
                if self._last_bind_status in (CommandStatus.ESME_RINVCMDID, CommandStatus.ESME_RBINDFAIL):
                    logger.info(f"SMSC: transceiver not supported for {self.system_id}, trying transmitter")
                    return await self._try_bind('transmitter')
                return False

            # bind_transmitter only
            return await self._try_bind('transmitter')

        except asyncio.TimeoutError:
            logger.error(f"SMSC connect timeout to {self.host}:{self.port}")
            return False
        except Exception as e:
            logger.error(f"SMSC connect/bind error: {e}")
            return False

    async def _try_bind(self, mode: str) -> bool:
        """Try a specific bind operation (transceiver, transmitter, or receiver)."""
        if mode == 'transceiver':
            pdu_cls = BindTransceiver
            resp_cmd_id = CommandId.bind_transceiver_resp
            mode_name = 'transceiver'
        elif mode == 'transmitter':
            pdu_cls = BindTransmitter
            resp_cmd_id = CommandId.bind_transmitter_resp
            mode_name = 'transmitter'
        elif mode == 'receiver':
            pdu_cls = BindReceiver
            resp_cmd_id = CommandId.bind_receiver_resp
            mode_name = 'receiver'
        else:
            return False

        try:
            pdu = pdu_cls(
                sequence_number=self.next_seq(),
                system_id=self.system_id,
                password=self.password,
                system_type='',
                interface_version=0x34,
                addr_ton=AddrTon.INTERNATIONAL,
                addr_npi=AddrNpi.ISDN,
            )
            self.writer.write(self._encoder.encode(pdu))
            await self.writer.drain()
            logger.debug(f"SMSC: sent bind_{mode_name}")

            resp = await self._read_pdu(timeout=10)
            if resp is None:
                self._last_bind_status = None
                return False

            if resp.command_id == resp_cmd_id:
                status = getattr(resp, 'status', CommandStatus.ESME_ROK)
                self._last_bind_status = status
                if status == CommandStatus.ESME_ROK:
                    self.connected = True
                    self._bind_mode = mode
                    logger.info(f"SMSC: bound as {self.system_id} ({mode_name}) [{self.host}:{self.port}]")
                    return True
                else:
                    logger.warning(f"SMSC: bind_{mode_name} failed with status {status}")
                    return False
            # Wrong response command ID — might be a different bind response
            # Check if it's a bind_transceiver_resp for a different bind type
            self._last_bind_status = getattr(resp, 'status', CommandStatus.ESME_RINVCMDID)
            logger.warning(f"SMSC: bind_{mode_name} got unexpected response cmd={resp.command_id} status={self._last_bind_status}")
            return False
        except Exception as e:
            logger.error(f"SMSC bind_{mode_name} error: {e}")
            self._last_bind_status = None
            return False

    async def send_submit_sm(self, source_addr, destination_addr, short_message,
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
            self.writer.write(self._encoder.encode(pdu))
            await self.writer.drain()

            resp = await self._read_pdu(timeout=15)
            if resp is None:
                return False, None

            if resp.command_id == CommandId.submit_sm_resp:
                status = getattr(resp, 'status', CommandStatus.ESME_ROK)
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

    async def send_enquire_link(self):
        """Send enquire_link. Returns True if response received."""
        try:
            pdu = EnquireLink(sequence_number=self.next_seq())
            self.writer.write(self._encoder.encode(pdu))
            await self.writer.drain()
            resp = await self._read_pdu(timeout=5)
            return resp is not None
        except:
            return False

    async def read_once(self):
        """Read one PDU from the socket (non-blocking with short timeout)."""
        try:
            resp = await self._read_pdu(timeout=0.5)
            if resp is None:
                return None
            # Handle DLR (deliver_sm from SMSC)
            if resp.command_id == CommandId.deliver_sm:
                # Send response
                dlr_resp = SubmitSMResp(
                    sequence_number=resp.sequence_number,
                    message_id=resp.params.get('message_id', '') if hasattr(resp, 'params') else '',
                )
                self.writer.write(self._encoder.encode(dlr_resp))
                await self.writer.drain()
                return resp
            return resp
        except asyncio.TimeoutError:
            return None
        except Exception:
            raise

    async def _read_pdu(self, timeout=10):
        """Read a complete PDU from the socket using asyncio stream."""
        try:
            header = await self._recv_exact(16, timeout)
            if not header or len(header) < 16:
                return None
            length = struct.unpack('>I', header[:4])[0]
            body_len = length - 16
            body = b''
            if body_len > 0:
                body = await self._recv_exact(body_len, timeout)
            full = header + body
            # Try PDUEncoder first, fallback to manual decode
            try:
                return PDUEncoder().decode(io.BytesIO(full))
            except Exception as enc_err:
                # Fallback: manually decode the response header
                cmd_id = struct.unpack('>I', header[4:8])[0]
                cmd_status = struct.unpack('>I', header[8:12])[0]
                seq = struct.unpack('>I', header[12:16])[0]
                logger.warning(f"SMSC PDU decode error ({enc_err}), raw: len={length} cmd=0x{cmd_id:08x} status=0x{cmd_status:08x} seq={seq}")
                # Return a simple object with the string-based fields the library expects
                cmd_name = _SMPP_CMD_MAP.get(cmd_id, f'unknown_0x{cmd_id:08x}')
                status_name = _SMPP_STATUS_MAP.get(cmd_status, f'ESME_0x{cmd_status:08x}')
                class RawPdu:
                    pass
                resp = RawPdu()
                resp.command_id = cmd_name
                resp.command_status = status_name
                setattr(resp, 'status', status_name)
                resp.sequence_number = seq
                return resp
        except asyncio.TimeoutError:
            return None
        except Exception as e:
            logger.debug(f"SMSC _read_pdu: {e}")
            return None

    async def _recv_exact(self, n, timeout=10):
        """Receive exactly n bytes from async stream reader."""
        buf = b''
        while len(buf) < n:
            chunk = await asyncio.wait_for(
                self.reader.read(n - len(buf)), timeout=timeout)
            if not chunk:
                return None
            buf += chunk
        return buf

    def close(self):
        self.connected = False
        try:
            if self.writer:
                self.writer.close()
        except:
            pass


# ─── SMSC Supplier Manager (dynamic multi-supplier) ───
class SmppSupplierManager:
    """Manages persistent SMPP connections to all active upstream suppliers.
    
    Reads active SMPP suppliers from the database dynamically and maintains
    a persistent connection to each one. Each supplier connection has its own
    listen loop for DLR handling.
    """

    def __init__(self, gateway):
        self.gateway = gateway
        self.db = gateway.db
        self.connections: dict[int, SmppSupplierClient] = {}
        self.listen_tasks: dict[int, asyncio.Task] = {}
        self.supplier_info: dict[int, dict] = {}
        self.running = True
        self.lock = asyncio.Lock()

    async def connect_supplier(self, supplier: dict) -> bool:
        """Connect to a single supplier and start its listen loop."""
        sid = supplier['id']
        try:
            logger.info(f"SMSC: connecting to supplier {sid} ({supplier['name']}) at "
                        f"{supplier['host']}:{supplier['port']}")

            bind_type = supplier.get('bind_type', 'transceiver') or 'transceiver'
            tls_enabled = supplier.get('tls', False)
            client = SmppSupplierClient(
                supplier['host'], supplier['port'],
                supplier['system_id'], supplier['password'],
                bind_type=bind_type,
                tls=tls_enabled,
            )

            if await client.connect_and_bind():
                async with self.lock:
                    self.connections[sid] = client
                    self.supplier_info[sid] = supplier
                # Update bind status in DB
                try:
                    self.db.set_bind_status('suppliers', sid, 'bound',
                                            supplier['system_id'],
                                            f"{supplier['host']}:{supplier['port']}")
                except Exception as e:
                    logger.error(f"Failed to update bind status for supplier {sid}: {e}")

                # Start listen loop for this supplier's DLRs
                self.listen_tasks[sid] = asyncio.create_task(
                    self._supplier_listen_loop(sid, client, supplier))
                logger.info(f"✓ SMSC supplier {sid} ({supplier['name']}) connected and listening")
                return True
            else:
                client.close()
                return False

        except Exception as e:
            logger.error(f"SMSC connect supplier {sid} ({supplier.get('name', '')}): {e}")
            return False

    async def disconnect_supplier(self, sid: int):
        """Disconnect from a supplier and clean up."""
        logger.info(f"SMSC: disconnecting supplier {sid}")
        # Cancel listen loop
        task = self.listen_tasks.pop(sid, None)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        # Close connection
        async with self.lock:
            client = self.connections.pop(sid, None)
            self.supplier_info.pop(sid, None)
        if client:
            client.close()
        # Update bind status
        info = self.supplier_info.get(sid, {})
        try:
            self.db.set_bind_status('suppliers', sid, 'unbound',
                                    info.get('system_id', ''),
                                    f"{info.get('host', '')}:{info.get('port', '')}")
        except:
            pass

    async def _supplier_listen_loop(self, sid: int, client: SmppSupplierClient,
                                     supplier: dict):
        """Listen loop for a single supplier connection — reads DLRs."""
        listen_name = f"{supplier['name']}({sid})"
        enquire_count = 0
        while self.running and client.connected:
            try:
                pdu = await client.read_once()
                if pdu is None:
                    enquire_count += 1
                else:
                    enquire_count = 0

                # Handle DLR from SMSC
                if pdu and pdu.command_id == CommandId.deliver_sm:
                    try:
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
                            # Forward DLR to connected client
                            sms_data, sms_desc = self.db._fetchone(
                                "SELECT id, client_id, sender, recipient "
                                "FROM sms_logs WHERE message_id=%s", (mid,))
                            if sms_data:
                                sms = dict(zip(sms_desc, sms_data))
                                cid = sms.get('client_id')
                                if cid and cid in self.gateway.app.sessions:
                                    sess = self.gateway.app.sessions[cid]
                                    try:
                                        await self.gateway._send_dlr_pdu(
                                            sess._protocol,
                                            sender_number=sms.get('sender', ''),
                                            recipient_number=sms.get('recipient', ''),
                                            msg_id=mid,
                                            dlr_status=ds,
                                        )
                                        logger.info(f"DLR forwarded to client {cid}: {mid} -> {ds}")
                                    except Exception as e:
                                        logger.error(f"DLR forward to client {cid} failed: {e}")
                                        existing_data, _ = self.db._fetchone(
                                            "SELECT id FROM dlr_queue WHERE message_id=%s "
                                            "AND client_id=%s AND processed=false LIMIT 1",
                                            (mid, cid))
                                        if not existing_data:
                                            self.db.queue_dlr(sms.get('id'), mid, cid, sid, ds)
                                elif cid:
                                    existing_data, _ = self.db._fetchone(
                                        "SELECT id FROM dlr_queue WHERE message_id=%s "
                                        "AND client_id=%s AND processed=false LIMIT 1",
                                        (mid, cid))
                                    if not existing_data:
                                        self.db.queue_dlr(sms.get('id'), mid, cid, sid, ds)
                                    logger.info(f"DLR queued for client {cid}: {mid} -> {ds}")
                            logger.info(f"DLR from SMSC ({listen_name}): {mid} -> {ds}")
                    except Exception as e:
                        logger.error(f"DLR handler ({listen_name}): {e}")

                # Send enquire_link every ~15s
                if enquire_count >= 15:
                    try:
                        await client.send_enquire_link()
                        logger.debug(f"SMSC ({listen_name}): enquire_link sent")
                    except Exception as e:
                        logger.warning(f"SMSC ({listen_name}): enquire_link failed: {e}")
                    enquire_count = 0

            except (ConnectionError, BrokenPipeError, OSError):
                logger.warning(f"SMSC ({listen_name}): connection lost")
                break
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug(f"SMSC ({listen_name}) read_once: {e}")
                await asyncio.sleep(0.1)

        # Connection lost — clean up
        logger.info(f"SMSC ({listen_name}): listen loop ended")
        async with self.lock:
            self.connections.pop(sid, None)
            self.supplier_info.pop(sid, None)
        self.listen_tasks.pop(sid, None)
        try:
            self.db.set_bind_status('suppliers', sid, 'unbound',
                                    supplier.get('system_id', ''),
                                    f"{supplier.get('host', '')}:{supplier.get('port', '')}")
        except:
            pass

    async def manager_worker(self):
        """Main loop: read active SMPP suppliers from DB and manage connections."""
        retry_counts: dict[int, int] = {}
        while self.running:
            try:
                suppliers = self.db.get_active_smpp_suppliers()
                connected_ids = set(self.connections.keys())
                db_ids = {s['id'] for s in suppliers}

                # Disconnect suppliers no longer active
                for sid in connected_ids - db_ids:
                    await self.disconnect_supplier(sid)
                    retry_counts.pop(sid, None)

                # Connect new or reconnecting suppliers
                for sup in suppliers:
                    sid = sup['id']
                    if sid not in self.connections:
                        prev_retries = retry_counts.get(sid, 0)
                        if await self.connect_supplier(sup):
                            retry_counts[sid] = 0
                        else:
                            retry_counts[sid] = prev_retries + 1
                            delay = min(5 + retry_counts[sid] * 2, 30)
                            logger.info(f"SMSC supplier {sid} ({sup['name']}): retry in {delay}s")

            except Exception as e:
                logger.error(f"Supplier manager error: {e}")
                import traceback
                logger.error(traceback.format_exc())

            await asyncio.sleep(10)

    async def send_via_supplier(self, supplier_id: int, sender: str,
                                 recipient: str, message: str):
        """Send SMS via a specific supplier connection."""
        client = self.connections.get(supplier_id)
        if not client or not client.connected:
            logger.warning(f"SMSC supplier {supplier_id} not connected")
            return False, None
        try:
            return await client.send_submit_sm(sender, recipient, message)
        except Exception as e:
            logger.error(f"SMSC send via supplier {supplier_id}: {e}")
            return False, None

    def get_status_list(self):
        """Get status of all supplier connections."""
        result = []
        for sid, client in self.connections.items():
            info = self.supplier_info.get(sid, {})
            result.append({
                'supplier_id': sid,
                'name': info.get('name', ''),
                'system_id': info.get('system_id', ''),
                'host': client.host,
                'port': client.port,
                'connected': client.connected and bool(client.writer),
            })
        return result

    def get_connected_count(self):
        return sum(1 for c in self.connections.values() if c.connected)

    async def shutdown(self):
        self.running = False
        for sid in list(self.connections.keys()):
            await self.disconnect_supplier(sid)


# ─── ESMC server using smppy.Application ───
class Net2AppSmppApplication(Application):
    """SMPP ESMC application using smppy framework."""

    def __init__(self, gateway):
        super().__init__('Net2App')
        self.gateway = gateway
        self.db = gateway.db
        self.sessions: dict[int, SmppClient] = {}

    async def handle_bound_client(self, client: SmppClient) -> Optional[SmppClient]:
        """Authenticate ESME client against DB and check IP whitelist."""
        try:
            db_client = self.db.auth_client(client.system_id, client.password)
            if db_client:
                # Get client's IP address
                remote_addr = ''
                try:
                    peername = client._protocol._transport.get_extra_info('peername')
                    if peername:
                        remote_addr = str(peername[0]) if isinstance(peername, tuple) else str(peername)
                except Exception:
                    pass

                # Check/auto-set IP whitelist
                allowed = db_client.get('allowed_ips', '') or ''
                client_smpp_host = db_client.get('smpp_host', '') or ''

                if allowed:
                    # Manual whitelist set — check against it
                    if not self.db.check_ip_allowed(allowed, remote_addr):
                        logger.warning(f"✗ Bind rejected: {client.system_id} from {remote_addr} "
                                       f"(not in allowed_ips: {allowed})")
                        return None
                elif client_smpp_host:
                    # No manual whitelist but smpp_host is set — auto-whitelist the connecting IP
                    # This saves the IP so future connections from the same IP are allowed
                    now_allowed = remote_addr
                    self.db._execute(
                        "UPDATE clients SET allowed_ips=%s, updated_at=NOW() WHERE id=%s AND "
                        "(allowed_ips IS NULL OR allowed_ips='')",
                        (now_allowed, db_client['id']))
                    logger.info(f"✓ Auto-whitelisted {client.system_id} from {remote_addr}")
                # else: no whitelist, no smpp_host — allow all

                logger.info(f"✓ {client.system_id} authenticated as '{db_client['name']}' "
                           f"from {remote_addr}")
                self.sessions[db_client['id']] = client
                self.db.set_bind_status('clients', db_client['id'], 'bound',
                                        client.system_id, remote_addr)
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
                                  dest_number: str, text: str,
                                  pre_generated_msg_id: Optional[str] = None):
        """Process incoming submit_sm from ESME client.
        
        Args:
            pre_generated_msg_id: If provided, use this instead of generating a new one.
                This is used when the protocol layer already sent submit_sm_resp with
                this message_id so the client can match the DLR.
        """
        try:
            # Find client_id from session (try object identity first, then system_id)
            client_id = None
            sysid = getattr(client, 'system_id', None)
            for cid, sess in self.sessions.items():
                if sess is client:
                    client_id = cid
                    break
            if client_id is None and sysid:
                for cid, sess in self.sessions.items():
                    if getattr(sess, 'system_id', None) == sysid:
                        client_id = cid
                        break

            if client_id is None:
                logger.warning(f"SMS from unknown client session (system_id={sysid})")
                # Still log the SMS with failed status so it's not lost
                msg_id = pre_generated_msg_id or self.gateway.gen_msg_id()
                mcc_mnc = self.gateway.get_mcc_mnc(dest_number)
                ld = {
                    'message_id': msg_id, 'client_id': None,
                    'client_user': sysid or 'unknown', 'client_alias': '',
                    'supplier_id': None, 'supplier_user': '',
                    'route_id': None, 'route_name': '',
                    'trunk_id': None, 'channel': '', 'device': '',
                    'sender': source_number, 'recipient': dest_number, 'message_text': text,
                    'parts': max(1, (len(text) + 152) // 153),
                    'status': 'failed',
                    'mcc': mcc_mnc[:3], 'mnc': mcc_mnc[3:],
                    'in_msg_id': str(msg_id), 'out_msg_id': msg_id, 'supplier_msg_id': msg_id,
                    'client_rate': 0, 'supplier_rate': 0,
                    'cost': 0, 'pay': 0, 'profit': 0,
                    'ip_address': '',
                }
                self.db.log_sms(ld)
                logger.info(f"Failed SMS logged: {msg_id} (unknown session)")
                return

            logger.info(f"SUBMIT_SM: {source_number} -> {dest_number} '{text[:50]}' (client={client_id}, sysid={sysid})")

            mcc_mnc = self.gateway.get_mcc_mnc(dest_number)
            route = self.db.get_route(client_id, mcc_mnc)

            if route:
                cr = self.db.get_rate('client_rates', client_id, mcc_mnc)
                sr = self.db.get_rate('supplier_rates', route['supplier_id'], mcc_mnc)
                parts = max(1, (len(text) + 152) // 153)
                cost = sr * parts
                pay = cr * parts
                msg_id = pre_generated_msg_id or self.gateway.gen_msg_id()

                if cr > 0 and sr > 0 and cr > sr:
                    self.db.deduct_balance('clients', client_id, pay)
                    self.db.deduct_balance('suppliers', route['supplier_id'], cost)

                    ld = {
                        'message_id': msg_id, 'client_id': client_id,
                        'client_user': sysid or '', 'client_alias': '',
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

                    # Forward to supplier (async SMSC or executor for HTTP)
                    fwd_ok, sup_msg_id = await self.gateway.forward_to_supplier_async(
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

                    # Queue force DLR only if client has force_dlr enabled
                    if fwd_ok:
                        # Check client's force_dlr setting
                        fd_row, _ = self.db._fetchone(
                            "SELECT force_dlr FROM clients WHERE id=%s", (client_id,))
                        client_force_dlr = bool(fd_row and fd_row[0]) if fd_row else False
                        
                        if client_force_dlr:
                            self.db.queue_dlr(log_id, msg_id, client_id, route['supplier_id'], 'delivered')
                            self.db.update_dlr(msg_id, 'delivered')
                            # Apply force DLR timeout delay before sending DLR to client
                            try:
                                tout_row, _ = self.db._fetchone(
                                    "SELECT force_dlr_timeout FROM clients WHERE id=%s", (client_id,))
                                timeout_str = tout_row[0] if tout_row else '0'
                                if timeout_str == 'random':
                                    dlr_delay = random.uniform(0, 5)
                                else:
                                    try:
                                        dlr_delay = float(timeout_str)
                                    except (ValueError, TypeError):
                                        dlr_delay = 0.0
                                if dlr_delay > 0:
                                    logger.info(f"DLR timeout: waiting {dlr_delay:.1f}s for {msg_id}")
                                    await asyncio.sleep(dlr_delay)
                            except Exception as e:
                                logger.warning(f"DLR timeout lookup failed: {e}")
                            # Attempt immediate DLR send with proper esm_class=SMSC_DELIVERY_RECEIPT
                            try:
                                dlr_ok = await self.gateway._send_dlr_pdu(
                                    client._protocol,
                                    sender_number=source_number,
                                    recipient_number=dest_number,
                                    msg_id=msg_id,
                                    dlr_status='delivered',
                                )
                                if dlr_ok:
                                    self.db._execute(
                                        "UPDATE dlr_queue SET processed=true, processed_at=NOW() "
                                        "WHERE message_id=%s AND client_id=%s AND processed=false",
                                        (msg_id, client_id))
                                    logger.info(f"Force DLR sent to {sysid} for {msg_id}")
                                else:
                                    logger.warning(f"Force DLR send failed for {msg_id}, will retry via consumer")
                            except Exception as e:
                                logger.error(f"Force DLR send failed: {e}")
                        else:
                            logger.info(f"Client {sysid} (ID={client_id}) has force_dlr=false, waiting for real DLR for {msg_id}")
                else:
                    logger.warning(f"Rate validation failed: cr={cr} sr={sr}")
                    # Log failed SMS for rate issues too
                    ld = {
                        'message_id': msg_id, 'client_id': client_id,
                        'client_user': sysid or '', 'client_alias': '',
                        'supplier_id': route.get('supplier_id'),
                        'supplier_user': route.get('supplier_name', ''),
                        'route_id': route['route_id'], 'route_name': route.get('route_name', ''),
                        'trunk_id': route['trunk_id'], 'channel': route.get('trunk_name', ''),
                        'device': route.get('trunk_name', ''),
                        'sender': source_number, 'recipient': dest_number, 'message_text': text,
                        'parts': parts, 'status': 'failed',
                        'mcc': mcc_mnc[:3], 'mnc': mcc_mnc[3:],
                        'in_msg_id': str(msg_id), 'out_msg_id': msg_id, 'supplier_msg_id': msg_id,
                        'client_rate': cr, 'supplier_rate': sr,
                        'cost': 0, 'pay': 0, 'profit': 0,
                        'ip_address': '',
                    }
                    self.db.log_sms(ld)
                    logger.info(f"Failed SMS logged: {msg_id} (rate validation)")
            else:
                logger.warning(f"No route for client {client_id} (mcc_mnc={mcc_mnc})")
                # Log failed SMS for missing route
                msg_id = pre_generated_msg_id or self.gateway.gen_msg_id()
                ld = {
                    'message_id': msg_id, 'client_id': client_id,
                    'client_user': sysid or '', 'client_alias': '',
                    'supplier_id': None, 'supplier_user': '',
                    'route_id': None, 'route_name': '',
                    'trunk_id': None, 'channel': '', 'device': '',
                    'sender': source_number, 'recipient': dest_number, 'message_text': text,
                    'parts': max(1, (len(text) + 152) // 153),
                    'status': 'failed',
                    'mcc': mcc_mnc[:3], 'mnc': mcc_mnc[3:],
                    'in_msg_id': str(msg_id), 'out_msg_id': msg_id, 'supplier_msg_id': msg_id,
                    'client_rate': 0, 'supplier_rate': 0,
                    'cost': 0, 'pay': 0, 'profit': 0,
                    'ip_address': '',
                }
                self.db.log_sms(ld)
                logger.info(f"Failed SMS logged: {msg_id} (no route)")
        except Exception as e:
            logger.error(f"handle_sms_received error: {e}")
            import traceback
            logger.error(traceback.format_exc())


class SmppGatewayServer:
    """Main SMPP Gateway - ESMC + SMSC + REST bridge."""

    def __init__(self):
        self.db = DatabaseBridge()
        self.running = True
        self.supplier_stop = asyncio.Event()
        self.executor = ThreadPoolExecutor(max_workers=4)
        self.loop = None
        self.supplier_manager: Optional[SmppSupplierManager] = None
        self.app = Net2AppSmppApplication(self)

    def gen_msg_id(self):
        return f"N2A{datetime.now().strftime('%y%m%d%H%M%S')}{uuid.uuid4().hex[:8].upper()}"

    def get_mcc_mnc(self, num):
        if isinstance(num, bytes):
            num = num.decode('utf-8', errors='replace')
        c = num.lstrip('+').lstrip('00')
        for prefix, mccmnc in [('880', '47001'), ('91', '40468'), ('251', '63601'),
                               ('1', '310410'), ('44', '23430'), ('92', '41001')]:
            if c.startswith(prefix):
                return mccmnc
        return '47001'

    async def _send_dlr_pdu(self, protocol, sender_number, recipient_number, msg_id, dlr_status):
        """Send a proper DLR deliver_sm PDU with correct esm_class=SMSC_DELIVERY_RECEIPT.
        
        Bypasses smppy's client.send_sms() / send_deliver_sm because that method
        hardcodes EsmClassType.DEFAULT (0) instead of EsmClassType.SMSC_DELIVERY_RECEIPT (0x04).
        Without the correct esm_class bit set, SMPP clients will not recognize the
        incoming message as a delivery receipt.
        
        Args:
            protocol: SmppProtocol instance of the connected client
            sender_number: original source number from submit_sm (DLR destination)
            recipient_number: original destination number from submit_sm (DLR source)
            msg_id: internal message ID
            dlr_status: delivery status string
        """
        try:
            status_map = {
                'delivered': 'DELIVRD', 'failed': 'UNDELIV',
                'submitted': 'ACCEPTD', 'expired': 'EXPIRED', 'rejected': 'REJECTD',
            }
            smpp_stat = status_map.get(dlr_status or 'delivered', 'DELIVRD')

            dlr_text = (
                f"id:{msg_id} sub:001 dlvrd:001 "
                f"submit date:{datetime.now().strftime('%y%m%d%H%M')} "
                f"done date:{datetime.now().strftime('%y%m%d%H%M')} "
                f"stat:{smpp_stat} err:000"
            )
            msg_bytes = dlr_text.encode('ascii')

            pdu = DeliverSM(
                sequence_number=protocol.next_sequence_number(),
                service_type='',
                source_addr_ton=AddrTon.INTERNATIONAL,
                source_addr_npi=AddrNpi.ISDN,
                source_addr=recipient_number,
                dest_addr_ton=AddrTon.INTERNATIONAL,
                dest_addr_npi=AddrNpi.ISDN,
                destination_addr=sender_number,
                esm_class=EsmClass(EsmClassMode.DEFAULT, EsmClassType.SMSC_DELIVERY_RECEIPT),
                protocol_id=0,
                priority_flag=PriorityFlag.LEVEL_0,
                registered_delivery=RegisteredDelivery(
                    RegisteredDeliveryReceipt.NO_SMSC_DELIVERY_RECEIPT_REQUESTED),
                replace_if_present_flag=ReplaceIfPresentFlag.DO_NOT_REPLACE,
                data_coding=DataCoding(scheme_data=DataCodingDefault.SMSC_DEFAULT_ALPHABET),
                short_message=msg_bytes,
            )
            protocol._send_PDU(pdu)
            logger.info(f"DLR sent: {msg_id} -> {smpp_stat} (src={recipient_number}, dst={sender_number})")
            return True
        except Exception as e:
            logger.error(f"_send_dlr_pdu failed: {e}")
            return False



    async def send_via_smsc_async(self, sender, recipient, message, supplier_id):
        """Send via SMSC supplier using the dynamic supplier manager."""
        if not self.supplier_manager:
            logger.error("Supplier manager not initialized")
            return False, None
        return await self.supplier_manager.send_via_supplier(
            supplier_id, sender, recipient, message)

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

    async def forward_to_supplier_async(self, sender, recipient, message, route):
        """Forward SMS to the appropriate supplier (async for SMSC, executor for HTTP)."""
        conn_type = route.get('supplier_conn_type', 'smpp')
        supplier_id = route.get('supplier_id')
        if not supplier_id:
            logger.error("No supplier_id in route")
            return False, None
        if conn_type == 'http':
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(
                self.executor, self.send_via_http_api_sync,
                sender, recipient, message, route)
        else:
            return await self.send_via_smsc_async(
                sender, recipient, message, supplier_id)

    async def http_api(self):
        """HTTP REST API bridge on port 9000."""
        from aiohttp import web

        async def status(req):
            supplier_list = []
            if self.supplier_manager:
                supplier_list = self.supplier_manager.get_status_list()
            return web.json_response({
                'server': 'running',
                'esmc_host': ESMC_HOST,
                'esmc_port': ESMC_PORT,
                'sessions': len(self.app.sessions),
                'session_list': [
                    {'client_id': cid, 'system_id': s.system_id,
                     'addr': str(s._protocol._transport.get_extra_info('peername'))
                        if s._protocol and s._protocol._transport
                        and hasattr(s._protocol._transport, 'get_extra_info') else ''}
                    for cid, s in self.app.sessions.items()
                ],
                'suppliers_connected': len(supplier_list),
                'suppliers': supplier_list,
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

                    fwd_ok, sup_msg_id = await self.forward_to_supplier_async(
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

                # Force DLR only if client has force_dlr enabled
                if fwd_ok:
                    fd_row, _ = self.db._fetchone(
                        "SELECT force_dlr FROM clients WHERE id=%s", (client_id,))
                    client_force_dlr = bool(fd_row and fd_row[0]) if fd_row else False
                    if client_force_dlr:
                        self.db.queue_dlr(log_id, msg_id, client_id, route['supplier_id'], 'delivered')
                        self.db.update_dlr(msg_id, 'delivered')

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

        async def rebind(req):
            """Force rebind a client or supplier session.
            Body: { entity_type: "client"|"supplier", entity_id: number }
            For clients: force-disconnects their SMPP session
            For suppliers: disconnects and reconnects via supplier manager
            """
            try:
                data = await req.json()
                entity_type = data.get('entity_type', '')
                entity_id = int(data.get('entity_id', 0))
                if not entity_type or not entity_id:
                    return web.json_response({'error': 'entity_type and entity_id required'}, status=400)

                if entity_type == 'client':
                    # Force disconnect the client session
                    sess = self.app.sessions.pop(entity_id, None)
                    if sess:
                        try:
                            sess._protocol._transport.close()
                        except Exception:
                            pass
                        self.db.set_bind_status('clients', entity_id, 'unbound',
                                                sess.system_id, '')
                        logger.info(f"Rebind: force-disconnected client {entity_id} ({sess.system_id})")
                        return web.json_response({
                            'success': True,
                            'message': f'Client {sess.system_id} disconnected. They will auto-reconnect.'
                        })
                    else:
                        return web.json_response({
                            'success': True,
                            'message': 'Client was not connected'
                        })

                elif entity_type == 'supplier':
                    if not self.supplier_manager:
                        return web.json_response({'error': 'Supplier manager not initialized'}, status=500)
                    # Force disconnect and reconnect
                    await self.supplier_manager.disconnect_supplier(entity_id)
                    logger.info(f"Rebind: force-disconnected supplier {entity_id}")
                    return web.json_response({
                        'success': True,
                        'message': f'Supplier {entity_id} disconnected. Manager will auto-reconnect.'
                    })

                return web.json_response({'error': 'Invalid entity_type'}, status=400)

            except Exception as e:
                logger.error(f"Rebind error: {e}")
                return web.json_response({'error': str(e)}, status=500)

        app = web.Application()
        app.router.add_get('/api/smpp/status', status)
        app.router.add_post('/api/smpp/send', send)
        app.router.add_post('/api/smpp/dlr', dlr)
        app.router.add_post('/api/smpp/rebind', rebind)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', API_PORT)
        await site.start()
        logger.info(f"REST API bridge: http://127.0.0.1:{API_PORT}")
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

    async def _dlr_consumer(self):
        """Background task: process dlr_queue and send DLRs to SMPP clients."""
        while self.running:
            try:
                await asyncio.sleep(5)
                # Fetch unprocessed DLR entries with sender and recipient from sms_logs
                rows = self.db._fetchall(
                    "SELECT dq.id, dq.sms_log_id, dq.message_id, dq.client_id, dq.dlr_status, "
                    "COALESCE(sl.sender, '') as source_number, "
                    "COALESCE(sl.recipient, '') as dest_number "
                    "FROM dlr_queue dq "
                    "LEFT JOIN sms_logs sl ON sl.id = dq.sms_log_id "
                    "WHERE dq.processed=false AND dq.direction='supplier_to_client' "
                    "ORDER BY dq.id ASC LIMIT 50")
                if not rows:
                    continue
                for row in rows:
                    dq_id, sms_log_id, msg_id, client_id, dlr_status, source_number, dest_number = row
                    if client_id is None:
                        self.db._execute("UPDATE dlr_queue SET processed=true, processed_at=NOW() WHERE id=%s", (dq_id,))
                        continue
                    # Find SMPP client session
                    sess = self.app.sessions.get(client_id)
                    if sess is None:
                        continue  # Client not connected, will retry
                    # Send DLR via direct DeliverSM PDU with correct esm_class=SMSC_DELIVERY_RECEIPT
                    try:
                        dlr_ok = await self._send_dlr_pdu(
                            sess._protocol,
                            sender_number=source_number,
                            recipient_number=dest_number,
                            msg_id=msg_id,
                            dlr_status=dlr_status or 'delivered',
                        )
                        if dlr_ok:
                            self.db._execute(
                                "UPDATE dlr_queue SET processed=true, processed_at=NOW() WHERE id=%s", (dq_id,))
                            logger.info(f"DLR consumer: sent DLR to client {client_id} for {msg_id} ({dlr_status})")
                        else:
                            self.db._execute(
                                "UPDATE dlr_queue SET retry_count=COALESCE(retry_count,0)+1 WHERE id=%s", (dq_id,))
                    except Exception as e:
                        logger.warning(f"DLR consumer: failed to send DLR to client {client_id}: {e}")
                        self.db._execute(
                            "UPDATE dlr_queue SET retry_count=COALESCE(retry_count,0)+1 WHERE id=%s", (dq_id,))
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"DLR consumer error: {e}")

    async def run(self):
        """Start all components."""
        self.loop = asyncio.get_event_loop()

        # Initialize supplier manager for dynamic SMSC connections
        self.supplier_manager = SmppSupplierManager(self)

        logger.info("╔══════════════════════════════════════════════╗")
        logger.info("║   Net2App Blast SMPP Gateway Server v3     ║")
        logger.info("╠══════════════════════════════════════════════╣")
        logger.info(f"║  ESMC:  {ESMC_HOST}:{ESMC_PORT} (smppy)                     ║")
        logger.info(f"║  REST:  http://127.0.0.1:{API_PORT}              ║")
        logger.info(f"║  SMSC:  Dynamic (from DB)          ║")
        logger.info("╚══════════════════════════════════════════════╝")

        tasks = [
            asyncio.create_task(self.http_api()),
            asyncio.create_task(self._esmc_keepalive()),
            asyncio.create_task(self._dlr_consumer()),
            asyncio.create_task(self.supplier_manager.manager_worker()),
        ]

        # Start ESMC server using a custom protocol that cleans up on disconnect
        # Uses smppy native PDU handling (including submit_sm) — the base class
        # already decodes PDUs, sends submit_sm_resp, handles concatenated
        # messages, and calls app.handle_sms_received.
        # The DLR text body contains the message_id (id:N2A...) so ESME clients
        # can correlate DLRs even without the message_id in submit_sm_resp.
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
        esmc_server = await self.loop.create_server(factory, host=ESMC_HOST,
                                                    port=ESMC_PORT)

        async def serve_esmc():
            logger.info(f"ESMC listening on {ESMC_HOST}:{ESMC_PORT} (smppy)")
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
            if self.supplier_manager:
                await self.supplier_manager.shutdown()


def main():
    server = SmppGatewayServer()

    def shutdown(sig, frame):
        logger.info(f"Signal {sig}, shutting down...")
        server.running = False
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
