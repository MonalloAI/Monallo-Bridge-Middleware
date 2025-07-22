"use strict";
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
exports.QueueChecker = void 0;
const CrossBridgeRecord_model_1 = __importDefault(require("../model/CrossBridgeRecord.model"));
const websocket_1 = require("../WebSocket/websocket");
class QueueChecker {
    constructor(config) {
        this.config = config;
    }
    /**
     * 检查并处理待处理的跨链记录
     * 用于断线重连后重新处理未完成的消息
     */
    checkPendingQueue() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log('🔄 开始检查待处理的跨链记录队列...');
            try {
                // 查找所有状态为 pending 的记录
                const pendingRecords = yield CrossBridgeRecord_model_1.default.find({
                    $or: [
                        { crossBridgeStatus: 'pending' },
                        {
                            sourceFromTxStatus: 'success',
                            targetToTxStatus: { $ne: 'success' }
                        }
                    ]
                });
                console.log(`📊 找到 ${pendingRecords.length} 条待处理记录`);
                for (const record of pendingRecords) {
                    yield this.processPendingRecord(record);
                }
                console.log('✅ 队列检查完成');
            }
            catch (error) {
                console.error('❌ 队列检查失败:', error);
            }
        });
    }
    /**
     * 处理单个待处理记录
     */
    processPendingRecord(record) {
        return __awaiter(this, void 0, void 0, function* () {
            const { sourceFromTxHash, targetToAddress, sourceFromAmount, crosschainHash } = record;
            console.log(`🔍 处理待处理记录: ${sourceFromTxHash}`);
            try {
                // 检查源交易是否已确认
                const sourceTxReceipt = yield this.config.ethProvider.getTransactionReceipt(sourceFromTxHash);
                if (!sourceTxReceipt || sourceTxReceipt.status !== 1) {
                    console.log(`⏳ 源交易未确认，跳过: ${sourceFromTxHash}`);
                    return;
                }
                // 如果目标交易状态不是 success，尝试重新执行
                if (record.targetToTxStatus !== 'success') {
                    yield this.retryTargetTransaction(record);
                }
                // 更新跨链状态
                yield this.updateCrossBridgeStatus(record);
            }
            catch (error) {
                console.error(`❌ 处理记录失败 ${sourceFromTxHash}:`, error);
            }
        });
    }
    /**
     * 重试目标链交易
     */
    retryTargetTransaction(record) {
        return __awaiter(this, void 0, void 0, function* () {
            const { sourceFromTxHash, targetToAddress, sourceFromAmount, crosschainHash, sourceFromTokenName } = record;
            try {
                let tx;
                if (sourceFromTokenName === null || sourceFromTokenName === void 0 ? void 0 : sourceFromTokenName.startsWith('mao')) {
                    // 执行 mint 操作
                    tx = yield this.config.mintContract.mint(targetToAddress, sourceFromAmount, crosschainHash);
                    console.log(`📤 重试 mint 交易: ${tx.hash}`);
                }
                else {
                    // 执行 unlock 操作
                    tx = yield this.config.lockTokensContract.unlock(targetToAddress, sourceFromAmount, crosschainHash);
                    console.log(`🔓 重试 unlock 交易: ${tx.hash}`);
                }
                // 等待交易确认
                yield tx.wait();
                console.log(`✅ 重试交易已确认: ${tx.hash}`);
                // 更新数据库
                yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash }, {
                    $set: {
                        targetToTxHash: tx.hash,
                        targetToTxStatus: 'success'
                    }
                });
                // 发送成功通知
                const messageType = (sourceFromTokenName === null || sourceFromTokenName === void 0 ? void 0 : sourceFromTokenName.startsWith('mao')) ? 'MINT_SUCCESS' : 'UNLOCK_SUCCESS';
                (0, websocket_1.sendToUser)(targetToAddress, {
                    type: messageType,
                    data: { targetToTxHash: tx.hash }
                });
            }
            catch (error) {
                console.error(`❌ 重试交易失败 ${sourceFromTxHash}:`, error);
                // 发送失败通知
                const messageType = (sourceFromTokenName === null || sourceFromTokenName === void 0 ? void 0 : sourceFromTokenName.startsWith('mao')) ? 'MINT_FAILED' : 'UNLOCK_FAILED';
                (0, websocket_1.sendToUser)(targetToAddress, {
                    type: messageType,
                    data: { error: error.message || error }
                });
                // 更新状态为失败
                yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash }, {
                    $set: {
                        targetToTxStatus: 'failed',
                        crossBridgeStatus: 'failed'
                    }
                });
            }
        });
    }
    /**
     * 更新跨链状态
     */
    updateCrossBridgeStatus(record) {
        return __awaiter(this, void 0, void 0, function* () {
            const { sourceFromTxHash } = record;
            const updatedRecord = yield CrossBridgeRecord_model_1.default.findOne({ sourceFromTxHash });
            if (updatedRecord) {
                const isSourceSuccess = updatedRecord.sourceFromTxStatus === 'success';
                const isTargetSuccess = updatedRecord.targetToTxStatus === 'success';
                if (isSourceSuccess && isTargetSuccess) {
                    yield CrossBridgeRecord_model_1.default.updateOne({ sourceFromTxHash }, { $set: { crossBridgeStatus: 'minted' } });
                    console.log(`🎉 更新跨链状态为 minted: ${sourceFromTxHash}`);
                }
            }
        });
    }
    /**
     * 检查特定时间范围内的失败记录
     */
    checkFailedRecords() {
        return __awaiter(this, arguments, void 0, function* (hours = 24) {
            console.log(`🔄 检查过去 ${hours} 小时内的失败记录...`);
            const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
            try {
                const failedRecords = yield CrossBridgeRecord_model_1.default.find({
                    $or: [
                        { crossBridgeStatus: 'failed' },
                        { targetToTxStatus: 'failed' }
                    ],
                    updatedAt: { $gte: cutoffTime }
                });
                console.log(`📊 找到 ${failedRecords.length} 条失败记录`);
                for (const record of failedRecords) {
                    yield this.processPendingRecord(record);
                }
            }
            catch (error) {
                console.error('❌ 检查失败记录时出错:', error);
            }
        });
    }
}
exports.QueueChecker = QueueChecker;
