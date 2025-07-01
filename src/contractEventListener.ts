import { WebSocketProvider, Contract } from "ethers";

const messageQueue: any[] = [];
let isProcessingQueue = false;

const provider = new WebSocketProvider("wss:");

const contractAddress = "";
const contractAbi = [
  ""
];

const contract = new Contract(contractAddress, contractAbi, provider);

/**
 * 将事件推入队列
 */
function enqueueMessage(eventData: any) {
  messageQueue.push(eventData);
  console.log(`✅ 新事件已入队，当前队列长度：${messageQueue.length}`);
  processQueue();
}

/**
 * 处理队列
 */
async function processQueue() {
  if (isProcessingQueue) return;

  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    const message = messageQueue.shift();
    try {
      console.log(`🚀 正在处理事件:`, message);
      await handleEvent(message);
    } catch (err) {
      console.error(`❌ 处理事件失败:`, err);
    }
  }

  isProcessingQueue = false;
}

async function handleEvent(eventData: any) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log(`🎉 已处理事件：`, eventData);
}


export function startListening() {
  console.log("🔗 开始监听合约事件...");

  contract.on("YourEvent", (id, from, data, event) => {
    const eventData = {
      id: id.toString(),
      from,
      data,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
    };

    console.log(`📥 捕获事件:`, eventData);
    enqueueMessage(eventData);
  });

  provider.on("error", (err: any) => {
    console.error("❌ WebSocket 错误:", err);
  });

  provider.on("close", (code: number) => {
    console.warn(`⚠ WebSocket 连接关闭，代码: ${code}`);
  });
}
