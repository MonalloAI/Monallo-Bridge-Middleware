"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startListening = startListening;
const ethers_1 = require("ethers");
const dotenv = __importStar(require("dotenv"));
const LockTokens_json_1 = __importDefault(require("./abi/LockTokens.json"));
const MintTokens_json_1 = __importDefault(require("./abi/MintTokens.json"));
const db_1 = require("./db");
const CrossBridgeRecord_model_1 = __importDefault(require("./model/CrossBridgeRecord.model"));
const websocket_1 = require("./WebSocket/websocket");
const queueChecker_1 = require("./utils/queueChecker");
dotenv.config();
const { LOCK_CONTRACT_ADDRESS, MINT_CONTRACT_ADDRESS, PRIVATE_KEY, IMUA_RPC_URL, ETH_RPC_URL, ETH_API_KEY } = process.env;
if (!LOCK_CONTRACT_ADDRESS || !MINT_CONTRACT_ADDRESS || !PRIVATE_KEY || !IMUA_RPC_URL || !ETH_RPC_URL) {
    throw new Error('请检查 .env 文件，相关环境变量未配置完整');
}
// ✅ A 链 WebSocket Provider & Lock 合约
const aProvider = new ethers_1.ethers.WebSocketProvider(`${ETH_RPC_URL}${ETH_API_KEY}`);
const lockContract = new ethers_1.ethers.Contract(LOCK_CONTRACT_ADDRESS, LockTokens_json_1.default.abi, aProvider);
// ✅ B 链 WebSocket Provider & Mint 合约
const bProvider = new ethers_1.ethers.WebSocketProvider(IMUA_RPC_URL);
const bWallet = new ethers_1.ethers.Wallet(PRIVATE_KEY, bProvider);
const mintContract = new ethers_1.ethers.Contract(MINT_CONTRACT_ADDRESS, MintTokens_json_1.default.abi, bWallet);
function startListening() {
    return __awaiter(this, void 0, void 0, function* () {
        yield (0, db_1.connectDB)();
        console.log('✅ 已连接数据库，开始监听 A 链 LockTokens 合约的 Locked 事件...');
        // 初始化队列检查器
        const queueChecker = new queueChecker_1.QueueChecker({
            mintContract,
            lockTokensContract: lockContract,
            bProvider,
            ethProvider: aProvider
        });
        // 启动时检查待处理队列
        yield queueChecker.checkPendingQueue();
        const socket = aProvider.websocket;
        lockContract.on('Locked', (sender, receiver, amount, fee, crosschainHash, event) => __awaiter(this, void 0, void 0, function* () {
            const txHash = event.log.transactionHash;
            console.log('\n🔔 监听到 Locked 事件:', {
                sender,
                receiver,
                amount: ethers_1.ethers.formatEther(amount),
                fee: fee ? ethers_1.ethers.formatEther(fee) : '0',
                crosschainHash,
                txHash
            });
            try {
                const receipt = yield event.getTransactionReceipt();
                if (!receipt || !receipt.blockNumber) {
                    console.error('❌ A 链交易未确认，跳过:', txHash);
                    return;
                }
                // 更新前先查找记录
                const before = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                console.log('更新前查到的记录:', before);
                yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash: txHash }, {
                    $set: {
                        sourceFromTxStatus: 'success',
                    }
                });
                const after = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                console.log('更新后查到的记录:', after);
                const existingRecord = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                if ((existingRecord === null || existingRecord === void 0 ? void 0 : existingRecord.crossBridgeStatus) === 'minted') {
                    console.log('⏭️ 事件已处理，跳过:', txHash);
                    return;
                }
                // B 链 mint 代币
                
                
                const tx = yield mintContract.mint(receiver, amount, crosschainHash);
                console.log('🚀 已发送 B 链 mint 交易，txHash:', tx.hash);
                yield tx.wait();
                console.log('✅ B 链 mint 交易已确认');
                (0, websocket_1.sendToUser)(receiver, {
                    type: 'MINT_SUCCESS',
                    data: { targetToTxHash: tx.hash }
                });
                const maxRetry = 3;
                let retry = 0;
                let updated = false;
                while (retry < maxRetry && !updated) {
                    yield new Promise(res => setTimeout(res, 2000));
                    const record = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                    if (record) {
                        yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash: txHash }, { $set: { sourceFromTxStatus: 'success' } });
                        console.log(`✅ 第${retry + 1}次重试后，成功更新 sourceFromTxStatus 为 success`);
                        updated = true;
                    }
                    else {
                        console.log(`⏳ 第${retry + 1}次重试，仍未查到记录，txHash: ${txHash}`);
                        retry++;
                    }
                }
                if (!updated) {
                    console.warn('⚠️ 多次重试后仍未查到记录，未能更新状态:', txHash);
                }
                if (updated) {
                    const finalRecord = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                    const isSourceSuccess = (finalRecord === null || finalRecord === void 0 ? void 0 : finalRecord.sourceFromTxStatus) === 'success';
                    const isTargetSuccess = (finalRecord === null || finalRecord === void 0 ? void 0 : finalRecord.targetToTxStatus) === 'success' || true;
                    if (isSourceSuccess && isTargetSuccess) {
                        yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash: txHash }, { $set: { crossBridgeStatus: 'minted' } });
                        console.log('🎉 crossBridgeStatus 已更新为 minted');
                    }
                }
                const updateData = {
                    targetToTxHash: tx.hash,
                    targetToTxStatus: 'success',
                    timestamp: new Date()
                };
                const isSourceSuccess = (existingRecord === null || existingRecord === void 0 ? void 0 : existingRecord.sourceFromTxStatus) === 'success';
                const isTargetSuccess = true;
                if (isSourceSuccess && isTargetSuccess) {
                    updateData.crossBridgeStatus = 'minted';
                }
                yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash: txHash }, { $set: updateData });
                console.log('🎉 铸币成功:', {
                    sender,
                    receiver,
                    amount: ethers_1.ethers.formatEther(amount),
                    crosschainHash,
                    sourceFromTxHash: txHash,
                    targetToTxHash: tx.hash
                });
            }
            catch (err) {
                if (err.code === 'INSUFFICIENT_FUNDS') {
                    console.error('❌ B 链钱包余额不足，无法支付 Gas，请充值 ETH 到:', bWallet.address);
                }
                else {
                    console.error('❌ 事件处理失败:', err);
                }
                (0, websocket_1.sendToUser)(receiver, {
                    type: 'MINT_FAILED',
                    data: { error: err.message || err }
                });
            }
        }));
        socket.on('error', (err) => {
            console.error('❌ A链 WebSocket 错误:', err);
        });
        socket.on('close', (code) => __awaiter(this, void 0, void 0, function* () {
            console.warn(`⚠️ A链 WebSocket 连接关闭，code: ${code}，尝试重连...`);
            // 断线重连后重新检查队列
            try {
                yield queueChecker.checkPendingQueue();
                console.log('✅ 断线重连后队列检查完成');
            }
            catch (error) {
                console.error('❌ 断线重连后队列检查失败:', error);
            }
            setTimeout(startListening, 3000);
        }));
        // 定期检查队列（每30分钟检查一次）
        setInterval(() => __awaiter(this, void 0, void 0, function* () {
            try {
                console.log('🔄 定期检查队列...');
                yield queueChecker.checkPendingQueue();
                console.log('✅ 定期队列检查完成');
            }
            catch (error) {
                console.error('❌ 定期队列检查失败:', error);
            }
        }), 30 * 60 * 1000); // 30分钟
    });
}
