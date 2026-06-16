import { v4 as uuidv4 } from "uuid";

export function generateMessageId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = uuidv4().replace(/-/g, "").substring(0, 10).toUpperCase();
  return `N2A${timestamp}${random}`;
}

export function generateApiKey(): string {
  return `n2a_${uuidv4().replace(/-/g, "")}`;
}

export function generateInvoiceNumber(seq: number): string {
  const yr = new Date().getFullYear();
  return `INV-${yr}-${String(seq).padStart(3, "0")}`;
}

export function generateCode(prefix: string): string {
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}_${random}`;
}

export function isGsm7(text: string): boolean {
  return /^[\x20-\x7E\n\r]*$/.test(text);
}

export function getSmsEncoding(text: string): "GSM-7" | "UCS-2" {
  return isGsm7(text) ? "GSM-7" : "UCS-2";
}

export function getSmsByteSize(text: string): number {
  if (isGsm7(text)) {
    // GSM-7: 7 bits per char, packed into octets
    return Math.ceil((text.length * 7) / 8);
  }
  // UCS-2: 2 bytes per character
  return text.length * 2;
}

export function calculateSmsParts(text: string): number {
  if (isGsm7(text)) {
    return text.length <= 160 ? 1 : Math.ceil(text.length / 153);
  }
  // UCS-2 (Unicode): 70 chars single part, 67 per part for multipart
  return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
}

export function generateCaptcha(): { question: string; answer: number } {
  const ops = ['+', '-', '*'];
  const op = ops[Math.floor(Math.random() * ops.length)];
  let a = Math.floor(Math.random() * 10) + 1;
  let b = Math.floor(Math.random() * 10) + 1;
  if (op === '-' && b > a) [a, b] = [b, a];
  let answer: number;
  switch (op) {
    case '+': answer = a + b; break;
    case '-': answer = a - b; break;
    case '*': answer = a * b; break;
    default: answer = a + b;
  }
  return { question: `${a} ${op} ${b} = ?`, answer };
}

// Country + operator seed data with dial codes
export const COUNTRIES_OPERATORS: {
  country: string;
  code: string;
  dialCode: string;
  mcc: string;
  operators: { name: string; mnc: string }[];
}[] = [
  {
    country: "Bangladesh",
    code: "BD",
    dialCode: "+880",
    mcc: "470",
    operators: [
      { name: "Grameenphone", mnc: "01" },
      { name: "Banglalink", mnc: "03" },
      { name: "Robi", mnc: "02" },
      { name: "Airtel", mnc: "07" },
      { name: "Teletalk", mnc: "04" },
    ],
  },
  {
    country: "India",
    code: "IN",
    dialCode: "+91",
    mcc: "404",
    operators: [
      { name: "Jio", mnc: "68" },
      { name: "Airtel", mnc: "10" },
      { name: "Vodafone Idea", mnc: "20" },
      { name: "BSNL", mnc: "59" },
    ],
  },
  {
    country: "United States",
    code: "US",
    dialCode: "+1",
    mcc: "310",
    operators: [
      { name: "AT&T", mnc: "410" },
      { name: "T-Mobile", mnc: "260" },
      { name: "Verizon", mnc: "012" },
    ],
  },
  {
    country: "United Kingdom",
    code: "GB",
    dialCode: "+44",
    mcc: "234",
    operators: [
      { name: "EE", mnc: "30" },
      { name: "O2", mnc: "10" },
      { name: "Vodafone", mnc: "15" },
      { name: "Three", mnc: "20" },
    ],
  },
  {
    country: "Pakistan",
    code: "PK",
    dialCode: "+92",
    mcc: "410",
    operators: [
      { name: "Jazz", mnc: "01" },
      { name: "Zong", mnc: "04" },
      { name: "Telenor", mnc: "06" },
      { name: "Ufone", mnc: "03" },
    ],
  },
  {
    country: "Malaysia",
    code: "MY",
    dialCode: "+60",
    mcc: "502",
    operators: [
      { name: "Maxis", mnc: "12" },
      { name: "Celcom", mnc: "13" },
      { name: "Digi", mnc: "16" },
      { name: "U Mobile", mnc: "18" },
    ],
  },
  {
    country: "Indonesia",
    code: "ID",
    dialCode: "+62",
    mcc: "510",
    operators: [
      { name: "Telkomsel", mnc: "10" },
      { name: "Indosat", mnc: "01" },
      { name: "XL Axiata", mnc: "11" },
    ],
  },
  {
    country: "Saudi Arabia",
    code: "SA",
    dialCode: "+966",
    mcc: "420",
    operators: [
      { name: "STC", mnc: "01" },
      { name: "Mobily", mnc: "03" },
      { name: "Zain", mnc: "04" },
    ],
  },
  {
    country: "UAE",
    code: "AE",
    dialCode: "+971",
    mcc: "424",
    operators: [
      { name: "Etisalat", mnc: "02" },
      { name: "Du", mnc: "03" },
    ],
  },
  {
    country: "Nigeria",
    code: "NG",
    dialCode: "+234",
    mcc: "621",
    operators: [
      { name: "MTN", mnc: "30" },
      { name: "Airtel", mnc: "20" },
      { name: "Glo", mnc: "50" },
      { name: "9mobile", mnc: "60" },
    ],
  },
  {
    country: "South Africa",
    code: "ZA",
    dialCode: "+27",
    mcc: "655",
    operators: [
      { name: "Vodacom", mnc: "01" },
      { name: "MTN", mnc: "10" },
      { name: "Cell C", mnc: "07" },
    ],
  },
  {
    country: "Germany",
    code: "DE",
    dialCode: "+49",
    mcc: "262",
    operators: [
      { name: "T-Mobile", mnc: "01" },
      { name: "Vodafone", mnc: "02" },
      { name: "O2", mnc: "07" },
    ],
  },
  {
    country: "France",
    code: "FR",
    dialCode: "+33",
    mcc: "208",
    operators: [
      { name: "Orange", mnc: "01" },
      { name: "SFR", mnc: "10" },
      { name: "Bouygues", mnc: "20" },
      { name: "Free", mnc: "15" },
    ],
  },
  {
    country: "Brazil",
    code: "BR",
    dialCode: "+55",
    mcc: "724",
    operators: [
      { name: "Vivo", mnc: "11" },
      { name: "Claro", mnc: "05" },
      { name: "TIM", mnc: "04" },
      { name: "Oi", mnc: "31" },
    ],
  },
  {
    country: "Philippines",
    code: "PH",
    dialCode: "+63",
    mcc: "515",
    operators: [
      { name: "Globe", mnc: "02" },
      { name: "Smart", mnc: "03" },
      { name: "DITO", mnc: "18" },
    ],
  },
  {
    country: "Ethiopia",
    code: "ET",
    dialCode: "+251",
    mcc: "636",
    operators: [
      { name: "Ethio Telecom", mnc: "01" },
      { name: "Safaricom Ethiopia", mnc: "02" },
    ],
  },
];

// Bangladeshi API Providers
export const BD_API_PROVIDERS = [
  {
    name: "SMS Sheba",
    code: "SMSSHEBA",
    country: "Bangladesh",
    apiUrl: "https://api.smssheba.com/smsapiv3",
    apiMethod: "GET",
    authType: "apikey",
    apiKeyParam: "apikey",
    apiKeyValue: "17a0c9ff557a81eccafefb624443573c",
    senderParam: "sender",
    recipientParam: "msisdn",
    messageParam: "smstext",
    responseType: "json",
    successField: "response.0.status",
    successValue: "0",
    messageIdField: "response.0.id",
    statusField: "response.0.status",
    isActive: true,
  },
  {
    name: "SSL Wireless",
    code: "SSLWIRELESS",
    country: "Bangladesh",
    apiUrl: "https://smsplus.sslwireless.com/api/v3/send-sms",
    apiMethod: "POST",
    authType: "apikey",
    apiKeyParam: "api_token",
    apiKeyValue: "",
    senderParam: "sid",
    recipientParam: "msisdn",
    messageParam: "sms",
    responseType: "json",
    successField: "status",
    successValue: "SUCCESS",
    messageIdField: "smsinfo.0.sms_id",
    statusField: "status",
    isActive: false,
  },
  {
    name: "Onnorokom SMS",
    code: "ONNOROKOM",
    country: "Bangladesh",
    apiUrl: "https://api2.onnorokomsms.com/SendSMS",
    apiMethod: "POST",
    authType: "basic",
    apiKeyParam: "apiKey",
    apiKeyValue: "",
    senderParam: "maskName",
    recipientParam: "mobileNumber",
    messageParam: "smsBody",
    responseType: "json",
    successField: "Status",
    successValue: "0",
    messageIdField: "Data",
    statusField: "Status",
    isActive: false,
  },
  {
    name: "Infobip BD",
    code: "INFOBIPBD",
    country: "Bangladesh",
    apiUrl: "https://api.infobip.com/sms/2/text/advanced",
    apiMethod: "POST",
    authType: "bearer",
    apiKeyParam: "Authorization",
    apiKeyValue: "",
    senderParam: "from",
    recipientParam: "to",
    messageParam: "text",
    responseType: "json",
    successField: "messages.0.status.groupName",
    successValue: "PENDING",
    messageIdField: "messages.0.messageId",
    statusField: "messages.0.status.name",
    isActive: false,
  },
  {
    name: "Reve SMS",
    code: "REVESMS",
    country: "Bangladesh",
    apiUrl: "https://api.revesoft.com/sms/send",
    apiMethod: "POST",
    authType: "apikey",
    apiKeyParam: "apikey",
    apiKeyValue: "",
    senderParam: "sender_id",
    recipientParam: "to",
    messageParam: "message",
    responseType: "json",
    successField: "status",
    successValue: "success",
    messageIdField: "message_id",
    statusField: "status",
    isActive: false,
  },
  {
    name: "Bulk SMS BD",
    code: "BULKSMSBD",
    country: "Bangladesh",
    apiUrl: "https://bulksmsbd.net/api/smsapi",
    apiMethod: "POST",
    authType: "apikey",
    apiKeyParam: "api_key",
    apiKeyValue: "",
    senderParam: "senderid",
    recipientParam: "number",
    messageParam: "message",
    responseType: "json",
    successField: "response_code",
    successValue: "202",
    messageIdField: "message_id",
    statusField: "response_code",
    isActive: false,
  },
  {
    name: "Muthofun SMS",
    code: "MUTHOFUN",
    country: "Bangladesh",
    apiUrl: "https://www.maborumedia.com/api/sms",
    apiMethod: "POST",
    authType: "apikey",
    apiKeyParam: "api_key",
    apiKeyValue: "",
    senderParam: "sender",
    recipientParam: "receiver",
    messageParam: "msg",
    responseType: "json",
    successField: "status",
    successValue: "1",
    messageIdField: "msg_id",
    statusField: "status",
    isActive: false,
  },
  {
    name: "ADN SMS",
    code: "ADNSMS",
    country: "Bangladesh",
    apiUrl: "https://portal.adnsms.com/api/v1/secure/send-sms",
    apiMethod: "POST",
    authType: "apikey",
    apiKeyParam: "api_key",
    apiKeyValue: "",
    senderParam: "sender",
    recipientParam: "recipient",
    messageParam: "message",
    responseType: "json",
    successField: "api_response_code",
    successValue: "200",
    messageIdField: "campaign_uid",
    statusField: "api_response_code",
    isActive: false,
  },
];
