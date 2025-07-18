import { ethers, WebSocketProvider } from 'ethers';
import * as dotenv from 'dotenv';
import BurnManagerAbi from './abi/BurnManager.json';
import MintTokensAbi from './abi/MintTokens.json';
import LockTokensAbi from './abi/LockTokens.json';
import { connectDB } from './db';
import LockModel from './model/CrossBridgeRecord.model';
import { sendToUser } from './WebSocket/websocket';

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


const burnManagerContract = new ethers.Contract(BURN_CONTRACT_ADDRESS, BurnManagerAbi.abi, aProvider);
const mintContract = new ethers.Contract(MINT_CONTRACT_ADDRESS, MintTokensAbi.abi, bWallet);
const lockTokensContract = new ethers.Contract(LOCK_CONTRACT_ADDRESS, LockTokensAbi.abi, ethWallet);


export async function startBurnListening() {
    await connectDB();
    console.log('✅ 已连接数据库，准备监听 BurnManager 的 Burned 事件...');

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

                console.log('🔥 检测到 Burned 事件:', {
                    burner,
                    amount: amount?.toString(),
                    sepoliaRecipient,
                    crosschainHash,
                    txHash
                });

                let tokenName = '';

                // 先从数据库查 tokenName
                const record = await LockModel.findOne({ sourceFromTxHash: txHash });
                if (record?.sourceFromTokenName) {
                    tokenName = record.sourceFromTokenName;
                    console.log('🧩 数据库获取 tokenName:', tokenName);
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

                if (tokenName.startsWith('mao')) {
                    // mint
                    try {
                        const tx = await mintContract.mint(sepoliaRecipient, amount, crosschainHash);
                        console.log('📤 发送 mint 交易，txHash:', tx.hash);
                        await tx.wait();
                        console.log('✅ mint 交易已确认');

                        sendToUser(sepoliaRecipient, {
                            type: 'MINT_SUCCESS',
                            data: { targetToTxHash: tx.hash }
                        });
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
                        const tx = await lockTokensContract.unlock(sepoliaRecipient, amount, crosschainHash);
                        console.log('🔓 发送 unlock 交易，txHash:', tx.hash);
                        await tx.wait();
                        console.log('✅ unlock 交易已确认');

                        sendToUser(sepoliaRecipient, {
                            type: 'UNLOCK_SUCCESS',
                            data: { targetToTxHash: tx.hash }
                        });
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
            try {
                lastBlock = await aProvider.getBlockNumber();
            } catch (innerErr) {
                console.error('❌ 获取当前区块失败:', innerErr);
            }
        }

        setTimeout(pollBurnedEvents, 10000);
    }

    pollBurnedEvents();
}


if (require.main === module) {
    startBurnListening();
}
