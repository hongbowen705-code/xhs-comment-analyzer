import { MAX_NATIVE_MESSAGE_BYTES, type Envelope } from "@xhs/shared";

export class NativeMessageDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Envelope[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: Envelope[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_NATIVE_MESSAGE_BYTES) {
        throw new Error(`Native Messaging 消息大小非法: ${length}`);
      }
      if (this.buffer.length < length + 4) break;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      messages.push(JSON.parse(body.toString("utf8")) as Envelope);
    }
    return messages;
  }
}

export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error(`Native Messaging 响应超过 ${MAX_NATIVE_MESSAGE_BYTES} 字节`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
