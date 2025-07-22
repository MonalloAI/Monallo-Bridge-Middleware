import { ethers, WebSocketProvider } from 'ethers';
import * as dotenv from 'dotenv';
import BurnManagerAbi from './abi/BurnManager.json';
import MintTokensAbi from './abi/MintTokens.json';
import LockTokensAbi from './abi/LockTokens.json';
import { connectDB } from './db';
import LockModel from './model/CrossBridgeRecord.model';
import { sendToUser } from './WebSocket/websocket';
import { QueueChecker } from './utils/queueChecker';

dotenv.config();

const {
    BURN_CONTRACT_ADDRESS,
    LOCK_CONTRACT_ADDRESS,
    MINT_CONTRACT_ADDRESS,
    PRIVATE_KEY,
    IMUA_RPC_URL,
    ETH_RPC_URL,
    ETH_API_KEY
} = process.env;


if (!LOCK_CONTRACT_ADDRESS || !MINT_CONTRACT_ADDRESS || !BURN_CONTRACT_ADDRESS || !PRIVATE_KEY || !IMUA_RPC_URL || !ETH_RPC_URL) {
    throw new Error('❌ 请检查 .env 文件，确保所有必要的环境变量已配置');
}


function createWssProvider(url: string): ethers.Provider {
    if (!url.startsWith('wss')) {
        throw new Error(`❌ 非 wss 链接，请检查 provider URL: ${url}`);
    }
    return new WebSocketProvider(url);
}

const aProvider = createWssProvider(IMUA_RPC_URL); 
const bProvider = createWssProvider(IMUA_RPC_URL); 
const ethProvider = createWssProvider(`${ETH_RPC_URL}${ETH_API_KEY}`); 

const bWallet = new ethers.Wallet(PRIVATE_KEY, bProvider);
const ethWallet = new ethers.Wallet(PRIVATE_KEY, ethProvider);


const fs = require('fs');
const path = require('path');
const deployedAddresses = JSON.parse(fs.readFileSync(path.join(__dirname, './abi/deployed_addresses.json'), 'utf8'));
const burnManagerContract = new ethers.Contract(BURN_CONTRACT_ADDRESS, BurnManagerAbi.abi, aProvider);
const mintContract = new ethers.Contract(MINT_CONTRACT_ADDRESS, MintTokensAbi.abi, bWallet);
const lockTokensContract = new ethers.Contract(LOCK_CONTRACT_ADDRESS, LockTokensAbi.abi, ethWallet);


export async function startBurnListening() {
    await connectDB();
    console.log('✅ 已连接数据库，准备监听 BurnManager 的 Burned 事件...');

    // 初始化队列检查器
    const queueChecker = new QueueChecker({
        mintContract,
        lockTokensContract: lockTokensContract,
        bProvider: aProvider,
        ethProvider: ethProvider
    });
    
    // 启动时检查待处理队列
    await queueChecker.checkPendingQueue();
    
    let lastBlock = await aProvider.getBlockNumber();

    async function pollBurnedEvents() {
        try {
            const currentBlock = await aProvider.getBlockNumber();
            if (currentBlock <= lastBlock) {
                return setTimeout(pollBurnedEvents, 10000);
            }

            const events = await burnManagerContract.queryFilter(
                burnManagerContract.filters.Burned(),
                lastBlock + 1,
                currentBlock
            );

            for (const event of events) {
                const args = (event as any).args || [];
                const [burner, amount, sepoliaRecipient, crosschainHash] = args;
                const txHash = event.transactionHash;

                // 事件一开始，先更新 sourceFromTxStatus
                const before = await LockModel.findOne({ sourceFromTxHash: txHash });
                console.log('更新前查到的记录:', before);

                await LockModel.updateOne(
                    { sourceFromTxHash: txHash },
                    { $set: { sourceFromTxStatus: 'success' } }
                );

                const after = await LockModel.findOne({ sourceFromTxHash: txHash });
                console.log('更新后查到的记录:', after);

                console.log('🔥 检测到 Burned 事件:', {
                    burner,
                    amount: amount?.toString(),
                    sepoliaRecipient,
                    crosschainHash,
                    txHash
                });

                let tokenName = '';
                let destinationChainId = null;
                let recipientAddress = null;

                // 先从数据库查 tokenName 和 chainId/recipient
                const record = await LockModel.findOne({ sourceFromTxHash: txHash });
                if (record?.sourceFromTokenName) {
                    tokenName = record.sourceFromTokenName;
                    console.log('🧩 数据库获取 tokenName:', tokenName, 'destinationChainId:', destinationChainId, 'recipientAddress:', recipientAddress);
                } else {
                    try {
                        const tokenAddress = await burnManagerContract.token();
                        const tokenContract = new ethers.Contract(tokenAddress, MintTokensAbi.abi, aProvider);
                        tokenName = await tokenContract.name();
                        console.log('🔗 链上获取 tokenName:', tokenName);
                    } catch (err) {
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
                const mintContractDynamic = new ethers.Contract(targetContractAddress, MintTokensAbi.abi, bWallet);
                const lockTokensContractDynamic = new ethers.Contract(targetContractAddress, LockTokensAbi.abi, bWallet);

                if (tokenName.startsWith('mao')) {
                    // mint
                    try {
                        const tx = await mintContractDynamic.mint(recipientAddress || sepoliaRecipient, amount, crosschainHash);
                        console.log('📤 发送 mint 交易，txHash:', tx.hash);
                        await tx.wait();
                        console.log('✅ mint 交易已确认');

                        sendToUser(sepoliaRecipient, {
                            type: 'MINT_SUCCESS',
                            data: { targetToTxHash: tx.hash }
                        });

                        // mint 成功后，轮询查找并更新 targetToTxStatus，最多重试3次
                        {
                            const maxRetry = 3;
                            let retry = 0;
                            let updated = false;
                            while (retry < maxRetry && !updated) {
                                await new Promise(res => setTimeout(res, 2000));
                                const record = await LockModel.findOne({ sourceFromTxHash: txHash });
                                if (record) {
                                    await LockModel.updateOne(
                                        { sourceFromTxHash: txHash },
                                        { $set: { targetToTxStatus: 'success' } }
                                    );
                                    console.log(`✅ 第${retry + 1}次重试后，成功更新 targetToTxStatus 为 success`);
                                    updated = true;
                                } else {
                                    console.log(`⏳ 第${retry + 1}次重试，仍未查到记录，txHash: ${txHash}`);
                                    retry++;
                                }
                            }
                            if (!updated) {
                                console.warn('⚠️ 多次重试后仍未查到记录，未能更新 targetToTxStatus:', txHash);
                            }

                            // 轮询 targetToTxStatus 成功后，再更新 crossBridgeStatus
                            if (updated) {
                                const finalRecord = await LockModel.findOne({ sourceFromTxHash: txHash });
                                const isSourceSuccess = finalRecord?.sourceFromTxStatus === 'success' || true;
                                const isTargetSuccess = finalRecord?.targetToTxStatus === 'success';
                                if (isSourceSuccess && isTargetSuccess) {
                                    await LockModel.updateOne(
                                        { sourceFromTxHash: txHash },
                                        { $set: { crossBridgeStatus: 'minted' } }
                                    );
                                    console.log('🎉 crossBridgeStatus 已更新为 minted');
                                }
                            }
                        }
                    } catch (err: any) {
                        console.error('❌ mint 铸币失败:', err.message || err);
                        sendToUser(sepoliaRecipient, {
                            type: 'MINT_FAILED',
                            data: { error: err.message || err }
                        });
                    }
                } else {
                    // unlock
                    try {
                        const tx = await lockTokensContractDynamic.unlock(recipientAddress || sepoliaRecipient, amount, crosschainHash);
                        console.log('🔓 发送 unlock 交易，txHash:', tx.hash);
                        await tx.wait();
                        console.log('✅ unlock 交易已确认');

                        sendToUser(sepoliaRecipient, {
                            type: 'UNLOCK_SUCCESS',
                            data: { targetToTxHash: tx.hash }
                        });

                        // unlock 成功后，写入 targetToTxHash
                        await LockModel.updateOne(
                            { sourceFromTxHash: txHash },
                            { $set: { targetToTxHash: tx.hash } }
                        );
                        console.log('✅ 已写入 targetToTxHash:', tx.hash);

                        // unlock 成功后，轮询查找并更新 targetToTxStatus，最多重试3次
                        {
                            const maxRetry = 3;
                            let retry = 0;
                            let updated = false;
                            while (retry < maxRetry && !updated) {
                                await new Promise(res => setTimeout(res, 2000));
                                const record = await LockModel.findOne({ sourceFromTxHash: txHash });
                                if (record) {
                                    await LockModel.updateOne(
                                        { sourceFromTxHash: txHash },
                                        { $set: { targetToTxStatus: 'success' } }
                                    );
                                    console.log(`✅ 第${retry + 1}次重试后，成功更新 targetToTxStatus 为 success`);
                                    updated = true;
                                } else {
                                    console.log(`⏳ 第${retry + 1}次重试，仍未查到记录，txHash: ${txHash}`);
                                    retry++;
                                }
                            }
                            if (!updated) {
                                console.warn('⚠️ 多次重试后仍未查到记录，未能更新 targetToTxStatus:', txHash);
                            }

                            // 轮询 targetToTxStatus 成功后，再更新 crossBridgeStatus
                            if (updated) {
                                const finalRecord = await LockModel.findOne({ sourceFromTxHash: txHash });
                                const isSourceSuccess = finalRecord?.sourceFromTxStatus === 'success' || true;
                                const isTargetSuccess = finalRecord?.targetToTxStatus === 'success';
                                if (isSourceSuccess && isTargetSuccess) {
                                    await LockModel.updateOne(
                                        { sourceFromTxHash: txHash },
                                        { $set: { crossBridgeStatus: 'minted' } }
                                    );
                                    console.log('🎉 crossBridgeStatus 已更新为 minted');
                                }
                            }
                        }
                    } catch (err: any) {
                        console.error('❌ 解锁失败:', err.message || err);
                        sendToUser(sepoliaRecipient, {
                            type: 'UNLOCK_FAILED',
                            data: { error: err.message || err }
                        });
                    }
                }
            }

            lastBlock = currentBlock;
        } catch (err: any) {
            console.error('⚠️ 轮询错误:', err.message || err);
            
            // 如果是连接错误，尝试重新检查队列
            if (err.message?.includes('connection') || err.message?.includes('network')) {
                console.log('🔄 检测到连接错误，重新检查队列...');
                try {
                    await queueChecker.checkPendingQueue();
                    console.log('✅ 连接错误后队列检查完成');
                } catch (queueError) {
                    console.error('❌ 连接错误后队列检查失败:', queueError);
                }
            }
            
            try {
                lastBlock = await aProvider.getBlockNumber();
            } catch (innerErr) {
                console.error('❌ 获取当前区块失败:', innerErr);
            }
        }

        setTimeout(pollBurnedEvents, 10000);
    }

    pollBurnedEvents();
    
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


if (require.main === module) {
    startBurnListening();
}
