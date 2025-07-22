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
exports.startBurnListening = startBurnListening;
const ethers_1 = require("ethers");
const dotenv = __importStar(require("dotenv"));
const BurnManager_json_1 = __importDefault(require("./abi/BurnManager.json"));
const MintTokens_json_1 = __importDefault(require("./abi/MintTokens.json"));
const LockTokens_json_1 = __importDefault(require("./abi/LockTokens.json"));
const db_1 = require("./db");
const CrossBridgeRecord_model_1 = __importDefault(require("./model/CrossBridgeRecord.model"));
const websocket_1 = require("./WebSocket/websocket");
const queueChecker_1 = require("./utils/queueChecker");
dotenv.config();
const { BURN_CONTRACT_ADDRESS, LOCK_CONTRACT_ADDRESS, MINT_CONTRACT_ADDRESS, PRIVATE_KEY, IMUA_RPC_URL, ETH_RPC_URL, ETH_API_KEY } = process.env;
if (!LOCK_CONTRACT_ADDRESS || !MINT_CONTRACT_ADDRESS || !BURN_CONTRACT_ADDRESS || !PRIVATE_KEY || !IMUA_RPC_URL || !ETH_RPC_URL) {
    throw new Error('❌ 请检查 .env 文件，确保所有必要的环境变量已配置');
}
function createWssProvider(url) {
    if (!url.startsWith('wss')) {
        throw new Error(`❌ 非 wss 链接，请检查 provider URL: ${url}`);
    }
    return new ethers_1.WebSocketProvider(url);
}
const aProvider = createWssProvider(IMUA_RPC_URL);
const bProvider = createWssProvider(IMUA_RPC_URL);
const ethProvider = createWssProvider(`${ETH_RPC_URL}${ETH_API_KEY}`);
const bWallet = new ethers_1.ethers.Wallet(PRIVATE_KEY, bProvider);
const ethWallet = new ethers_1.ethers.Wallet(PRIVATE_KEY, ethProvider);
const fs = require('fs');
const path = require('path');
const deployedAddresses = JSON.parse(fs.readFileSync(path.join(__dirname, './abi/deployed_addresses.json'), 'utf8'));
const burnManagerContract = new ethers_1.ethers.Contract(BURN_CONTRACT_ADDRESS, BurnManager_json_1.default.abi, aProvider);
const mintContract = new ethers_1.ethers.Contract(MINT_CONTRACT_ADDRESS, MintTokens_json_1.default.abi, bWallet);
const lockTokensContract = new ethers_1.ethers.Contract(LOCK_CONTRACT_ADDRESS, LockTokens_json_1.default.abi, ethWallet);
function startBurnListening() {
    return __awaiter(this, void 0, void 0, function* () {
        yield (0, db_1.connectDB)();
        console.log('✅ 已连接数据库，准备监听 BurnManager 的 Burned 事件...');
        // 初始化队列检查器
        const queueChecker = new queueChecker_1.QueueChecker({
            mintContract,
            lockTokensContract: lockTokensContract,
            bProvider: aProvider,
            ethProvider: ethProvider
        });
        // 启动时检查待处理队列
        yield queueChecker.checkPendingQueue();
        let lastBlock = yield aProvider.getBlockNumber();
        function pollBurnedEvents() {
            return __awaiter(this, void 0, void 0, function* () {
                var _a, _b;
                try {
                    const currentBlock = yield aProvider.getBlockNumber();
                    if (currentBlock <= lastBlock) {
                        return setTimeout(pollBurnedEvents, 10000);
                    }
                    const events = yield burnManagerContract.queryFilter(burnManagerContract.filters.Burned(), lastBlock + 1, currentBlock);
                    for (const event of events) {
                        const args = event.args || [];
                        const [burner, amount, sepoliaRecipient, crosschainHash] = args;
                        const txHash = event.transactionHash;
                        // 事件一开始，先更新 sourceFromTxStatus
                        const before = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                        console.log('更新前查到的记录:', before);
                        yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash: txHash }, { $set: { sourceFromTxStatus: 'success' } });
                        const after = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                        console.log('更新后查到的记录:', after);
                        console.log('🔥 检测到 Burned 事件:', {
                            burner,
                            amount: amount === null || amount === void 0 ? void 0 : amount.toString(),
                            sepoliaRecipient,
                            crosschainHash,
                            txHash
                        });
                        let tokenName = '';
                        let destinationChainId = null;
                        let recipientAddress = null;
                        // 先从数据库查 tokenName 和 chainId/recipient
                        const record = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                        if (record === null || record === void 0 ? void 0 : record.sourceFromTokenName) {
                            tokenName = record.sourceFromTokenName;
                            console.log('🧩 数据库获取 tokenName:', tokenName, 'destinationChainId:', destinationChainId, 'recipientAddress:', recipientAddress);
                        }
                        else {
                            try {
                                const tokenAddress = yield burnManagerContract.token();
                                const tokenContract = new ethers_1.ethers.Contract(tokenAddress, MintTokens_json_1.default.abi, aProvider);
                                tokenName = yield tokenContract.name();
                                console.log('🔗 链上获取 tokenName:', tokenName);
                            }
                            catch (err) {
                                console.error('⚠️ 无法从链上获取 token name:', err);
                            }
                        }
                        if (!tokenName) {
                            console.error('❌ 跳过该事件：无法识别 tokenName，txHash:', txHash);
                            continue;
                        }
                        // 动态选择目标合约地址
                        let targetContractAddress = null;
                        if (destinationChainId) {
                            targetContractAddress = deployedAddresses.imua.targets[`target_${destinationChainId}`];
                        }
                        if (!targetContractAddress) {
                            // 默认 fallback
                            targetContractAddress = deployedAddresses.imua.targets.target_11155111;
                        }
                        const mintContractDynamic = new ethers_1.ethers.Contract(targetContractAddress, MintTokens_json_1.default.abi, bWallet);
                        const lockTokensContractDynamic = new ethers_1.ethers.Contract(targetContractAddress, LockTokens_json_1.default.abi, bWallet);
                        if (tokenName.startsWith('mao')) {
                            // mint
                            try {
                                const tx = yield mintContractDynamic.mint(recipientAddress || sepoliaRecipient, amount, crosschainHash);
                                console.log('📤 发送 mint 交易，txHash:', tx.hash);
                                yield tx.wait();
                                console.log('✅ mint 交易已确认');
                                (0, websocket_1.sendToUser)(sepoliaRecipient, {
                                    type: 'MINT_SUCCESS',
                                    data: { targetToTxHash: tx.hash }
                                });
                                // mint 成功后，轮询查找并更新 targetToTxStatus，最多重试3次
                                {
                                    const maxRetry = 3;
                                    let retry = 0;
                                    let updated = false;
                                    while (retry < maxRetry && !updated) {
                                        yield new Promise(res => setTimeout(res, 2000));
                                        const record = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                                        if (record) {
                                            yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash: txHash }, { $set: { targetToTxStatus: 'success' } });
                                            console.log(`✅ 第${retry + 1}次重试后，成功更新 targetToTxStatus 为 success`);
                                            updated = true;
                                        }
                                        else {
                                            console.log(`⏳ 第${retry + 1}次重试，仍未查到记录，txHash: ${txHash}`);
                                            retry++;
                                        }
                                    }
                                    if (!updated) {
                                        console.warn('⚠️ 多次重试后仍未查到记录，未能更新 targetToTxStatus:', txHash);
                                    }
                                    // 轮询 targetToTxStatus 成功后，再更新 crossBridgeStatus
                                    if (updated) {
                                        const finalRecord = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                                        const isSourceSuccess = (finalRecord === null || finalRecord === void 0 ? void 0 : finalRecord.sourceFromTxStatus) === 'success' || true;
                                        const isTargetSuccess = (finalRecord === null || finalRecord === void 0 ? void 0 : finalRecord.targetToTxStatus) === 'success';
                                        if (isSourceSuccess && isTargetSuccess) {
                                            yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash: txHash }, { $set: { crossBridgeStatus: 'minted' } });
                                            console.log('🎉 crossBridgeStatus 已更新为 minted');
                                        }
                                    }
                                }
                            }
                            catch (err) {
                                console.error('❌ mint 铸币失败:', err.message || err);
                                (0, websocket_1.sendToUser)(sepoliaRecipient, {
                                    type: 'MINT_FAILED',
                                    data: { error: err.message || err }
                                });
                            }
                        }
                        else {
                            // unlock
                            try {
                                const tx = yield lockTokensContractDynamic.unlock(recipientAddress || sepoliaRecipient, amount, crosschainHash);
                                console.log('🔓 发送 unlock 交易，txHash:', tx.hash);
                                yield tx.wait();
                                console.log('✅ unlock 交易已确认');
                                (0, websocket_1.sendToUser)(sepoliaRecipient, {
                                    type: 'UNLOCK_SUCCESS',
                                    data: { targetToTxHash: tx.hash }
                                });
                                // unlock 成功后，写入 targetToTxHash
                                yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash: txHash }, { $set: { targetToTxHash: tx.hash } });
                                console.log('✅ 已写入 targetToTxHash:', tx.hash);
                                // unlock 成功后，轮询查找并更新 targetToTxStatus，最多重试3次
                                {
                                    const maxRetry = 3;
                                    let retry = 0;
                                    let updated = false;
                                    while (retry < maxRetry && !updated) {
                                        yield new Promise(res => setTimeout(res, 2000));
                                        const record = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                                        if (record) {
                                            yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash: txHash }, { $set: { targetToTxStatus: 'success' } });
                                            console.log(`✅ 第${retry + 1}次重试后，成功更新 targetToTxStatus 为 success`);
                                            updated = true;
                                        }
                                        else {
                                            console.log(`⏳ 第${retry + 1}次重试，仍未查到记录，txHash: ${txHash}`);
                                            retry++;
                                        }
                                    }
                                    if (!updated) {
                                        console.warn('⚠️ 多次重试后仍未查到记录，未能更新 targetToTxStatus:', txHash);
                                    }
                                    // 轮询 targetToTxStatus 成功后，再更新 crossBridgeStatus
                                    if (updated) {
                                        const finalRecord = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash: txHash });
                                        const isSourceSuccess = (finalRecord === null || finalRecord === void 0 ? void 0 : finalRecord.sourceFromTxStatus) === 'success' || true;
                                        const isTargetSuccess = (finalRecord === null || finalRecord === void 0 ? void 0 : finalRecord.targetToTxStatus) === 'success';
                                        if (isSourceSuccess && isTargetSuccess) {
                                            yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash: txHash }, { $set: { crossBridgeStatus: 'minted' } });
                                            console.log('🎉 crossBridgeStatus 已更新为 minted');
                                        }
                                    }
                                }
                            }
                            catch (err) {
                                console.error('❌ 解锁失败:', err.message || err);
                                (0, websocket_1.sendToUser)(sepoliaRecipient, {
                                    type: 'UNLOCK_FAILED',
                                    data: { error: err.message || err }
                                });
                            }
                        }
                    }
                    lastBlock = currentBlock;
                }
                catch (err) {
                    console.error('⚠️ 轮询错误:', err.message || err);
                    // 如果是连接错误，尝试重新检查队列
                    if (((_a = err.message) === null || _a === void 0 ? void 0 : _a.includes('connection')) || ((_b = err.message) === null || _b === void 0 ? void 0 : _b.includes('network'))) {
                        console.log('🔄 检测到连接错误，重新检查队列...');
                        try {
                            yield queueChecker.checkPendingQueue();
                            console.log('✅ 连接错误后队列检查完成');
                        }
                        catch (queueError) {
                            console.error('❌ 连接错误后队列检查失败:', queueError);
                        }
                    }
                    try {
                        lastBlock = yield aProvider.getBlockNumber();
                    }
                    catch (innerErr) {
                        console.error('❌ 获取当前区块失败:', innerErr);
                    }
                }
                setTimeout(pollBurnedEvents, 10000);
            });
        }
        pollBurnedEvents();
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
if (require.main === module) {
    startBurnListening();
}
