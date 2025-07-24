import CrossBridgeRecord from '../model/CrossBridgeRecord.model';
import { ethers } from 'ethers';
import MintTokensAbi from '../abi/MintTokens.json';
import LockTokensAbi from '../abi/LockTokens.json';
import { sendToUser } from '../WebSocket/websocket';
import * as fs from 'fs';
import * as path from 'path';

interface QueueCheckerConfig {
    mintContract: ethers.Contract;
    lockTokensContract: ethers.Contract;
    bProvider: ethers.Provider;
    ethProvider: ethers.Provider;
    wallet?: ethers.Wallet;
}

export class QueueChecker {
    private config: QueueCheckerConfig;
    private deployedAddresses: any;

    constructor(config: QueueCheckerConfig) {
        this.config = config;
        // 读取部署地址配置文件
        const addressesPath = path.join(__dirname, '../abi/deployed_addresses.json');
        this.deployedAddresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
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
        const { sourceFromTxHash, targetToAddress, sourceFromAmount, crosschainHash, sourceFromTokenName, sourceFromChainId } = record;

        try {
            let tx;
            
            if (sourceFromTokenName?.startsWith('mao')) {
                // 根据源链ID获取对应的目标合约地址
                let targetContractAddress = null;
                if (sourceFromChainId) {
                    targetContractAddress = this.deployedAddresses.imua.targets[`target_${sourceFromChainId}`];
                    console.log(`🔍 根据源链ID ${sourceFromChainId} 获取目标合约地址: ${targetContractAddress}`);
                }
                
                if (!targetContractAddress) {
                    console.log('⚠️ 未找到对应的目标合约地址，使用默认合约');
                    // 使用默认合约
                    tx = await this.config.mintContract.mint(
                        targetToAddress, 
                        sourceFromAmount, 
                        crosschainHash
                    );
                } else {
                    // 使用动态合约地址
                    const wallet = this.config.wallet || new ethers.Wallet(process.env.PRIVATE_KEY!, this.config.bProvider);
                    const mintContractDynamic = new ethers.Contract(targetContractAddress, MintTokensAbi.abi, wallet);
                    
                    // 执行 mint 操作
                    tx = await mintContractDynamic.mint(
                        targetToAddress, 
                        sourceFromAmount, 
                        crosschainHash
                    );
                }
                console.log(`📤 重试 mint 交易: ${tx.hash}`);
            } else {
                // 执行 unlock 操作
                // unlock 函数需要 5 个参数：_txId, _token, _recipient, _amount, _signature
                
                // 获取 token 地址
                const tokenAddress = record.sourceFromTokenContractAddress || '0x0000000000000000000000000000000000000000';
                
                // 生成签名
                console.log('🔐 开始生成签名...');
                
                // 构造消息哈希（匹配合约逻辑）
                // 合约期望的消息哈希格式：keccak256(abi.encodePacked(txId, token, recipient, amount))
                const messageHash = ethers.solidityPackedKeccak256(
                    ['bytes32', 'address', 'address', 'uint256'],
                    [crosschainHash, tokenAddress, targetToAddress, sourceFromAmount]
                );
                
                console.log('🔐 消息哈希:', messageHash);
                console.log('🔐 签名参数:', {
                    txId: crosschainHash,
                    token: tokenAddress,
                    recipient: targetToAddress,
                    amount: sourceFromAmount.toString()
                });
                
                // 将哈希转换为以太坊签名消息格式
                const ethSignedMessageHash = ethers.hashMessage(ethers.getBytes(messageHash));
                console.log('🔐 以太坊签名消息哈希:', ethSignedMessageHash);
                
                // 使用钱包签名消息
                const wallet = this.config.wallet || new ethers.Wallet(process.env.PRIVATE_KEY!, this.config.bProvider);
                // 直接对原始消息哈希进行签名，ethers.js 会自动添加前缀
                const signature = await wallet.signMessage(ethers.getBytes(messageHash));
                
                console.log('✅ 签名生成成功:', signature.slice(0, 20) + '...');
                
                // 检查合约中的代币余额
                console.log('🔍 检查合约代币余额...');
                try {
                    let contractBalance;
                    let tokenContract;
                    let symbol = 'ETH';
                    let decimals = 18;
                    
                    if (tokenAddress === '0x0000000000000000000000000000000000000000') {
                        // 检查原生代币余额
                        contractBalance = await this.config.bProvider.getBalance(this.config.lockTokensContract.target);
                        console.log(`💰 合约原生代币余额: ${ethers.formatEther(contractBalance)} ETH`);
                    } else {
                        // 检查ERC20代币余额
                        tokenContract = new ethers.Contract(
                            tokenAddress,
                            [
                                'function balanceOf(address account) view returns (uint256)',
                                'function symbol() view returns (string)',
                                'function decimals() view returns (uint8)',
                                'function allowance(address owner, address spender) view returns (uint256)'
                            ],
                            this.config.bProvider
                        );
                        
                        contractBalance = await tokenContract.balanceOf(this.config.lockTokensContract.target);
                        symbol = await tokenContract.symbol().catch(() => 'TOKEN');
                        decimals = await tokenContract.decimals().catch(() => 18);
                        
                        console.log(`💰 合约 ${symbol} 代币余额: ${ethers.formatUnits(contractBalance, decimals)} ${symbol}`);
                    }
                    
                    // 检查余额是否足够
                    if (contractBalance < sourceFromAmount) {
                        console.error(`❌ 合约余额不足! 需要 ${ethers.formatUnits(sourceFromAmount, decimals)} ${symbol}，但只有 ${ethers.formatUnits(contractBalance, decimals)} ${symbol}`);
                        console.log('💡 请确保合约中有足够的代币余额');
                        throw new Error('合约余额不足');
                    }
                    
                    console.log('✅ 合约余额充足，继续执行...');
                } catch (balanceError) {
                    console.error('❌ 检查余额时出错:', balanceError);
                    throw balanceError; // 重新抛出错误，中断执行
                }
                
                // 测试签名是否有效以及 ERC20 转账是否会成功
                console.log('🧪 测试签名有效性和代币转账...');
                try {
                    // 使用静态调用测试 unlock 操作
                    await this.config.lockTokensContract.unlock.staticCall(
                        crosschainHash,  // txId
                        tokenAddress,     // token
                        targetToAddress,  // recipient
                        sourceFromAmount, // amount
                        signature
                    );
                    console.log('✅ 签名验证成功！');
                    
                    // 如果是 ERC20 代币，测试代币转账是否会成功
                    if (tokenAddress !== '0x0000000000000000000000000000000000000000') {
                        console.log('🧪 测试 ERC20 代币转账...');
                        try {
                            // 创建 ERC20 合约实例
                            const tokenContract = new ethers.Contract(
                                tokenAddress,
                                [
                                    'function transfer(address to, uint256 amount) returns (bool)',
                                    'function balanceOf(address account) view returns (uint256)'
                                ],
                                this.config.lockTokensContract.runner
                            );
                            
                            // 检查合约是否有足够的代币余额
                            const contractBalance = await tokenContract.balanceOf(this.config.lockTokensContract.target);
                            if (contractBalance < sourceFromAmount) {
                                throw new Error(`合约余额不足: ${ethers.formatUnits(contractBalance)} < ${ethers.formatUnits(sourceFromAmount)}`);
                            }
                            
                            console.log('✅ ERC20 代币转账测试通过');
                        } catch (error) {
                            const erc20Error = error as Error;
                            console.error('❌ ERC20 代币转账测试失败:', erc20Error);
                            throw new Error(`ERC20 代币转账可能会失败: ${erc20Error.message}`);
                        }
                    }
                    
                    console.log('✅ 所有测试通过，准备执行实际 unlock 操作');
                } catch (testError) {
                    console.error('❌ 测试失败:', testError);
                    console.log('💡 可能需要进一步调试签名格式或代币转账问题');
                    throw testError; // 重新抛出错误，中断执行
                }
                
                // 执行 unlock 操作
                console.log('🔓 准备执行 unlock 操作，参数:', {
                    txId: crosschainHash,
                    token: tokenAddress,
                    recipient: targetToAddress,
                    amount: sourceFromAmount.toString(),
                    signatureLength: signature.length
                });
                
                // 如果是 ERC20 代币，检查合约是否有足够的代币余额
                if (tokenAddress !== '0x0000000000000000000000000000000000000000') {
                    try {
                        // 创建 ERC20 合约实例
                        const tokenContract = new ethers.Contract(
                            tokenAddress,
                            [
                                'function balanceOf(address account) view returns (uint256)',
                                'function symbol() view returns (string)',
                                'function decimals() view returns (uint8)'
                            ],
                            this.config.bProvider
                        );
                        
                        // 再次检查合约余额
                        const contractBalance = await tokenContract.balanceOf(this.config.lockTokensContract.target);
                        const symbol = await tokenContract.symbol().catch(() => 'TOKEN');
                        const decimals = await tokenContract.decimals().catch(() => 18);
                        
                        console.log(`🔍 最终检查 - 合约 ${symbol} 代币余额: ${ethers.formatUnits(contractBalance, decimals)} ${symbol}`);
                        console.log(`🔍 需要转账金额: ${ethers.formatUnits(sourceFromAmount, decimals)} ${symbol}`);
                        
                        if (contractBalance < sourceFromAmount) {
                            throw new Error(`合约余额不足: ${ethers.formatUnits(contractBalance, decimals)} < ${ethers.formatUnits(sourceFromAmount, decimals)}`);
                        }
                    } catch (finalCheckError) {
                        console.error('❌ 最终余额检查失败:', finalCheckError);
                        throw finalCheckError;
                    }
                }
                
                // 执行 unlock 操作
                tx = await this.config.lockTokensContract.unlock(
                    crosschainHash,  // txId
                    tokenAddress,     // token
                    targetToAddress,  // recipient
                    sourceFromAmount, // amount
                    signature,        // signature
                    { gasLimit: 500000 } // 设置足够的 gas 限制
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