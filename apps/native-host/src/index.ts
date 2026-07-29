import net from "node:net";
import {
  PIPE_NAME,
  createEnvelope,
  isEnvelope,
  type Envelope
} from "@xhs/shared";
import { encodeNativeMessage, NativeMessageDecoder } from "./framing.js";

const origin = process.argv.find((arg) => arg.startsWith("chrome-extension://")) ?? "";
const decoder = new NativeMessageDecoder();
const pipe = net.createConnection(PIPE_NAME);
let connected = false;
let pipeBuffer = "";

function sendChrome(envelope: Envelope): void {
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
        if (!isEnvelope(parsed)) throw new Error("桌面端返回了无效信封");
        sendChrome(parsed);
      } catch (error) {
        sendChrome(createEnvelope("error", {
          code: "INVALID_DESKTOP_RESPONSE",
          message: error instanceof Error ? error.message : "桌面端响应解析失败",
          recoverable: false
        }));
      }
    }
    newline = pipeBuffer.indexOf("\n");
  }
});

pipe.once("error", (error) => {
  console.error(`Native Host 无法连接桌面端: ${error.message}`);
  sendChrome(createEnvelope("error", {
    code: "DESKTOP_NOT_RUNNING",
    message: "桌面端未启动或本地通信不可用，请先打开桌面软件。",
    recoverable: true
  }));
  setTimeout(() => process.exit(2), 50);
});

process.stdin.on("data", (chunk: Buffer) => {
  try {
    for (const envelope of decoder.push(chunk)) {
      if (!connected) throw new Error("桌面端尚未连接");
      if (!isEnvelope(envelope)) throw new Error("扩展消息信封无效");
      pipe.write(`${JSON.stringify(envelope)}\n`);
    }
  } catch (error) {
    sendChrome(createEnvelope("error", {
      code: "INVALID_EXTENSION_MESSAGE",
      message: error instanceof Error ? error.message : "扩展消息解析失败",
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
  console.error("Native Host 调用来源参数缺失或非法。");
}
