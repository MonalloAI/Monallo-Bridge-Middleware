import { WebSocketProvider, Contract } from "ethers";
import abi from "./abi/abi.json";
import { connectDB } from './db';
import { EventModel } from './event.model';

const messageQueue: any[] = [];
let isProcessingQueue = false;

const contractAddress = "0x2Ab892c26BEED9744E5a9d72fB50851E1876AD16";
const contractAbi = abi.abi;

let provider: WebSocketProvider;
let contract: Contract;

function enqueueMessage(eventData: any) {
  messageQueue.push(eventData);
  console.log(`✅ 新事件已入队，当前队列长度：${messageQueue.length}`);
  processQueue();
}

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
  // 这里只做业务处理，不写入数据库
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log(`🎉 已处理事件：`, eventData);
}

function setupListeners() {
  if (!contract) return;
  contract.removeAllListeners(); // 防止重复监听

  // 监听 Transfer 事件
  contract.on("Transfer", async (from, to, value, event) => {
    const eventData = {
      event: "Transfer",
      from,
      to,
      value: value.toString(),
      blockNumber: event.log?.blockNumber,
      transactionHash: event.log?.transactionHash,
      logIndex: event.log?.logIndex
    };
    console.log(`📥 捕获 Transfer 事件:`, eventData);
    // 捕获时写入数据库
    try {
      await EventModel.create(eventData);
    } catch (err: any) {
      if (err.code === 11000) {
        console.log('⚠️ 事件已存在，跳过重复写入:', eventData.transactionHash, eventData.blockNumber);
      } else {
        console.error('❌ 写入数据库失败:', err);
      }
    }
    enqueueMessage(eventData);
  });

  // 监听 Approval 事件
  contract.on("Approval", async (owner, spender, value, event) => {
    const eventData = {
      event: "Approval",
      owner,
      spender,
      value: value.toString(),
      blockNumber: event.log?.blockNumber,
      transactionHash: event.log?.transactionHash,
      logIndex: event.log?.logIndex
    };
    console.log(`📥 捕获 Approval 事件:`, eventData); 
    // 捕获时写入数据库
    try {
      await EventModel.create(eventData);
    } catch (err: any) {
      if (err.code === 11000) {
        console.log('⚠️ 事件已存在，跳过重复写入:', eventData.transactionHash, eventData.blockNumber);
      } else {
        console.error('❌ 写入数据库失败:', err);
      }
    }
    enqueueMessage(eventData);
  });
}

function createProviderAndContract() {
  provider = new WebSocketProvider("wss://eth-sepolia.g.alchemy.com/v2/NqV4OiKFv5guVW6t0Gd-HUyKurubau5L");
  contract = new Contract(contractAddress, contractAbi, provider);
}

function handleProviderEvents() {
  // @ts-ignore
  provider._websocket?.on("close", (code: number) => {
    console.error(`WebSocket 关闭，code: ${code}，尝试重连...`);
    reconnect();
  });
  // @ts-ignore
  provider._websocket?.on("error", (err: any) => {
    console.error("WebSocket 错误:", err);
    reconnect();
  });
}

function reconnect() {
  setTimeout(async () => {
    try {
      createProviderAndContract();
      setupListeners();
      handleProviderEvents();
      console.log("✅ 已重连 WebSocketProvider 并重新监听事件");
    } catch (err) {
      console.error("重连失败，稍后重试...", err);
      setTimeout(reconnect, 5000);
    }
  }, 5000);
}

export function startListening() {
  setupListeners();
}

(async () => {
  await connectDB();
  createProviderAndContract();
  setupListeners();
  handleProviderEvents();
})();
