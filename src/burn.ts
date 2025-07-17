import { ethers } from 'ethers';
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

if (!LOCK_CONTRACT_ADDRESS || !MINT_CONTRACT_ADDRESS || !BURN_CONTRACT_ADDRESS || !PRIVATE_KEY || !IMUA_RPC_URL || !ETH_RPC_URL || !ETH_API_KEY) {
    throw new Error('请检查.env文件，相关环境变量未配置完整');
}

const aProvider = new ethers.WebSocketProvider(`${ETH_RPC_URL}${ETH_API_KEY}`);
const bProvider = new ethers.JsonRpcProvider(IMUA_RPC_URL);
const bWallet = new ethers.Wallet(PRIVATE_KEY, bProvider);
const burnManagerContract = new ethers.Contract(
    BURN_CONTRACT_ADDRESS,
    BurnManagerAbi.abi,
    aProvider
);
const mintContract = new ethers.Contract(
    MINT_CONTRACT_ADDRESS,
    MintTokensAbi.abi,
    bWallet
);
const lockTokensContract = new ethers.Contract(
    LOCK_CONTRACT_ADDRESS,
    LockTokensAbi.abi,
    bWallet
);

export async function startBurnListening() {
    await connectDB();
    console.log('开始监听 BurnManager 合约 Burned 事件...');
    burnManagerContract.on('Burned', async (burner, amount, sepoliaRecipient, crosschainHash, event) => {
        try {
            const txHash = event.transactionHash;
            console.log('🔥 监听到 Burned 事件:', { burner, amount: amount.toString(), sepoliaRecipient, crosschainHash, txHash });
   
            let tokenName = '';
            let record = await LockModel.findOne({ sourceFromTxHash: txHash });
            if (record && record.sourceFromTokenName) {
                tokenName = record.sourceFromTokenName;
                console.log('从数据库获取到tokenName:', tokenName);
            } else {
          
                try {
                    const tokenAddress = await burnManagerContract.token();
                    const tokenContract = new ethers.Contract(tokenAddress, MintTokensAbi.abi, aProvider);
                    tokenName = await tokenContract.name();
                    console.log('链上获取到tokenName:', tokenName);
                } catch (err) {
                    console.error('无法获取tokenName:', err);
                }
            }
            if (!tokenName) {
                console.error('无法获取币种名称，跳过处理:', txHash);
                return;
            }
        
            if (tokenName.startsWith('mao')) {
       
                try {
                    const tx = await mintContract.mint(sepoliaRecipient, amount, crosschainHash);
                    console.log('已发送 B 链 mint 交易，txHash:', tx.hash);
                    await tx.wait();
                    console.log('B 链 mint 交易已上链');
                    sendToUser(sepoliaRecipient, {
                        type: 'MINT_SUCCESS',
                        data: { targetToTxHash: tx.hash }
                    });
                    console.log('✅ 铸币成功:', { sepoliaRecipient, amount: ethers.formatEther(amount), crosschainHash, txHash, targetToTxHash: tx.hash });
                } catch (err: any) {
                    if (err.code === 'INSUFFICIENT_FUNDS') {
                        console.error('❌ B链钱包余额不足，无法支付 Gas 费用，请充值 ETH 到:', bWallet.address);
                    } else {
                        console.error('❌ 铸币交易失败:', err);
                    }
                    sendToUser(sepoliaRecipient, {
                        type: 'MINT_FAILED',
                        data: { error: err.message || err }
                    });
                }
            } else {
             
                try {
                    const tx = await lockTokensContract.unlock(sepoliaRecipient, amount, crosschainHash);
                    console.log('已发送 B 链 unlock 交易，txHash:', tx.hash);
                    await tx.wait();
                    console.log('B 链 unlock 交易已上链');
                    sendToUser(sepoliaRecipient, {
                        type: 'UNLOCK_SUCCESS',
                        data: { targetToTxHash: tx.hash }
                    });
                    console.log('✅ 解锁成功:', { sepoliaRecipient, amount: ethers.formatEther(amount), crosschainHash, txHash, targetToTxHash: tx.hash });
                } catch (err: any) {
                    if (err.code === 'INSUFFICIENT_FUNDS') {
                        console.error('❌ B链钱包余额不足，无法支付 Gas 费用，请充值 ETH 到:', bWallet.address);
                    } else {
                        console.error('❌ 解锁交易失败:', err);
                    }
                    sendToUser(sepoliaRecipient, {
                        type: 'UNLOCK_FAILED',
                        data: { error: err.message || err }
                    });
                }
            }
        } catch (err) {
            console.error('处理 Burned 事件时出错:', err);
        }
    });
}


if (require.main === module) {
    startBurnListening();
} 