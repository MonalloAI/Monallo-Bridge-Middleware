import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { connectDB } from '../db';
import { QueueChecker } from './queueChecker';
import LockTokensAbi from '../abi/LockTokens.json';
import MintTokensAbi from '../abi/MintTokens.json';

dotenv.config();

const {
    LOCK_CONTRACT_ADDRESS,
    MINT_CONTRACT_ADDRESS,
    PRIVATE_KEY,
    IMUA_RPC_URL,
    ETH_RPC_URL,
    ETH_API_KEY
} = process.env;

/**
 * 手动检查队列的工具函数
 * 可以在需要时手动执行，用于处理可能遗漏的消息
 */
export async function manualQueueCheck() {
    console.log('🚀 开始手动队列检查...');
    
    try {
        await connectDB();
        console.log('✅ 数据库连接成功');
        
        // 创建 providers
        const aProvider = new ethers.WebSocketProvider(`${ETH_RPC_URL}${ETH_API_KEY}`);
        const bProvider = new ethers.WebSocketProvider(IMUA_RPC_URL!);
        const bWallet = new ethers.Wallet(PRIVATE_KEY!, bProvider);
        
        // 创建合约实例
        const lockContract = new ethers.Contract(
            LOCK_CONTRACT_ADDRESS!,
            LockTokensAbi.abi,
            aProvider
        );
        
        const mintContract = new ethers.Contract(
            MINT_CONTRACT_ADDRESS!,
            MintTokensAbi.abi,
            bWallet
        );
        
        // 初始化队列检查器
        const queueChecker = new QueueChecker({
            mintContract,
            lockTokensContract: lockContract,
            bProvider,
            ethProvider: aProvider
        });
        
        // 检查待处理队列
        await queueChecker.checkPendingQueue();
        
        // 检查过去24小时的失败记录
        await queueChecker.checkFailedRecords(24);
        
        console.log('✅ 手动队列检查完成');
        
    } catch (error) {
        console.error('❌ 手动队列检查失败:', error);
    }
}

// 如果直接运行此文件，执行手动检查
if (require.main === module) {
    manualQueueCheck()
        .then(() => {
            console.log('🎉 手动队列检查执行完毕');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 手动队列检查执行失败:', error);
            process.exit(1);
        });
} 