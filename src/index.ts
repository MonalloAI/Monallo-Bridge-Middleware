import { ethers, EventLog } from 'ethers';
import * as dotenv from 'dotenv';
import LockTokensAbi from './abi/LockTokens.json';
import MintTokensAbi from './abi/MintTokens.json';
import { connectDB } from './db';
import LockModel from './model/lock';

dotenv.config();

const {
    LOCK_CONTRACT_ADDRESS,
    MINT_CONTRACT_ADDRESS,
    PRIVATE_KEY,
    IMUA_RPC_URL,      
    ETH_RPC_URL,       
    ETH_API_KEY
} = process.env;

if (!LOCK_CONTRACT_ADDRESS || !MINT_CONTRACT_ADDRESS || !PRIVATE_KEY || !IMUA_RPC_URL || !ETH_RPC_URL || !ETH_API_KEY) {
    throw new Error('请检查.env文件，相关环境变量未配置完整');
}

// ✅ A链 Provider 和合约（HTTP）
const aProvider = new ethers.WebSocketProvider(`${ETH_RPC_URL}${ETH_API_KEY}`);
const lockContract = new ethers.Contract(
    LOCK_CONTRACT_ADDRESS,
    LockTokensAbi.abi,
    aProvider
);

// ✅ B链 Provider（WebSocket）和合约
const bProvider = new ethers.JsonRpcProvider(IMUA_RPC_URL);
const bWallet = new ethers.Wallet(PRIVATE_KEY, bProvider);
const mintContract = new ethers.Contract(
    MINT_CONTRACT_ADDRESS,
    MintTokensAbi.abi,
    bWallet
);

export async function startListening() {
    await connectDB();
    console.log('开始轮询监听 A 链 Locked 事件...');

    let lastCheckedBlock = await aProvider.getBlockNumber();

    setInterval(async () => {
        try {
            const currentBlock = await aProvider.getBlockNumber();
            if (currentBlock <= lastCheckedBlock) return;

            const events = await lockContract.queryFilter(
                lockContract.filters.Locked(),
                lastCheckedBlock + 1,
                currentBlock
            );
            lastCheckedBlock = currentBlock;

            for (const rawEvent of events) {
                const event = rawEvent as EventLog;
                const { sender, receiver, amount, fee, crosschainHash } = event.args;
                const txHash = event.transactionHash;

                const receipt = await aProvider.waitForTransaction(txHash, 1, 60000);
                if (!receipt || !receipt.blockNumber) {
                    console.error('A链交易未确认，跳过:', txHash);
                    continue;
                }
                console.log('✅ 锁币已在链上确认:', txHash);

                // ✅ 查找已有记录
                const existingRecord = await LockModel.findOne({ sourceFromTxHash: txHash });

                if (existingRecord && existingRecord.status === 'minted') {
                    console.log('该事件已处理，跳过:', txHash);
                    continue;
                }

                try {
                    const tx = await mintContract.mint(receiver, amount, crosschainHash);
                    console.log('已发送 B 链 mint 交易，txHash:', tx.hash);
                    await tx.wait();
                    console.log('B 链 mint 交易已上链');
                    console.log('✅ 铸币成功:', {
                        sender,     
                        receiver,
                        amount: ethers.formatEther(amount),
                        fee: fee ? ethers.formatEther(fee) : '0',
                        crosschainHash,     
                        sourceFromTxHash: txHash,
                        targetToTxHash: tx.hash
                    });

                    if (existingRecord) {
                        existingRecord.status = 'minted';
                        (existingRecord as any).targetToTxHash = tx.hash;
                        await existingRecord.save();
                    } else {
                        await LockModel.updateOne(
                            { sourceFromTxHash: txHash },
                            {
                                $set: {
                                    fromAddress: sender,
                                    toAddress: receiver,
                                    amount: amount.toString(),
                                    fee: fee?.toString(),
                                    targetToTxHash: tx.hash,
                                    status: 'minted',
                                    timestamp: new Date()
                                }
                            },
                            { upsert: true }
                        );
                    }
                } catch (err: any) {
                    if (err.code === 'INSUFFICIENT_FUNDS') {
                        console.error('❌ B链钱包余额不足，无法支付 Gas 费用，请充值 ETH 到:', bWallet.address);
                    } else {
                        console.error('❌ 铸币交易失败:', err);
                    }
                }
            }
        } catch (err) {
            console.error('轮询处理 Locked 事件时出错:', err);
        }
    }, 5000); 
}
