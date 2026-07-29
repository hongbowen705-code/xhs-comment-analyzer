var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var import_node_net = __toESM(require("node:net"), 1);

// ../../packages/shared/src/index.ts
var SCHEMA_VERSION = "1.0";
var PIPE_NAME = "\\\\.\\pipe\\xhs-comment-analyzer-prototype-v1";
var MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
var MESSAGE_TYPES = [
  "capability_check",
  "create_task",
  "task_created",
  "start_capture",
  "stop_capture",
  "comment_batch",
  "progress",
  "capture_completed",
  "capture_paused",
  "error",
  "audit_event"
];
function createEnvelope(messageType, payload, taskId = null, requestId = crypto.randomUUID()) {
  return {
    schema_version: SCHEMA_VERSION,
    request_id: requestId,
    task_id: taskId,
    message_type: messageType,
    sent_at: (/* @__PURE__ */ new Date()).toISOString(),
    payload
  };
}
function isEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  const record = value;
  return record.schema_version === SCHEMA_VERSION && typeof record.request_id === "string" && (record.task_id === null || typeof record.task_id === "string") && typeof record.message_type === "string" && MESSAGE_TYPES.includes(record.message_type) && typeof record.sent_at === "string" && "payload" in record;
}

// src/framing.ts
var NativeMessageDecoder = class {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_NATIVE_MESSAGE_BYTES) {
        throw new Error(`Native Messaging \u6D88\u606F\u5927\u5C0F\u975E\u6CD5: ${length}`);
      }
      if (this.buffer.length < length + 4) break;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      messages.push(JSON.parse(body.toString("utf8")));
    }
    return messages;
  }
};
function encodeNativeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error(`Native Messaging \u54CD\u5E94\u8D85\u8FC7 ${MAX_NATIVE_MESSAGE_BYTES} \u5B57\u8282`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// src/index.ts
var origin = process.argv.find((arg) => arg.startsWith("chrome-extension://")) ?? "";
var decoder = new NativeMessageDecoder();
var pipe = import_node_net.default.createConnection(PIPE_NAME);
var connected = false;
var pipeBuffer = "";
function sendChrome(envelope) {
  process.stdout.write(encodeNativeMessage(envelope));
}
pipe.once("connect", () => {
  connected = true;
  process.stdin.resume();
});
pipe.setEncoding("utf8");
pipe.on("data", (chunk) => {
  pipeBuffer += chunk;
  let newline = pipeBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = pipeBuffer.slice(0, newline);
    pipeBuffer = pipeBuffer.slice(newline + 1);
    if (line.trim()) {
      try {
        const parsed = JSON.parse(line);
        if (!isEnvelope(parsed)) throw new Error("\u684C\u9762\u7AEF\u8FD4\u56DE\u4E86\u65E0\u6548\u4FE1\u5C01");
        sendChrome(parsed);
      } catch (error) {
        sendChrome(createEnvelope("error", {
          code: "INVALID_DESKTOP_RESPONSE",
          message: error instanceof Error ? error.message : "\u684C\u9762\u7AEF\u54CD\u5E94\u89E3\u6790\u5931\u8D25",
          recoverable: false
        }));
      }
    }
    newline = pipeBuffer.indexOf("\n");
  }
});
pipe.once("error", (error) => {
  console.error(`Native Host \u65E0\u6CD5\u8FDE\u63A5\u684C\u9762\u7AEF: ${error.message}`);
  sendChrome(createEnvelope("error", {
    code: "DESKTOP_NOT_RUNNING",
    message: "\u684C\u9762\u7AEF\u672A\u542F\u52A8\u6216\u672C\u5730\u901A\u4FE1\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5148\u6253\u5F00\u684C\u9762\u8F6F\u4EF6\u3002",
    recoverable: true
  }));
  setTimeout(() => process.exit(2), 50);
});
process.stdin.on("data", (chunk) => {
  try {
    for (const envelope of decoder.push(chunk)) {
      if (!connected) throw new Error("\u684C\u9762\u7AEF\u5C1A\u672A\u8FDE\u63A5");
      if (!isEnvelope(envelope)) throw new Error("\u6269\u5C55\u6D88\u606F\u4FE1\u5C01\u65E0\u6548");
      pipe.write(`${JSON.stringify(envelope)}
`);
    }
  } catch (error) {
    sendChrome(createEnvelope("error", {
      code: "INVALID_EXTENSION_MESSAGE",
      message: error instanceof Error ? error.message : "\u6269\u5C55\u6D88\u606F\u89E3\u6790\u5931\u8D25",
      recoverable: false
    }));
    process.exitCode = 3;
    process.stdin.pause();
    pipe.end();
  }
});
process.stdin.on("end", () => pipe.end());
pipe.on("close", () => process.exit(process.exitCode ?? 0));
if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)) {
  console.error("Native Host \u8C03\u7528\u6765\u6E90\u53C2\u6570\u7F3A\u5931\u6216\u975E\u6CD5\u3002");
}
