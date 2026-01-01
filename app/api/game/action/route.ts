import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DRUG_NAMES = ['Weed', 'Acid', 'Cocaine', 'Heroin'];
const PRICE_RANGES = {
  0: { min: 100, max: 1000 },
  1: { min: 1000, max: 4000 },
  2: { min: 15000, max: 30000 },
  3: { min: 5000, max: 15000 }
};

const CITY_MULTIPLIERS = [
  [1.0, 1.2, 1.5, 1.1],
  [0.9, 1.1, 0.8, 0.7],
  [1.1, 1.0, 1.0, 1.0],
  [0.95, 0.9, 1.05, 1.0],
  [1.3, 1.4, 1.6, 1.2],
  [1.0, 1.0, 0.9, 1.6],
  [1.4, 1.2, 1.7, 1.3]
];

function generatePrice(drugIndex: number, location: number): number {
  const range = PRICE_RANGES[drugIndex as keyof typeof PRICE_RANGES];
  const mid = (range.min + range.max) / 2;
  const halfRange = (range.max - range.min) / 2;
  const offset = Math.random() * (halfRange * 2) - halfRange;
  let price = mid + offset;
  price = price * CITY_MULTIPLIERS[location][drugIndex];
  price = Math.max(range.min, Math.min(range.max, price));
  return Math.round(price);
}

function generateRandomEvent(day: number): { description: string; cashChange: number } {
  const roll = Math.random();
  
  if (day < 10) {
    if (roll > 0.8) {
      const gain = Math.floor(Math.random() * 1000);
      return { description: 'Lucky break! Found some cash.', cashChange: gain };
    }
  } else if (day > 20) {
    if (roll > 0.8) {
      const gain = Math.floor(Math.random() * 1500);
      return { description: 'Big haul!', cashChange: gain };
    } else if (roll > 0.5) {
      const loss = Math.floor(Math.random() * 3000);
      return { description: 'Major setback! Robbed hard.', cashChange: -loss };
    }
  } else {
    if (roll > 0.8) {
      const gain = Math.floor(Math.random() * 1000);
      return { description: 'Found a stash.', cashChange: gain };
    } else if (roll > 0.5) {
      const loss = Math.floor(Math.random() * 1000);
      return { description: 'Crooked cops took your cash.', cashChange: -loss };
    }
  }
  
  return { description: 'Normal day. No notable events.', cashChange: 0 };
}

async function getCurrentPrices(runId: string, day: number, location: number) {
  const { data } = await supabase
    .from('daily_prices')
    .select('*')
    .eq('run_id', runId)
    .eq('day', day)
    .eq('location', location)
    .single();

  if (data) {
    return {
      weed: data.weed_price,
      acid: data.acid_price,
      cocaine: data.cocaine_price,
      heroin: data.heroin_price
    };
  }

  // Generate new prices if they don't exist
  const prices = {
    weed: generatePrice(0, location),
    acid: generatePrice(1, location),
    cocaine: generatePrice(2, location),
    heroin: generatePrice(3, location)
  };

  await supabase.from('daily_prices').insert({
    run_id: runId,
    day,
    location,
    weed_price: prices.weed,
    acid_price: prices.acid,
    cocaine_price: prices.cocaine,
    heroin_price: prices.heroin
  });

  return prices;
}

export async function POST(request: NextRequest) {
  try {
    const { runId, action, params } = await request.json();

    if (!runId || !action) {
      return NextResponse.json(
        { error: 'Run ID and action required' },
        { status: 400 }
      );
    }

    // Get current game state
    const { data: gameRun, error: fetchError } = await supabase
      .from('game_runs')
      .select('*')
      .eq('id', runId)
      .single();

    if (fetchError || !gameRun) {
      return NextResponse.json(
        { error: 'Game run not found' },
        { status: 404 }
      );
    }

    if (gameRun.status !== 'active') {
      return NextResponse.json(
        { error: 'Game is not active' },
        { status: 400 }
      );
    }

    let updatedRun = { ...gameRun };
    const prices = await getCurrentPrices(runId, gameRun.days_played, gameRun.location);

    // Execute action
    switch (action) {
      case 'buy': {
        const { drugIndex, amount } = params;
        const drugColumns = ['weed', 'acid', 'cocaine', 'heroin'];
        const priceKeys = ['weed', 'acid', 'cocaine', 'heroin'];
        
        const cost = prices[priceKeys[drugIndex] as keyof typeof prices] * amount;
        
        if (updatedRun.cash < cost) {
          return NextResponse.json(
            { error: 'Not enough cash' },
            { status: 400 }
          );
        }

        updatedRun.cash -= cost;
        updatedRun[drugColumns[drugIndex] as keyof typeof updatedRun] = 
          (updatedRun[drugColumns[drugIndex] as keyof typeof updatedRun] as number) + amount;
        break;
      }

      case 'sell': {
        const { drugIndex, amount } = params;
        const drugColumns = ['weed', 'acid', 'cocaine', 'heroin'];
        const priceKeys = ['weed', 'acid', 'cocaine', 'heroin'];
        
        const currentAmount = updatedRun[drugColumns[drugIndex] as keyof typeof updatedRun] as number;
        
        if (currentAmount < amount) {
          return NextResponse.json(
            { error: 'Not enough inventory' },
            { status: 400 }
          );
        }

        const revenue = prices[priceKeys[drugIndex] as keyof typeof prices] * amount;
        updatedRun.cash += revenue;
        updatedRun[drugColumns[drugIndex] as keyof typeof updatedRun] = currentAmount - amount;
        break;
      }

      case 'travel': {
        const { location } = params;
        
        if (updatedRun.cash < 100) {
          return NextResponse.json(
            { error: 'Not enough cash for travel (need $100)' },
            { status: 400 }
          );
        }

        updatedRun.cash -= 100;
        updatedRun.location = location;
        break;
      }

      case 'endDay': {
        updatedRun.days_played += 1;
        
        // Generate random event
        const event = generateRandomEvent(updatedRun.days_played);
        updatedRun.cash = Math.max(0, updatedRun.cash + event.cashChange);
        updatedRun.last_event_description = event.description;

        // Log event
        await supabase.from('game_events').insert({
          run_id: runId,
          day: updatedRun.days_played,
          event_type: event.cashChange > 0 ? 'gain' : event.cashChange < 0 ? 'loss' : 'neutral',
          description: event.description,
          cash_change: event.cashChange
        });

        // Check win/loss conditions
        const netWorth = updatedRun.cash + 
          (updatedRun.weed * prices.weed) +
          (updatedRun.acid * prices.acid) +
          (updatedRun.cocaine * prices.cocaine) +
          (updatedRun.heroin * prices.heroin);

        if (netWorth >= 100000) {
          updatedRun.status = 'won';
          updatedRun.final_net_worth = netWorth;
        } else if (updatedRun.days_played >= 30) {
          updatedRun.status = 'lost';
          updatedRun.final_net_worth = netWorth;
        }
        break;
      }

      case 'hustle': {
        if (updatedRun.cash !== 0) {
          return NextResponse.json(
            { error: 'Cash must be 0 to hustle' },
            { status: 400 }
          );
        }

        if (updatedRun.hustles_used >= 2) {
          return NextResponse.json(
            { error: 'No hustles left' },
            { status: 400 }
          );
        }

        updatedRun.hustles_used += 1;
        const success = Math.random() > 0.5;
        
        if (success) {
          const gain = 100 + Math.floor(Math.random() * 200);
          updatedRun.cash += gain;
          updatedRun.last_event_description = 'Street hustle paid off.';
        } else {
          updatedRun.last_event_description = 'You tried hustling, but gained nothing.';
        }
        break;
      }

      case 'stash': {
        if (updatedRun.cash !== 0) {
          return NextResponse.json(
            { error: 'Cash must be 0 to use stash' },
            { status: 400 }
          );
        }

        if (updatedRun.stashes_used >= 1) {
          return NextResponse.json(
            { error: 'No stash left' },
            { status: 400 }
          );
        }

        updatedRun.stashes_used += 1;
        const gain = 400 + Math.floor(Math.random() * 600);
        updatedRun.cash += gain;
        updatedRun.last_event_description = 'You found a stash!';
        break;
      }

      default:
        return NextResponse.json(
          { error: 'Unknown action' },
          { status: 400 }
        );
    }

    // Save updated game state
    const { data: saved, error: saveError } = await supabase
      .from('game_runs')
      .update(updatedRun)
      .eq('id', runId)
      .select()
      .single();

    if (saveError) throw saveError;

    // Get updated prices for new location/day
    const newPrices = await getCurrentPrices(
      runId,
      saved.days_played,
      saved.location
    );

    return NextResponse.json({
      success: true,
      gameRun: {
        ...saved,
        prices: newPrices
      }
    });

  } catch (error: any) {
    console.error('Action error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to execute action' },
      { status: 500 }
    );
  }
}