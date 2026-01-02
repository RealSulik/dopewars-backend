import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const playerAddress = searchParams.get('playerAddress');

    if (!playerAddress) {
      return NextResponse.json(
        { success: false, error: 'Player address required' },
        { status: 400 }
      );
    }

    // Get active game run
    const { data: gameRun, error: runError } = await supabase
      .from('game_runs')
      .select('*')
      .eq('wallet_address', playerAddress)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (runError || !gameRun) {
      return NextResponse.json({
        success: true,
        gameState: null,
        message: 'No active game found'
      });
    }

    // Get current prices for this location
    const { data: priceData } = await supabase
      .from('daily_prices')
      .select('*')
      .eq('run_id', gameRun.id)
      .eq('day', gameRun.days_played)
      .eq('location', gameRun.location)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const prices = priceData ? [
      priceData.weed_price,
      priceData.acid_price,
      priceData.cocaine_price,
      priceData.heroin_price
    ] : [0, 0, 0, 0];

    // Get player's total ICE
    const { data: playerData } = await supabase
      .from('players')
      .select('total_ice')
      .eq('wallet_address', playerAddress)
      .single();

    const totalIce = playerData?.total_ice || 0;

    // Build game state response
    const gameState = {
      // Basic stats
      cash: gameRun.cash,
      location: gameRun.location,
      daysPlayed: gameRun.days_played,
      
      // NEW: Financial system
      debt: gameRun.debt,
      bankBalance: gameRun.bank_balance,
      
      // NEW: Inventory system
      trenchcoatCapacity: gameRun.trenchcoat_capacity,
      inventory: [
        gameRun.weed,
        gameRun.acid,
        gameRun.cocaine,
        gameRun.heroin
      ],
      totalDrugs: gameRun.weed + gameRun.acid + gameRun.cocaine + gameRun.heroin,
      
      // NEW: Combat system
      health: gameRun.health,
      hasGun: gameRun.has_gun,
      
      // NEW: Upgrades
      coatUpgrades: gameRun.coat_upgrades,
      
      // Prices
      prices,
      
      // Game progress
      hustlesUsed: gameRun.hustles_used,
      stashesUsed: gameRun.stashes_used,
      lastEventDescription: gameRun.last_event_description,
      
      // Status
      status: gameRun.status,
      hasFinished: gameRun.status !== 'active',
      
      // ICE
      totalIce,
      
      // Meta
      netWorthGoal: 1_000_000, // $1M goal
      
      // Calculate current net worth
      currentNetWorth: calculateNetWorth(gameRun, prices)
    };

    return NextResponse.json({
      success: true,
      gameState
    });

  } catch (error: any) {
    console.error('State fetch error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to fetch state' },
      { status: 500 }
    );
  }
}

function calculateNetWorth(gameRun: any, prices: number[]): number {
  // Net worth = cash + bank - debt + (drugs × prices)
  let netWorth = gameRun.cash + gameRun.bank_balance - gameRun.debt;
  
  // Add drug values
  netWorth += gameRun.weed * prices[0];
  netWorth += gameRun.acid * prices[1];
  netWorth += gameRun.cocaine * prices[2];
  netWorth += gameRun.heroin * prices[3];
  
  return Math.max(0, netWorth);
}
