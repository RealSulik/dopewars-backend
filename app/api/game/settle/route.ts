import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Contract details
const CONTRACT_ADDRESS = '0x58b200A5ac031DD6245ffc63E0A247AEe39ec609';
const CONTRACT_ABI = [
  {
    "inputs": [
      {"internalType": "address", "name": "playerAddress", "type": "address"},
      {"internalType": "uint256", "name": "finalNetWorth", "type": "uint256"},
      {"internalType": "uint256", "name": "daysPlayed", "type": "uint256"},
      {"internalType": "bytes32", "name": "runId", "type": "bytes32"},
      {"internalType": "bytes", "name": "signature", "type": "bytes"}
    ],
    "name": "settleRun",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {"internalType": "address", "name": "player", "type": "address"}
    ],
    "name": "getPlayerStats",
    "outputs": [
      {"internalType": "uint256", "name": "ice", "type": "uint256"},
      {"internalType": "uint256", "name": "bestScore", "type": "uint256"},
      {"internalType": "uint256", "name": "runs", "type": "uint256"},
      {"internalType": "uint256", "name": "wins", "type": "uint256"}
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

export async function POST(request: NextRequest) {
  try {
    const { playerAddress } = await request.json();

    console.log('🔥 Settlement request for:', playerAddress);

    if (!playerAddress) {
      return NextResponse.json(
        { success: false, error: 'Player address required' },
        { status: 400 }
      );
    }

    // Get the active run for this player
    const { data: gameRun, error: runError } = await supabase
      .from('game_runs')
      .select('*')
      .eq('wallet_address', playerAddress)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (runError || !gameRun) {
      return NextResponse.json(
        { success: false, error: 'No active game found to settle' },
        { status: 404 }
      );
    }

    // Check if already settled
    if (gameRun.settled) {
      return NextResponse.json(
        { success: false, error: 'Game already settled' },
        { status: 400 }
      );
    }

    // Get current prices for final net worth calculation
    const { data: priceData } = await supabase
      .from('daily_prices')
      .select('*')
      .eq('run_id', gameRun.id)
      .eq('day', gameRun.days_played)
      .eq('location', gameRun.location)
      .single();

    const prices = priceData ? {
      weed: priceData.weed_price,
      acid: priceData.acid_price,
      cocaine: priceData.cocaine_price,
      heroin: priceData.heroin_price
    } : { weed: 0, acid: 0, cocaine: 0, heroin: 0 };

    // Calculate PROPER net worth: cash + bank - debt + drugs
    const drugValue = 
      (gameRun.weed * prices.weed) +
      (gameRun.acid * prices.acid) +
      (gameRun.cocaine * prices.cocaine) +
      (gameRun.heroin * prices.heroin);

    const finalNetWorth = Math.max(0, 
      gameRun.cash + 
      gameRun.bank_balance - 
      gameRun.debt + 
      drugValue
    );

    console.log('💰 Final net worth calculation:', {
      cash: gameRun.cash,
      bank: gameRun.bank_balance,
      debt: gameRun.debt,
      drugValue,
      finalNetWorth
    });
    console.log('📅 Days played:', gameRun.days_played);

    // Generate runId (unique identifier for this game)
    const runId = ethers.keccak256(
      ethers.toUtf8Bytes(`${gameRun.id}-${gameRun.created_at}`)
    );

    console.log('🆔 Run ID:', runId);

    // Get server wallet
    const serverPrivateKey = process.env.SERVER_PRIVATE_KEY;
    if (!serverPrivateKey) {
      throw new Error('Server private key not configured');
    }

    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
    const serverWallet = new ethers.Wallet(serverPrivateKey, provider);

    console.log('🔑 Server wallet:', serverWallet.address);

    // Sign with PLAYER ADDRESS
    const messageHash = ethers.keccak256(
      ethers.solidityPacked(
        ['address', 'uint256', 'uint256', 'bytes32'],
        [playerAddress, finalNetWorth, gameRun.days_played, runId]
      )
    );

    const ethSignedMessageHash = ethers.keccak256(
      ethers.solidityPacked(
        ['string', 'bytes32'],
        ['\x19Ethereum Signed Message:\n32', messageHash]
      )
    );

    const signature = await serverWallet.signMessage(ethers.getBytes(messageHash));

    console.log('✍️ Signature created:', signature);

    // Call smart contract
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, serverWallet);

    console.log('📞 Calling settleRun with:', {
      playerAddress,
      finalNetWorth,
      daysPlayed: gameRun.days_played,
      runId,
      signatureLength: signature.length
    });

    const tx = await contract.settleRun(
      playerAddress,
      finalNetWorth,
      gameRun.days_played,
      runId,
      signature
    );

    console.log('⏳ Transaction sent:', tx.hash);

    const receipt = await tx.wait();
    console.log('✅ Transaction confirmed:', receipt.hash);

    // ===== READ ICE FROM BLOCKCHAIN (NOT DATABASE!) =====
    console.log('🔍 Reading player stats from blockchain...');
    const playerStats = await contract.getPlayerStats(playerAddress);
    const blockchainIce = Number(playerStats[0]); // ice
    const blockchainBestScore = Number(playerStats[1]); // bestScore
    const blockchainRuns = Number(playerStats[2]); // runs
    const blockchainWins = Number(playerStats[3]); // wins

    console.log('📊 Blockchain stats:', {
      ice: blockchainIce,
      bestScore: blockchainBestScore,
      runs: blockchainRuns,
      wins: blockchainWins
    });

    // Mark game as settled in database
    const didWin = gameRun.won_at_day !== null; // Check if they ever hit $1M
    
    await supabase
      .from('game_runs')
      .update({
        settled: true,
        status: didWin ? 'won' : 'lost',
        final_net_worth: finalNetWorth,
        blockchain_tx: receipt.hash,
        ice_awarded: didWin ? 10 : calculateIceReward(finalNetWorth, gameRun.days_played)
      })
      .eq('id', gameRun.id);

    // ===== UPDATE LEADERBOARD WITH BLOCKCHAIN ICE =====
    await supabase
      .from('leaderboard')
      .upsert({
        wallet_address: playerAddress,
        best_net_worth: blockchainBestScore, // Use blockchain's best score
        total_runs: blockchainRuns, // Use blockchain runs
        total_wins: blockchainWins, // Use blockchain wins
        total_ice: blockchainIce // ✅ USE BLOCKCHAIN ICE!
      }, {
        onConflict: 'wallet_address',
        ignoreDuplicates: false
      });

    console.log('✅ Settlement complete! Leaderboard updated with blockchain ICE:', blockchainIce);

    return NextResponse.json({
      success: true,
      txHash: receipt.hash,
      finalNetWorth,
      daysPlayed: gameRun.days_played,
      wonAtDay: gameRun.won_at_day,
      iceAwarded: didWin ? 10 : calculateIceReward(finalNetWorth, gameRun.days_played),
      totalIce: blockchainIce, // Return total ICE from blockchain
      didWin,
      message: didWin
        ? `🎉 YOU WON at Day ${gameRun.won_at_day}! Earned 10 ICE!` 
        : 'Game settled. Try again for the $1M goal!'
    });

  } catch (error: any) {
    console.error('❌ Settlement error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Settlement failed' },
      { status: 500 }
    );
  }
}

function calculateIceReward(netWorth: number, days: number): number {
  if (netWorth >= 1_000_000) return 10; // Win!
  if (days >= 30) return 3; // Survived full game
  if (netWorth >= 500_000) return 5; // Good run
  if (netWorth >= 250_000) return 2; // Decent run
  return 1; // Participation
}