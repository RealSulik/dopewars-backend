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

    // Get the most recent active game run for this player
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
        success: false,
        error: 'No active game found'
      }, { status: 404 });
    }

    // Get current prices for this run
    const { data: priceData } = await supabase
      .from('daily_prices')
      .select('*')
      .eq('run_id', gameRun.id)
      .eq('day', gameRun.days_played)
      .eq('location', gameRun.location)
      .single();

    const prices = priceData ? [
      priceData.weed_price,
      priceData.acid_price,
      priceData.cocaine_price,
      priceData.heroin_price
    ] : [0, 0, 0, 0];

    // Get player's accumulated ICE from database
    const { data: playerData } = await supabase
      .from('players')
      .select('total_ice')
      .eq('wallet_address', playerAddress)
      .single();

    // Build game state
    const gameState = {
      cash: gameRun.cash,
      location: gameRun.location,
      netWorthGoal: 1000000, // Fixed goal
      daysPlayed: gameRun.days_played,
      lastEventDescription: gameRun.last_event || '',
      hasFinished: gameRun.status === 'finished',
      didWin: gameRun.did_win || false,
      finalNetWorth: gameRun.final_net_worth || 0,
      hustlesUsed: gameRun.hustles_used || 0,
      stashesUsed: gameRun.stashes_used || 0,
      inventory: [
        gameRun.weed || 0,
        gameRun.acid || 0,
        gameRun.cocaine || 0,
        gameRun.heroin || 0
      ],
      prices,
      totalIce: playerData?.total_ice || 0 // Fetch actual ICE from database
    };

    return NextResponse.json({
      success: true,
      gameState
    });

  } catch (error: any) {
    console.error('Get game state error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to get game state' },
      { status: 500 }
    );
  }
}
