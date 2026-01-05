import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Contract details
const CONTRACT_ADDRESS = '0x58b200A5ac031DD6245ffc63E0A247AEe39ec609';

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

    // Get server wallet for SIGNING ONLY
    const serverPrivateKey = process.env.SERVER_PRIVATE_KEY;
    if (!serverPrivateKey) {
      throw new Error('Server private key not configured');
    }

    const serverWallet = new ethers.Wallet(serverPrivateKey);

    console.log('🔐 Server wallet (for signing):', serverWallet.address);

    // Create the message hash (matches contract logic)
    const messageHash = ethers.keccak256(
      ethers.solidityPacked(
        ['address', 'uint256', 'uint256', 'bytes32'],
        [playerAddress, finalNetWorth, gameRun.days_played, runId]
      )
    );

    // Sign the message hash
    const signature = await serverWallet.signMessage(ethers.getBytes(messageHash));

    console.log('✏️ Signature created:', signature);

    // Calculate ICE reward
    const didWin = gameRun.won_at_day !== null;
    const iceAwarded = didWin ? 10 : calculateIceReward(finalNetWorth, gameRun.days_played);

    // ✅ CHANGED: Don't change status here - keep it as 'active'
    // Only store the final_net_worth for reference
    await supabase
      .from('game_runs')
      .update({
        final_net_worth: finalNetWorth,
        // status stays 'active' - will change to 'settled' in PATCH after tx confirms
      })
      .eq('id', gameRun.id);

    console.log('✅ Settlement signature prepared, game still active (can retry if tx fails)');

    // Read current ICE from blockchain for display
    let totalIce = 0;
    try {
      const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org');
      const contractABI = [
        {
          "inputs": [{"internalType": "address", "name": "player", "type": "address"}],
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
      const contract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, provider);
      const playerStats = await contract.getPlayerStats(playerAddress);
      totalIce = Number(playerStats[0]);
      console.log('📊 Current blockchain ICE:', totalIce);
    } catch (err) {
      console.warn('Could not read blockchain ICE, using 0:', err);
    }

    // Return signature for frontend to use
    return NextResponse.json({
      success: true,
      signature,              // Frontend uses this to call contract
      finalNetWorth,
      daysPlayed: gameRun.days_played,
      runId,                  // Frontend sends this in transaction
      gameRunId: gameRun.id,  // ✅ NEW: Send database ID for PATCH to use
      wonAtDay: gameRun.won_at_day,
      iceAwarded,
      totalIce: totalIce + iceAwarded, // Estimated total after this settlement
      didWin,
      message: didWin
        ? `🎉 YOU WON at Day ${gameRun.won_at_day}! Will earn 10 ICE!` 
        : 'Settlement ready. Confirm transaction in your wallet.'
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

// ✅ CHANGED: PATCH now looks up by database ID and changes status from 'active' to 'settled'
export async function PATCH(request: NextRequest) {
  try {
    const { gameRunId, txHash, playerAddress } = await request.json();

    console.log('🔄 Finalizing settlement:', { gameRunId, txHash, playerAddress });

    // Get the game run by database ID
    const { data: gameRun, error: fetchError } = await supabase
      .from('game_runs')
      .select('*')
      .eq('id', gameRunId)
      .single();

    if (fetchError || !gameRun) {
      console.error('❌ Game run not found for settlement:', fetchError);
      return NextResponse.json(
        { success: false, error: 'Game run not found' },
        { status: 404 }
      );
    }

    // ✅ CHANGED: Verify game is still active (not already settled)
    if (gameRun.status !== 'active') {
      console.log('⚠️ Game already settled or in invalid state:', gameRun.status);
      return NextResponse.json(
        { success: false, error: 'Game already settled' },
        { status: 400 }
      );
    }

    console.log('✅ Found active game run to finalize:', gameRun.id);

    // Read stats from blockchain
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org');
    const contractABI = [
      {
        "inputs": [{"internalType": "address", "name": "player", "type": "address"}],
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
    const contract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, provider);

    console.log('📊 Reading player stats from blockchain...');
    const playerStats = await contract.getPlayerStats(playerAddress);
    const blockchainIce = Number(playerStats[0]);
    const blockchainBestScore = Number(playerStats[1]);
    const blockchainRuns = Number(playerStats[2]);
    const blockchainWins = Number(playerStats[3]);

    console.log('📊 Blockchain stats:', {
      ice: blockchainIce,
      bestScore: blockchainBestScore,
      runs: blockchainRuns,
      wins: blockchainWins
    });

    // Mark game as settled
    const didWin = gameRun.won_at_day !== null;
    
    // ✅ CHANGED: Now we change status from 'active' to 'settled'
    await supabase
      .from('game_runs')
      .update({
        settled: true,
        status: 'settled',  // ✅ Changed from 'active' to 'settled' only after tx confirms
        blockchain_tx: txHash,
        ice_awarded: didWin ? 10 : calculateIceReward(gameRun.final_net_worth, gameRun.days_played)
      })
      .eq('id', gameRun.id);

    // Update leaderboard with blockchain data
    const { error: leaderboardError } = await supabase
      .from('leaderboard')
      .upsert({
        wallet_address: playerAddress,
        best_net_worth: blockchainBestScore,
        total_runs: blockchainRuns,
        total_wins: blockchainWins,
        total_ice: blockchainIce
      }, {
        onConflict: 'wallet_address',
        ignoreDuplicates: false
      });

    if (leaderboardError) {
      console.error('❌ Leaderboard update failed:', leaderboardError);
    } else {
      console.log('✅ Leaderboard updated successfully!');
    }

    console.log('✅ Settlement finalized! Status changed to settled. Leaderboard updated with blockchain ICE:', blockchainIce);

    return NextResponse.json({
      success: true,
      totalIce: blockchainIce,
      message: 'Settlement finalized successfully'
    });

  } catch (error: any) {
    console.error('❌ Settlement finalization error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to finalize settlement' },
      { status: 500 }
    );
  }
}