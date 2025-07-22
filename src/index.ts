import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import LockTokensAbi from './abi/LockTokens.json';
import MintTokensAbi from './abi/MintTokens.json';
import { connectDB } from './db';
import CrossBridgeRecord from './model/CrossBridgeRecord.model';
import { sendToUser } from './WebSocket/websocket';
import ws from 'ws';
import { QueueChecker } from './utils/queueChecker';


dotenv.config();

const {
    LOCK_CONTRACT_ADDRESS,
    MINT_CONTRACT_ADDRESS,
    PRIVATE_KEY,
    IMUA_RPC_URL,
    ETH_RPC_URL,
     ETH_API_KEY
} = process.env;

if (!LOCK_CONTRACT_ADDRESS || !MINT_CONTRACT_ADDRESS || !PRIVATE_KEY || !IMUA_RPC_URL || !ETH_RPC_URL) {
    throw new Error('请检查 .env 文件，相关环境变量未配置完整');
}

// ✅ A 链 WebSocket Provider & Lock 合约
const aProvider = new ethers.WebSocketProvider(`${ETH_RPC_URL}${ETH_API_KEY}`);
const lockContract = new ethers.Contract(
    LOCK_CONTRACT_ADDRESS,
    LockTokensAbi.abi,
    aProvider
);

// ✅ B 链 WebSocket Provider & Mint 合约
const bProvider = new ethers.WebSocketProvider(IMUA_RPC_URL!);
const bWallet = new ethers.Wallet(PRIVATE_KEY!, bProvider);
const mintContract = new ethers.Contract(
    MINT_CONTRACT_ADDRESS,
    MintTokensAbi.abi,
    bWallet
);

export async function startListening() {
    await connectDB();
    console.log('✅ 已连接数据库，开始监听 A 链 LockTokens 合约的 Locked 事件...');
    
    // 初始化队列检查器
    const queueChecker = new QueueChecker({
        mintContract,
        lockTokensContract: lockContract,
        bProvider,
        ethProvider: aProvider
    });
    
    // 启动时检查待处理队列
    await queueChecker.checkPendingQueue();
    
    const socket = aProvider.websocket as ws.WebSocket;

    lockContract.on('AssetLocked', async (sender, receiver, amount, fee, crosschainHash, event) => {
        const txHash = event.log.transactionHash;
        console.log('\n🔔 监听到 Locked 事件:', {
            sender,
            receiver,
            amount: ethers.formatEther(amount),
            fee: fee ? ethers.formatEther(fee) : '0',
            crosschainHash,
            txHash
        });

        try {
            const receipt = await event.getTransactionReceipt();
            if (!receipt || !receipt.blockNumber) {
                console.error('❌ A 链交易未确认，跳过:', txHash);
                return;
            }

            // 更新前先查找记录
            const before = await CrossBridgeRecord.findOne({ sourceFromTxHash: txHash });
            console.log('更新前查到的记录:', before);

            await CrossBridgeRecord.updateOne(
                { sourceFromTxHash: txHash },
                {
                    $set: {
                        sourceFromTxStatus: 'success',
                    }
                }
            );
    

            const after = await CrossBridgeRecord.findOne({ sourceFromTxHash: txHash });
            console.log('更新后查到的记录:', after);

            const existingRecord = await CrossBridgeRecord.findOne({ sourceFromTxHash: txHash });

            if (existingRecord?.crossBridgeStatus === 'minted') {
                console.log('⏭️ 事件已处理，跳过:', txHash);
                return;
            }

            // B 链 mint 代币
            const tx = await mintContract.mint(receiver, amount, crosschainHash);
            console.log('🚀 已发送 B 链 mint 交易，txHash:', tx.hash);
            await tx.wait();
            console.log('✅ B 链 mint 交易已确认');

            sendToUser(receiver, {
                type: 'MINT_SUCCESS',
                data: { targetToTxHash: tx.hash }
            });

           
            const maxRetry = 3;
            let retry = 0;
            let updated = false;
            while (retry < maxRetry && !updated) {
                await new Promise(res => setTimeout(res, 2000));
                const record = await CrossBridgeRecord.findOne({ sourceFromTxHash: txHash });
                if (record) {
                    await CrossBridgeRecord.updateOne(
                        { sourceFromTxHash: txHash },
                        { $set: { sourceFromTxStatus: 'success' } }
                    );
                    console.log(`✅ 第${retry + 1}次重试后，成功更新 sourceFromTxStatus 为 success`);
                    updated = true;
                } else {
                    console.log(`⏳ 第${retry + 1}次重试，仍未查到记录，txHash: ${txHash}`);
                    retry++;
                }
            }
            if (!updated) {
                console.warn('⚠️ 多次重试后仍未查到记录，未能更新状态:', txHash);
            }

  
            if (updated) {

                const finalRecord = await CrossBridgeRecord.findOne({ sourceFromTxHash: txHash });
                const isSourceSuccess = finalRecord?.sourceFromTxStatus === 'success';
                const isTargetSuccess = finalRecord?.targetToTxStatus === 'success' || true; 

                if (isSourceSuccess && isTargetSuccess) {
                    await CrossBridgeRecord.updateOne(
                        { sourceFromTxHash: txHash },
                        { $set: { crossBridgeStatus: 'minted' } }
                    );
                    console.log('🎉 crossBridgeStatus 已更新为 minted');
                }
            }

            const updateData: any = {
                targetToTxHash: tx.hash,
                targetToTxStatus: 'success',
                timestamp: new Date()
            };

            const isSourceSuccess = existingRecord?.sourceFromTxStatus === 'success';
            const isTargetSuccess = true;
            if (isSourceSuccess && isTargetSuccess) {
                updateData.crossBridgeStatus = 'minted';
            }

            await CrossBridgeRecord.updateOne(
                { sourceFromTxHash: txHash },
                { $set: updateData },
         
            );

            console.log('🎉 铸币成功:', {
                sender,
                receiver,
                amount: ethers.formatEther(amount),
                crosschainHash,
                sourceFromTxHash: txHash,
                targetToTxHash: tx.hash
            });
        } catch (err: any) {
            if (err.code === 'INSUFFICIENT_FUNDS') {
                console.error('❌ B 链钱包余额不足，无法支付 Gas，请充值 ETH 到:', bWallet.address);
            } else {
                console.error('❌ 事件处理失败:', err);
            }

            sendToUser(receiver, {
                type: 'MINT_FAILED',
                data: { error: err.message || err }
            });
        }
    });


    socket.on('error', (err: any) => {
        console.error('❌ A链 WebSocket 错误:', err);
    });

    socket.on('close', async (code: number) => {
        console.warn(`⚠️ A链 WebSocket 连接关闭，code: ${code}，尝试重连...`);
        
        // 断线重连后重新检查队列
        try {
            await queueChecker.checkPendingQueue();
            console.log('✅ 断线重连后队列检查完成');
        } catch (error) {
            console.error('❌ 断线重连后队列检查失败:', error);
        }
        
        setTimeout(startListening, 3000);
    });
    
    // 定期检查队列（每30分钟检查一次）
    setInterval(async () => {
        try {
            console.log('🔄 定期检查队列...');
            await queueChecker.checkPendingQueue();
            console.log('✅ 定期队列检查完成');
        } catch (error) {
            console.error('❌ 定期队列检查失败:', error);
        }
    }, 30 * 60 * 1000); // 30分钟
}
