/**
 * Type declarations for the `smpp` npm package (v0.6.0-rc.4).
 * The package has no @types/smpp, so we declare what we use.
 */

declare module "smpp" {
  export interface PDU {
    command_status: number;
    command: string;
    system_id?: string;
    password?: string;
    source_addr?: string | Buffer;
    destination_addr?: string | Buffer;
    short_message?: string | Buffer;
    esm_class?: number;
    message_id?: string;
    [key: string]: unknown;
    response(): PDU;
  }

  export interface Session {
    send(pdu: PDU, callback?: (resp: PDU) => void): void;
    close(): void;
    on(event: string, listener: (...args: any[]) => void): this;
    socket?: { remoteAddress?: string; remotePort?: number };
    system_id?: string;
  }

  export function connect(
    options: { url: string; debug?: boolean },
    callback?: () => void,
  ): Session;

  export function createServer(
    options: { debug?: boolean },
    callback: (session: Session) => void,
  ): {
    listen(port: number, host: string, cb: () => void): void;
    on(event: string, cb: (err: Error) => void): void;
    close(): void;
  };

  export class PDU {
    constructor(command: string, options?: Record<string, unknown>);
    command_status: number;
    response(): PDU;
  }
}
