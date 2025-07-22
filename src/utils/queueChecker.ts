import CrossBridgeRecord from '../model/CrossBridgeRecord.model';
import { ethers } from 'ethers';
import MintTokensAbi from '../abi/MintTokens.json';
import LockTokensAbi from '../abi/LockTokens.json';
import { sendToUser } from '../WebSocket/websocket';

interface QueueCheckerConfig {
    mintContract: ethers.Contract;
    lockTokensContract: ethers.Contract;
    bProvider: ethers.Provider;
    ethProvider: ethers.Provider;
}

export class QueueChecker {
    private config: QueueCheckerConfig;

    constructor(config: QueueCheckerConfig) {
        this.config = config;
    }

    /**
     * 检查并处理待处理的跨链记录
     * 用于断线重连后重新处理未完成的消息
     */
    async checkPendingQueue() {
        console.log('🔄 开始检查待处理的跨链记录队列...');
        
        try {
            // 查找所有状态为 pending 的记录
            const pendingRecords = await CrossBridgeRecord.find({
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
                await this.processPendingRecord(record);
            }

            console.log('✅ 队列检查完成');
        } catch (error) {
            console.error('❌ 队列检查失败:', error);
        }
    }

    /**
     * 处理单个待处理记录
     */
    private async processPendingRecord(record: any) {
        const { sourceFromTxHash, targetToAddress, sourceFromAmount, crosschainHash } = record;
        
        console.log(`🔍 处理待处理记录: ${sourceFromTxHash}`);

        try {
            // 检查源交易是否已确认
            const sourceTxReceipt = await this.config.ethProvider.getTransactionReceipt(sourceFromTxHash);
            
            if (!sourceTxReceipt || sourceTxReceipt.status !== 1) {
                console.log(`⏳ 源交易未确认，跳过: ${sourceFromTxHash}`);
                return;
            }

            // 如果目标交易状态不是 success，尝试重新执行
            if (record.targetToTxStatus !== 'success') {
                await this.retryTargetTransaction(record);
            }

            // 更新跨链状态
            await this.updateCrossBridgeStatus(record);

        } catch (error) {
            console.error(`❌ 处理记录失败 ${sourceFromTxHash}:`, error);
        }
    }

    /**
     * 重试目标链交易
     */
    private async retryTargetTransaction(record: any) {
        const { sourceFromTxHash, targetToAddress, sourceFromAmount, crosschainHash, sourceFromTokenName } = record;

        try {
            let tx;
            
            if (sourceFromTokenName?.startsWith('mao')) {
                // 执行 mint 操作
                tx = await this.config.mintContract.mint(
                    targetToAddress, 
                    sourceFromAmount, 
                    crosschainHash
                );
                console.log(`📤 重试 mint 交易: ${tx.hash}`);
            } else {
                // 执行 unlock 操作
                tx = await this.config.lockTokensContract.unlock(
                    targetToAddress, 
                    sourceFromAmount, 
                    crosschainHash
                );
                console.log(`🔓 重试 unlock 交易: ${tx.hash}`);
            }

            // 等待交易确认
            await tx.wait();
            console.log(`✅ 重试交易已确认: ${tx.hash}`);

            // 更新数据库
            await CrossBridgeRecord.updateOne(
                { sourceFromTxHash },
                { 
                    $set: { 
                        targetToTxHash: tx.hash,
                        targetToTxStatus: 'success'
                    } 
                }
            );

            // 发送成功通知
            const messageType = sourceFromTokenName?.startsWith('mao') ? 'MINT_SUCCESS' : 'UNLOCK_SUCCESS';
            sendToUser(targetToAddress, {
                type: messageType,
                data: { targetToTxHash: tx.hash }
            });

        } catch (error: any) {
            console.error(`❌ 重试交易失败 ${sourceFromTxHash}:`, error);
            
            // 发送失败通知
            const messageType = sourceFromTokenName?.startsWith('mao') ? 'MINT_FAILED' : 'UNLOCK_FAILED';
            sendToUser(targetToAddress, {
                type: messageType,
                data: { error: error.message || error }
            });

            // 更新状态为失败
            await CrossBridgeRecord.updateOne(
                { sourceFromTxHash },
                { 
                    $set: { 
                        targetToTxStatus: 'failed',
                        crossBridgeStatus: 'failed'
                    } 
                }
            );
        }
    }

    /**
     * 更新跨链状态
     */
    private async updateCrossBridgeStatus(record: any) {
        const { sourceFromTxHash } = record;
        
        const updatedRecord = await CrossBridgeRecord.findOne({ sourceFromTxHash });
        
        if (updatedRecord) {
            const isSourceSuccess = updatedRecord.sourceFromTxStatus === 'success';
            const isTargetSuccess = updatedRecord.targetToTxStatus === 'success';
            
            if (isSourceSuccess && isTargetSuccess) {
                await CrossBridgeRecord.updateOne(
                    { sourceFromTxHash },
                    { $set: { crossBridgeStatus: 'minted' } }
                );
                console.log(`🎉 更新跨链状态为 minted: ${sourceFromTxHash}`);
            }
        }
    }

    /**
     * 检查特定时间范围内的失败记录
     */
    async checkFailedRecords(hours: number = 24) {
        console.log(`🔄 检查过去 ${hours} 小时内的失败记录...`);
        
        const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
        
        try {
            const failedRecords = await CrossBridgeRecord.find({
                $or: [
                    { crossBridgeStatus: 'failed' },
                    { targetToTxStatus: 'failed' }
                ],
                updatedAt: { $gte: cutoffTime }
            });

            console.log(`📊 找到 ${failedRecords.length} 条失败记录`);

            for (const record of failedRecords) {
                await this.processPendingRecord(record);
            }

        } catch (error) {
            console.error('❌ 检查失败记录时出错:', error);
        }
    }
} 